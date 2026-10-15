import type { Config, MindClient } from "../types.ts";
import { routeFor } from "./routes.ts";
import type { Route } from "./routes.ts";

export interface MindClientOpts {
  timeoutMs?: number;        // default 60_000
  contextTimeoutMs?: number; // default 120_000 (mind_context synthesis is slow)
  retryDelayMs?: number;     // default 400
}

const DEFAULT_CONTEXT_SECTIONS = ["soul", "user", "rules", "priorities", "recent"];

class MindHttpError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

function isRetryable(e: unknown): boolean {
  if (e instanceof MindHttpError) return e.status === 502 || e.status === 503 || e.status === 0;
  return false;
}

export function createMindClient(cfg: Config, fetchImpl?: typeof fetch, opts: MindClientOpts = {}): MindClient {
  const doFetch: typeof fetch = fetchImpl ?? ((...a) => fetch(...a));
  const key = cfg.mindApiKey;
  const base = (cfg.mindBaseUrl || "https://m-i-n-d.ai/developer/v1").replace(/\/+$/, "");
  const origin = (() => { try { return new URL(base).origin; } catch { return base; } })();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const contextTimeoutMs = opts.contextTimeoutMs ?? 120_000;
  const retryDelayMs = opts.retryDelayMs ?? 400;

  // Never let the key leak through an error string (server echo, proxy message, URL).
  function scrub(s: string): string {
    let out = s;
    if (key) out = out.split(key).join("[key]");
    return out.replace(/mind_[A-Za-z0-9]{12,}/g, "[key]");
  }

  function urlFor(route: Route): string {
    const root = route.path.startsWith("/admin") ? origin : base;
    const qs = route.query && Object.keys(route.query).length ? "?" + new URLSearchParams(route.query).toString() : "";
    return root + route.path + qs;
  }

  async function once(label: string, route: Route, ms: number): Promise<string> {
    if (!key) throw new MindHttpError(`MIND ${label}: no API key configured (set MIND_API_KEY)`, 401);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const init: RequestInit = {
        method: route.method,
        headers: { "X-API-Key": key, "Content-Type": "application/json", Accept: "application/json" },
        signal: ctrl.signal,
      };
      if (route.method !== "GET" && route.method !== "DELETE") init.body = JSON.stringify(route.body ?? {});
      let res: Response;
      try {
        res = await doFetch(urlFor(route), init);
      } catch (e) {
        const aborted = ctrl.signal.aborted || (e as Error)?.name === "AbortError";
        throw new MindHttpError(aborted ? `MIND ${label}: timed out after ${Math.round(ms / 1000)}s` : `MIND ${label}: network error (${scrub(String((e as Error)?.message ?? e)).slice(0, 80)})`, 0);
      }
      const text = await res.text();
      if (!res.ok) {
        let detail = "";
        try {
          const j = JSON.parse(text);
          const d = j?.detail ?? j?.error ?? j?.message;
          detail = typeof d === "string" ? d : d !== undefined ? JSON.stringify(d) : "";
        } catch { detail = text; }
        detail = scrub(detail).replace(/\s+/g, " ").slice(0, 160);
        throw new MindHttpError(`MIND ${label}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`, res.status);
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(label: string, route: Route): Promise<string> {
    const ms = route.timeoutMs ?? timeoutMs;
    try {
      return await once(label, route, ms);
    } catch (e) {
      if (!isRetryable(e)) throw new Error(scrub((e as Error).message));
      if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
      try {
        return await once(label, route, ms);
      } catch (e2) {
        throw new Error(scrub((e2 as Error).message));
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
    async context(sections, forTask) {
      const args: Record<string, unknown> = { sections: sections && sections.length ? sections : DEFAULT_CONTEXT_SECTIONS };
      if (forTask) args.for_task = forTask;
      const route = routeFor("context", args);
      route.timeoutMs = contextTimeoutMs;
      return formatContext(parse(await request("context", route)));
    },
    async query(query, o) {
      const mt = Math.max(1000, o?.maxContextTokens ?? 4000); // API rejects < 1000
      const route = routeFor("query", { query, mode: o?.mode ?? "hybrid", retrieve_only: true, max_context_tokens: mt });
      return textOf("query", parse(await request("query", route)));
    },
    async remember(a) {
      const type = a.type ?? "entry";
      const route = routeFor("remember", { type, title: a.title, content: a.content, tags: a.tags, source: a.source ?? "mindclaw" });
      const data = parse(await request(`remember ${type}`, route)) as any;
      const id = data?.id ?? data?.entry_id ?? data?.document_id ?? data?.doc_id;
      return id ? `saved ${type} ${id}` : `saved ${type}: ${JSON.stringify(data).slice(0, 300)}`;
    },
    async call(tool, args) {
      const name = tool.replace(/^mind_/, "");
      if (name === "context") return client.context(args.sections as string[] | undefined, args.for_task as string | undefined);
      const route = routeFor(name, args);
      return textOf(name, parse(await request(name + (args.action ? ` ${String(args.action)}` : ""), route)));
    },
  };
  return client;
}
