// MIND owns the MCP connections. This is Daebot's client for MIND's /developer/v1/mcp/* routes (the contract: config, servers, create,
// patch, delete, refresh, tools, tools/call, integrations/link). Every call is made with the SIGNED-IN USER'S OWN MIND key, so the same
// user sees the same connections from the web, the desktop app and the phone. Daebot never sees a third-party credential here: it hands a
// pasted key to MIND once (create) and MIND seals it; tool runs go through MIND, which adds the credential itself.
//
// The key is never logged and never put in an error: messages are the contract's plain words (or ours), scrubbed of the key. Reads may retry once on a
// network blip; create and tools/call never retry (a retried create can double a connection, a retried call can run a tool twice).
// The reply is parsed tolerantly: unknown fields are ignored, missing optional fields are absent.
import { createHash } from "node:crypto";
import { McpConnectError } from "./errors.ts";
import type { Publisher } from "./store.ts";

export type MindAuth = "none" | "key" | "oauth" | "integration";
export type MindStatus = "ok" | "error" | "reauth_required";

export interface MindTool { name: string; description: string; readOnly: boolean; destructive: boolean; allowed: boolean }
export interface MindToolFull extends MindTool { schema: Record<string, unknown> }
/** A connection as MIND holds it. No credential, no tool schemas. */
export interface MindServer {
  id: string; name: string; url: string; host: string; publisher: Publisher; auth: MindAuth; integration: string | null; enabled: boolean;
  addedAt: number; updatedAt: number; preset: string | null; truncated: boolean; status: MindStatus; lastError: string | null;
  allow: string[]; toolCount: number; tools: MindTool[];
}
export interface MindToolSet { tools: MindToolFull[]; truncated: boolean; updatedAt: number }

export type MindConfig =
  | { kind: "on"; maxServers?: number; maxTools?: number; linkable: string[] }
  | { kind: "off"; reason: "absent" | "disabled" }
  | { kind: "failed"; reason: string };

export interface MindCreateBody {
  mode: "none" | "key" | "oauth"; url: string; token?: string; name?: string; allow?: string[]; preset?: string; source?: "catalog" | "user"; return_to?: string;
}
export type MindCreateResult = { status: "connected"; server: MindServer } | { status: "authorize"; url: string };
export interface MindCallResult { ok: boolean; isError: boolean; text: string; truncated: boolean; errorCode: string | null; message: string }
export interface MindLinkResult { provider: string; status: "linked" | "already" | "rejected" | "unavailable"; serverId: string | null; reason: string }

export interface MindMcpOptions {
  /** MIND's developer API base, e.g. https://m-i-n-d.ai/developer/v1 */
  baseUrl: string;
  /** The signed-in user's own MIND key for this Daebot user id (undefined = not signed in to MIND). */
  keyFor(uid: string): string | undefined;
  fetchImpl?: typeof fetch;
  /** Reads (list, config, tools). Default 8s. */
  timeoutMs?: number;
  /** Create (MIND probes the third-party server). Default 45s. */
  createTimeoutMs?: number;
  /** A tool run. Default 70s. */
  callTimeoutMs?: number;
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PUBLISHERS = new Set<string>(["official", "community", "self", "unknown"]);
const AUTHS = new Set<string>(["none", "key", "oauth", "integration"]);
const STATUSES = new Set<string>(["ok", "error", "reauth_required"]);

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const strList = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64).slice(0, max) : []);

function slug(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31);
}

function parseTool(t: any): MindTool | undefined {
  if (!t || typeof t.name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(t.name)) return undefined;
  return { name: t.name, description: str(t.description, 600), readOnly: t.read_only === true, destructive: t.destructive === true, allowed: t.allowed === true };
}

/** One connection from MIND's reply, or undefined when it is not usable (no id, no URL). Unknown values fall back to the cautious reading. */
export function parseMindServer(raw: any): MindServer | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const id = str(raw.id, 60);
  const name = slug(str(raw.name, 80));
  const url = str(raw.url, 600);
  if (!ID_RE.test(id) || !name || !url) return undefined;
  let host = str(raw.host, 253);
  if (!host) { try { host = new URL(url).host; } catch { return undefined; } }
  const tools = (Array.isArray(raw.tools) ? (raw.tools as unknown[]) : []).slice(0, 2000).map(parseTool).filter((t): t is MindTool => !!t);
  const added = num(raw.added_at);
  return {
    id, name, url, host,
    publisher: PUBLISHERS.has(raw.publisher) ? (raw.publisher as Publisher) : "unknown", // a publisher MIND did not name is not trusted
    auth: AUTHS.has(raw.auth) ? (raw.auth as MindAuth) : "key",
    integration: typeof raw.integration === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(raw.integration) ? raw.integration : null,
    enabled: raw.enabled !== false,
    addedAt: added, updatedAt: num(raw.updated_at, added),
    preset: typeof raw.preset === "string" && raw.preset ? raw.preset.slice(0, 40) : null,
    truncated: raw.truncated === true,
    status: STATUSES.has(raw.status) ? (raw.status as MindStatus) : "ok",
    lastError: typeof raw.last_error === "string" && raw.last_error ? raw.last_error.slice(0, 300) : null,
    allow: strList(raw.allow, 2000),
    toolCount: Math.max(tools.length, Math.floor(num(raw.tool_count))),
    tools,
  };
}

export class MindMcpBackend {
  private o: MindMcpOptions;
  private f: typeof fetch;
  constructor(o: MindMcpOptions) { this.o = o; this.f = o.fetchImpl ?? ((...a) => fetch(...a)); }

  /** True when this user has a MIND key to act with. */
  hasKey(uid: string): boolean { return !!this.o.keyFor(uid); }
  /** A short stable label of the user's current key, so a state cached under one MIND sign-in is dropped when the key changes. Never reversible to the key. */
  fingerprint(uid: string): string {
    const k = this.o.keyFor(uid);
    return k ? createHash("sha256").update(`daebot-mcp:${k}`).digest("hex").slice(0, 16) : "";
  }

  private base(): string { return this.o.baseUrl.replace(/\/+$/, ""); }

  private scrub(uid: string, s: string): string {
    const k = this.o.keyFor(uid);
    let out = s;
    if (k) out = out.split(k).join("[key]");
    return out.replace(/mind_[A-Za-z0-9]{12,}/g, "[key]");
  }

  /** One request. Returns the status and parsed body for ANY HTTP answer; throws McpConnectError only when MIND could not be reached at all. */
  private async raw(uid: string, method: string, path: string, o: { body?: unknown; timeoutMs: number; signal?: AbortSignal; retry?: boolean }): Promise<{ status: number; json: any }> {
    const key = this.o.keyFor(uid);
    if (!key) throw new McpConnectError("Sign in with MIND to use connected servers.", 401, "no_key");
    const attempt = async (): Promise<{ status: number; json: any }> => {
      const timeout = AbortSignal.timeout(o.timeoutMs);
      const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.f(`${this.base()}${path}`, {
          method,
          headers: { "X-API-Key": key, Accept: "application/json", ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}) },
          ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
          signal,
        });
      } catch (e) {
        if (o.signal?.aborted) throw new McpConnectError("Stopped.", 499, "aborted");
        const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
        throw new McpConnectError(timedOut ? "MIND took too long to answer." : "Could not reach MIND right now.", 502, timedOut ? "mind_timeout" : "mind_unreachable");
      }
      const text = await res.text().catch(() => "");
      let json: any;
      try { json = text ? JSON.parse(text) : {}; } catch { json = undefined; }
      return { status: res.status, json };
    };
    try {
      const r = await attempt();
      if (o.retry && (r.status === 502 || r.status === 503)) { await new Promise((ok) => setTimeout(ok, 300)); return await attempt(); }
      return r;
    } catch (e) {
      if (o.retry && e instanceof McpConnectError && (e.code === "mind_unreachable") && !o.signal?.aborted) { await new Promise((ok) => setTimeout(ok, 300)); return attempt(); }
      throw e;
    }
  }

  /** The McpConnectError for a non-2xx answer: the contract's own plain `message` when it sent one. */
  private fail(uid: string, status: number, j: any): McpConnectError {
    const d = j?.detail;
    if (d && typeof d === "object" && typeof d.message === "string" && d.message.trim()) {
      return new McpConnectError(this.scrub(uid, d.message).replace(/\s+/g, " ").trim().slice(0, 400), status, typeof d.code === "string" ? d.code.slice(0, 40) : undefined);
    }
    // A key signed in with a hand-picked scope list can read connections but not change or run them: say exactly that and how to fix it
    // (signing in with MIND, or a key with all permissions). Keys minted by Daebot's own "Sign in with MIND" (web, desktop, iPhone) carry every scope.
    if (status === 403 && typeof d === "string" && /lacks required scope/i.test(d)) {
      return new McpConnectError("Daebot needs you to sign in with MIND again before it can use your connected apps. Select Re-sign in to let Daebot use your apps in the Apps window. Do not create or paste a key.", 502, "mind_scope");
    }
    if (status === 401 || status === 403) return new McpConnectError("MIND did not accept your sign-in for connected servers. Sign in with MIND again.", 502, "mind_auth");
    if (status === 404) return new McpConnectError("MIND does not have connected servers switched on for this account yet.", 404, "absent");
    if (status === 429) return new McpConnectError("MIND says too many requests. Try again shortly.", 429, "rate_limited");
    if (status >= 500) return new McpConnectError(`MIND had a problem (HTTP ${status}). Try again in a moment.`, 502, "mind_error");
    return new McpConnectError(`MIND refused that request (HTTP ${status}).`, 400, "refused");
  }

  private async ok(uid: string, r: { status: number; json: any }): Promise<any> {
    if (r.status >= 200 && r.status < 300) return r.json ?? {};
    throw this.fail(uid, r.status, r.json);
  }

  // ---- routes

  /** GET /mcp/config. Never throws: the caller picks the mode from the answer. 404 = MIND predates the feature; enabled:false = the flag is off. */
  async config(uid: string): Promise<MindConfig> {
    try {
      const r = await this.raw(uid, "GET", "/mcp/config", { timeoutMs: this.o.timeoutMs ?? 8000, retry: true });
      if (r.status === 404) return { kind: "off", reason: r.json?.detail?.code === "disabled" ? "disabled" : "absent" };
      if (r.status < 200 || r.status >= 300) return { kind: "failed", reason: this.fail(uid, r.status, r.json).message };
      const j = r.json ?? {};
      if (j.enabled !== true) return { kind: "off", reason: "disabled" };
      const lim = j.limits && typeof j.limits === "object" ? j.limits : {};
      const pos = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
      return { kind: "on", maxServers: pos(lim.max_servers), maxTools: pos(lim.max_tools), linkable: strList(j.linkable_integrations, 40).filter((p) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(p)) };
    } catch (e) {
      return { kind: "failed", reason: e instanceof McpConnectError ? e.message : "Could not reach MIND right now." };
    }
  }

  async list(uid: string, signal?: AbortSignal): Promise<MindServer[]> {
    const j = await this.ok(uid, await this.raw(uid, "GET", "/mcp/servers", { timeoutMs: this.o.timeoutMs ?? 8000, retry: true, signal }));
    return (Array.isArray(j.servers) ? j.servers : []).map(parseMindServer).filter((s: MindServer | undefined): s is MindServer => !!s);
  }

  /** POST /mcp/servers: the user's click is the consent. MIND probes (with the token, for mode key) and stores nothing unless the server accepts it. Never retried. */
  async create(uid: string, body: MindCreateBody, signal?: AbortSignal): Promise<MindCreateResult> {
    const j = await this.ok(uid, await this.raw(uid, "POST", "/mcp/servers", { body, timeoutMs: this.o.createTimeoutMs ?? 45_000, signal }));
    if (j.status === "authorize" && typeof j.url === "string") return { status: "authorize", url: j.url };
    const server = parseMindServer(j.server);
    if (j.status === "connected" && server) return { status: "connected", server };
    throw new McpConnectError("MIND answered in a way Daebot could not read. Check the Apps list before trying again.", 502, "mind_unreadable");
  }

  async patch(uid: string, id: string, body: { enabled?: boolean; allow?: string[]; name?: string }): Promise<MindServer> {
    const j = await this.ok(uid, await this.raw(uid, "PATCH", `/mcp/servers/${encodeURIComponent(id)}`, { body, timeoutMs: this.o.timeoutMs ?? 8000 }));
    const s = parseMindServer(j.server ?? j);
    if (!s) throw new McpConnectError("MIND answered in a way Daebot could not read.", 502, "mind_unreadable");
    return s;
  }

  async remove(uid: string, id: string): Promise<boolean> {
    const r = await this.raw(uid, "DELETE", `/mcp/servers/${encodeURIComponent(id)}`, { timeoutMs: this.o.timeoutMs ?? 8000 });
    if (r.status === 404) return false;
    await this.ok(uid, r);
    return true;
  }

  /** POST .../refresh: MIND re-lists the tools through the proxy (also refreshes an expiring OAuth token). Slow because it reaches the third party. */
  async refresh(uid: string, id: string): Promise<MindServer> {
    const j = await this.ok(uid, await this.raw(uid, "POST", `/mcp/servers/${encodeURIComponent(id)}/refresh`, { body: {}, timeoutMs: this.o.createTimeoutMs ?? 45_000 }));
    const s = parseMindServer(j.server ?? j);
    if (!s) throw new McpConnectError("MIND answered in a way Daebot could not read.", 502, "mind_unreadable");
    return s;
  }

  /** GET .../tools: MIND's stored list with the (already cleaned) schemas. No network behind it. */
  async tools(uid: string, id: string, signal?: AbortSignal): Promise<MindToolSet> {
    const j = await this.ok(uid, await this.raw(uid, "GET", `/mcp/servers/${encodeURIComponent(id)}/tools`, { timeoutMs: this.o.timeoutMs ?? 8000, retry: true, signal }));
    const tools: MindToolFull[] = [];
    for (const t of Array.isArray(j.tools) ? j.tools.slice(0, 2000) : []) {
      const p = parseTool(t);
      if (p) tools.push({ ...p, schema: t.schema && typeof t.schema === "object" && !Array.isArray(t.schema) ? t.schema : {} });
    }
    return { tools, truncated: j.truncated === true, updatedAt: num(j.updated_at) };
  }

  /** POST .../tools/call. Always 200 for a run: `ok:false` = it did not run or the transport failed, `is_error:true` = it ran and said so. Never retried. */
  async callTool(uid: string, id: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MindCallResult> {
    const j = await this.ok(uid, await this.raw(uid, "POST", `/mcp/servers/${encodeURIComponent(id)}/tools/call`, { body: { name, arguments: args }, timeoutMs: this.o.callTimeoutMs ?? 70_000, signal }));
    return {
      ok: j.ok === true, isError: j.is_error === true, text: str(j.text, 100_000), truncated: j.truncated === true,
      errorCode: typeof j.error_code === "string" ? j.error_code.slice(0, 30) : null, message: str(j.message, 400),
    };
  }

  /** POST /mcp/integrations/link: MIND tries each connected integration's vendor MCP server with that integration's own token. Idempotent. */
  async linkIntegrations(uid: string, providers?: string[], force = false): Promise<MindLinkResult[]> {
    const j = await this.ok(uid, await this.raw(uid, "POST", "/mcp/integrations/link", { body: { ...(providers && providers.length ? { providers } : {}), ...(force ? { force: true } : {}) }, timeoutMs: this.o.createTimeoutMs ?? 45_000 }));
    const out: MindLinkResult[] = [];
    for (const r of Array.isArray(j.results) ? j.results.slice(0, 60) : []) {
      if (!r || typeof r.provider !== "string") continue;
      const status = r.status === "linked" || r.status === "already" || r.status === "rejected" || r.status === "unavailable" ? r.status : "unavailable";
      out.push({ provider: r.provider.slice(0, 40), status, serverId: typeof r.server_id === "string" && ID_RE.test(r.server_id) ? r.server_id : null, reason: str(r.reason, 300) });
    }
    return out;
  }
}
