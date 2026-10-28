import type { Config, MindClient } from "../types.ts";
import { routeFor } from "./routes.ts";
import type { Route } from "./routes.ts";

export interface MindClientOpts {
  timeoutMs?: number;        // default 60_000
  contextTimeoutMs?: number; // default 120_000 (mind_context synthesis is slow)
  retryDelayMs?: number;     // default 400
  /** Hosted per-user clients: current key (so a refreshed OAuth key is picked up without rebuilding the client). */
  getKey?: () => string;
  /** Called once on HTTP 401; return true after rotating the key to retry the call with the new one. */
  onUnauthorized?: () => Promise<boolean>;
  /** Address a bot's MIND instead of the main one: sends X-MIND-Bot: <slug> with the same (MAIN) key. */
  bot?: string;
}

/** MIND's public sites proxy /developer/* to the API service but serve the web app for everything else, so the routes outside /developer/v1 are called on the API service itself. */
export const MIND_API_ORIGIN = "https://mindapp.onrender.com";
const MIND_PUBLIC_HOSTS = new Set(["m-i-n-d.ai", "www.m-i-n-d.ai"]);

/** Where routes that live outside /developer/v1 are served: MIND_BACKEND_URL when set; the API service when the base is MIND's public site; otherwise the base's own origin (self-hosted MIND, tests). */
export function backendOrigin(cfg: Pick<Config, "mindBaseUrl" | "mindBackendUrl">): string {
  const pick = (u: string): string | undefined => { try { return new URL(u).origin; } catch { return undefined; } };
  if (cfg.mindBackendUrl) { const o = pick(cfg.mindBackendUrl); if (o) return o; }
  try {
    const u = new URL(cfg.mindBaseUrl || "https://m-i-n-d.ai/developer/v1");
    return MIND_PUBLIC_HOSTS.has(u.hostname.toLowerCase()) ? MIND_API_ORIGIN : u.origin;
  } catch { return MIND_API_ORIGIN; }
}

const DEFAULT_CONTEXT_SECTIONS = ["soul", "user", "rules", "priorities", "recent"];

class MindHttpError extends Error {
  status: number;
  payload?: unknown;
  constructor(message: string, status: number, payload?: unknown) { super(message); this.status = status; this.payload = payload; }
}

/** The error a caller sees: scrubbed message plus the HTTP status and the (parsed) error body, so callers can branch on 402/409/400 codes. */
function surfaced(message: string, e: unknown): Error {
  const out = new Error(message) as Error & { status?: number; payload?: unknown };
  if (e instanceof MindHttpError) { out.status = e.status; out.payload = e.payload; }
  return out;
}

function isRetryable(e: unknown): boolean {
  if (e instanceof MindHttpError) return e.status === 502 || e.status === 503 || e.status === 0;
  return false;
}

export function createMindClient(cfg: Config, fetchImpl?: typeof fetch, opts: MindClientOpts = {}): MindClient {
  const doFetch: typeof fetch = fetchImpl ?? ((...a) => fetch(...a));
  const curKey = (): string => opts.getKey?.() ?? cfg.mindApiKey;
  const base = (cfg.mindBaseUrl || "https://m-i-n-d.ai/developer/v1").replace(/\/+$/, "");
  const origin = (() => { try { return new URL(base).origin; } catch { return base; } })();
  const backend = backendOrigin(cfg);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const contextTimeoutMs = opts.contextTimeoutMs ?? 120_000;
  const retryDelayMs = opts.retryDelayMs ?? 400;

  // Never let the key leak through an error string (server echo, proxy message, URL).
  function scrub(s: string): string {
    let out = s;
    const key = curKey();
    if (key) out = out.split(key).join("[key]");
    return out.replace(/mind_[A-Za-z0-9]{12,}/g, "[key]");
  }

  function urlFor(route: Route): string {
    const root = route.root === "backend" ? backend : route.path.startsWith("/admin") ? origin : base;
    const qs = route.query && Object.keys(route.query).length ? "?" + new URLSearchParams(route.query).toString() : "";
    return root + route.path + qs;
  }

  async function once(label: string, route: Route, ms: number, signal?: AbortSignal): Promise<string> {
    const key = curKey();
    if (!key) throw new MindHttpError(`MIND ${label}: no API key configured (set MIND_API_KEY)`, 401);
    if (signal?.aborted) throw new MindHttpError(`MIND ${label}: aborted`, -1);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    // A caller's signal (turn abort, bot_talk timeout) aborts the HTTP request itself.
    const onCaller = () => ctrl.abort();
    if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener("abort", onCaller, { once: true }); }
    try {
      const init: RequestInit = {
        method: route.method,
        headers: { "X-API-Key": key, "Content-Type": "application/json", Accept: "application/json", ...(opts.bot ? { "X-MIND-Bot": opts.bot } : {}) },
        signal: ctrl.signal,
      };
      if (route.method !== "GET" && route.method !== "DELETE") init.body = JSON.stringify(route.body ?? {});
      let res: Response;
      try {
        res = await doFetch(urlFor(route), init);
      } catch (e) {
        const aborted = ctrl.signal.aborted || (e as Error)?.name === "AbortError";
        if (signal?.aborted) throw new MindHttpError(`MIND ${label}: aborted`, -1);
        throw new MindHttpError(aborted ? `MIND ${label}: timed out after ${Math.round(ms / 1000)}s` : `MIND ${label}: network error (${scrub(String((e as Error)?.message ?? e)).slice(0, 80)})`, 0);
      }
      const text = await res.text();
      if (!res.ok) {
        let detail = "";
        let payload: unknown;
        try {
          const j = JSON.parse(text);
          payload = j;
          const d = j?.detail ?? j?.error ?? j?.message;
          detail = typeof d === "string" ? d : d !== undefined ? JSON.stringify(d) : "";
        } catch { detail = text; }
        detail = scrub(detail).replace(/\s+/g, " ").slice(0, 160);
        throw new MindHttpError(`MIND ${label}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`, res.status, payload);
      }
      return text;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCaller);
    }
  }

  async function request(label: string, route: Route, signal?: AbortSignal): Promise<string> {
    const ms = route.timeoutMs ?? timeoutMs;
    try {
      return await once(label, route, ms, signal);
    } catch (e) {
      if (e instanceof MindHttpError && e.status === 401 && opts.onUnauthorized) {
        let rotated = false;
        try { rotated = await opts.onUnauthorized(); } catch { rotated = false; }
        if (rotated) {
          try { return await once(label, route, ms, signal); } catch (e2) { throw surfaced(scrub((e2 as Error).message), e2); }
        }
      }
      if (signal?.aborted || route.noRetry || !isRetryable(e)) throw surfaced(scrub((e as Error).message), e);
      if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
      try {
        return await once(label, route, ms, signal);
      } catch (e2) {
        throw surfaced(scrub((e2 as Error).message), e2);
      }
    }
  }

  function parse(text: string): unknown {
    if (!text) return {};
    try { return JSON.parse(text); } catch { return text; }
  }

  function formatContext(data: any): string {
    const secs: any[] = Array.isArray(data?.sections) ? data.sections : [];
    if (!secs.length) throw new Error("MIND context: empty response");
    let got = 0;
    const parts = secs.map((s) => {
      const name = String(s?.section ?? "section").toUpperCase();
      if (s?.error || (s?.status && s.status !== "ok")) return `## ${name}\n[unavailable: ${String(s?.error ?? s?.status).slice(0, 120)}]`;
      const items: any[] = Array.isArray(s?.items) ? s.items : [];
      const lines = items.map((it) => (typeof it === "string" ? it : String(it?.text ?? ""))).filter(Boolean);
      if (lines.length) got++;
      return `## ${name}\n${lines.join("\n")}`;
    });
    if (!got) throw new Error("MIND context: no section returned content");
    return parts.join("\n\n");
  }

  function textOf(tool: string, data: unknown): string {
    if (typeof data === "string") return data;
    const d = data as any;
    if (tool === "context" || tool === "mind_context") return formatContext(d);
    if (d && typeof d.response === "string") return d.response;
    if (d && typeof d.answer === "string") return d.answer;
    return JSON.stringify(data);
  }

  const client: MindClient = {
    async context(sections, forTask, signal) {
      const args: Record<string, unknown> = { sections: sections && sections.length ? sections : DEFAULT_CONTEXT_SECTIONS };
      if (forTask) args.for_task = forTask;
      const route = routeFor("context", args);
      route.timeoutMs = contextTimeoutMs;
      return formatContext(parse(await request("context", route, signal)));
    },
    async query(query, o) {
      const mt = Math.max(1000, o?.maxContextTokens ?? 4000); // API rejects < 1000
      const route = routeFor("query", { query, mode: o?.mode ?? "hybrid", retrieve_only: true, max_context_tokens: mt });
      return textOf("query", parse(await request("query", route, o?.signal)));
    },
    async remember(a, signal) {
      const type = a.type ?? "entry";
      const route = routeFor("remember", { type, title: a.title, content: a.content, tags: a.tags, source: a.source ?? "mindclaw" });
      const data = parse(await request(`remember ${type}`, route, signal)) as any;
      const id = data?.id ?? data?.entry_id ?? data?.document_id ?? data?.doc_id;
      return id ? `saved ${type} ${id}` : `saved ${type}: ${JSON.stringify(data).slice(0, 300)}`;
    },
    async call(tool, args, signal) {
      const name = tool.replace(/^mind_/, "");
      if (name === "context") return client.context(args.sections as string[] | undefined, args.for_task as string | undefined, signal);
      const route = routeFor(name, args);
      return textOf(name, parse(await request(name + (args.action ? ` ${String(args.action)}` : ""), route, signal)));
    },
  };
  return client;
}
