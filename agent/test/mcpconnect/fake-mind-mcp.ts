// An in-memory MIND that speaks the written MCP contract (config, servers, create, patch, delete, refresh, tools, tools/call, integrations/link).
// No sockets: `fetch` is handed to Daebot as its fetchImpl. Third-party MCP servers are `vendors` in memory; MIND "talks" to them directly in here, the
// way the real one does, and holds each sealed credential. NOTHING in a reply carries a credential. This is the contract, not MIND's code.
import { randomBytes } from "node:crypto";
import type { SafeFetch } from "../../src/mcpconnect/ssrf.ts";

export const BASE = "https://mind.test/developer/v1";

export interface FakeTool { name: string; description?: string; read_only?: boolean; destructive?: boolean; schema?: Record<string, unknown> }
export interface FakeVendor {
  url: string;
  tools: FakeTool[];
  /** The bearer this server accepts (undefined = open). */
  bearer?: string;
  /** Offers OAuth (MIND returns an authorize URL for mode oauth). */
  oauth?: boolean;
  /** Answers, but not like an MCP server. */
  notMcp?: boolean;
  official?: boolean;
  run?(name: string, args: Record<string, unknown>): { text: string; isError?: boolean };
  /** Everything the vendor saw from MIND (the credential MIND injected). */
  fromMind: { op: "probe" | "call"; auth?: string; name?: string }[];
  /** Everything the vendor saw from Daebot's own probe (must never carry a credential in MIND mode). */
  fromDaebot: { auth?: string; method?: string }[];
}

export interface FakeRec {
  id: string; name: string; url: string; host: string; publisher: string; auth: string; integration: string | null; enabled: boolean;
  added_at: number; updated_at: number; preset: string | null; truncated: boolean; status: string; last_error: string | null; allow: string[];
  tools: FakeTool[];
  /** The sealed credential: only in here, never in a reply. */
  sealed?: string;
}

export const canon = (raw: string): string => { try { const u = new URL(raw); return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`; } catch { return raw; } };

export function vendor(url: string, tools: FakeTool[], o: Partial<FakeVendor> = {}): FakeVendor {
  return { url, tools, fromMind: [], fromDaebot: [], ...o };
}

export interface FakeMindOptions {
  /** MIND key -> user */
  keys: Record<string, string>;
  maxServers?: number;
}

export function createFakeMind(opts: FakeMindOptions) {
  let clock = 1_793_200_000_000;
  const tick = () => ++clock;
  const servers = new Map<string, FakeRec[]>(); // user -> connections, oldest first
  const vendors = new Map<string, FakeVendor>();
  const integrationTokens = new Map<string, Record<string, string>>(); // user -> provider -> that integration's own token
  const requests: { method: string; path: string; user?: string; body?: any }[] = [];
  const state = {
    /** MIND flag MCP_CONNECTIONS_ENABLED */
    enabled: true,
    /** MIND predates the feature: /mcp/config is a plain 404 */
    absent: false,
    /** Network is down */
    down: false,
    /** A hook run inside create before MIND answers (to assert what Daebot's local store looks like at that moment). */
    onCreate: undefined as undefined | ((user: string, body: any) => void),
    /** Fail the next create with this answer. */
    failNextCreate: undefined as undefined | { status: number; code: string; message: string },
    linkCalls: 0,
    linkable: ["github"],
  };

  const list = (user: string): FakeRec[] => { let l = servers.get(user); if (!l) servers.set(user, (l = [])); return l; };
  const pub = (r: FakeRec, withTools = true) => {
    const { sealed: _s, tools, ...rest } = r;
    return { ...rest, tool_count: tools.length, tools: withTools ? tools.map((t) => ({ name: t.name, description: t.description ?? "", read_only: !!t.read_only, destructive: !!t.destructive, allowed: r.allow.includes(t.name) })) : [] };
  };
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const err = (status: number, code: string, message: string): Response => json(status, { detail: { code, message } });
  const uniqueName = (user: string, base: string): string => {
    const taken = new Set(list(user).map((s) => s.name));
    let n = base.replace(/[^a-z0-9-]/g, "-").slice(0, 31) || "server";
    if (!taken.has(n)) return n;
    for (let i = 2; ; i++) { n = `${base.slice(0, 27)}-${i}`; if (taken.has(n)) continue; return n; }
  };
  const defaultAllow = (tools: FakeTool[]) => tools.filter((t) => t.read_only && !t.destructive).map((t) => t.name);

  function addServer(user: string, v: FakeVendor, o: { name: string; auth: string; sealed?: string; preset?: string | null; integration?: string | null; allow?: string[]; publisher?: string }): FakeRec {
    const host = new URL(v.url).host;
    const rec: FakeRec = {
      id: "srv_" + randomBytes(6).toString("hex"), name: uniqueName(user, o.name), url: v.url, host,
      publisher: o.publisher ?? (o.preset ? "self" : v.official ? "official" : "unknown"), auth: o.auth, integration: o.integration ?? null, enabled: true,
      added_at: tick(), updated_at: tick(), preset: o.preset ?? null, truncated: false, status: "ok", last_error: null,
      allow: (o.allow ?? defaultAllow(v.tools)).filter((n) => v.tools.some((t) => t.name === n)), tools: v.tools.map((t) => ({ ...t })), sealed: o.sealed,
    };
    list(user).push(rec);
    return rec;
  }

  async function handle(input: string | URL, init: RequestInit = {}): Promise<Response> {
    if (state.down) throw new TypeError("fetch failed");
    const u = new URL(String(input));
    if (!u.href.startsWith(BASE)) return json(404, { detail: "Not Found" });
    const path = u.pathname.slice(new URL(BASE).pathname.length);
    const method = String(init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const user = opts.keys[headers["X-API-Key"] ?? ""];
    let body: any;
    try { body = init.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    requests.push({ method, path, user, body });
    if (!user) return json(401, { detail: "Invalid API key" });
    if (!path.startsWith("/mcp/")) return json(404, { detail: "Not Found" });

    if (path === "/mcp/config" && method === "GET") {
      if (state.absent) return json(404, { detail: "Not Found" });
      return json(200, { enabled: state.enabled, limits: { max_servers: opts.maxServers ?? 50, max_tools: 1000 }, linkable_integrations: state.linkable });
    }
    if (state.absent || !state.enabled) return err(404, "disabled", "Connecting MCP servers is not switched on for this account.");

    if (path === "/mcp/servers" && method === "GET") return json(200, { servers: list(user).map((r) => pub(r)) });

    if (path === "/mcp/servers" && method === "POST") {
      state.onCreate?.(user, body);
      if (state.failNextCreate) { const f = state.failNextCreate; state.failNextCreate = undefined; return err(f.status, f.code, f.message); }
      let url: URL;
      try { url = new URL(String(body?.url)); } catch { return err(422, "invalid", "That is not a valid address."); }
      if (url.protocol !== "https:") return err(422, "invalid", "Only https addresses can be connected.");
      if (list(user).some((s) => canon(s.url) === canon(url.href))) return err(409, "duplicate", "That server is already connected.");
      if (list(user).length >= (opts.maxServers ?? 50)) return err(409, "limit", "You are at the limit of connected servers.");
      const v = vendors.get(canon(url.href));
      if (!v) return err(502, "unreachable", "MIND could not reach that server.");
      if (v.notMcp) return err(422, "not_mcp", "That address did not answer like an MCP server.");
      const mode = body?.mode;
      const name = String(body?.name ?? "") || new URL(v.url).hostname.split(".")[0];
      const preset = typeof body?.preset === "string" ? body.preset : null;
      if (mode === "none") {
        v.fromMind.push({ op: "probe" });
        if (v.bearer) return err(422, "needs_auth", "That server wants a sign-in or a key.");
        return json(200, { status: "connected", server: pub(addServer(user, v, { name, auth: "none", preset, allow: Array.isArray(body.allow) ? body.allow : undefined })) });
      }
      if (mode === "key") {
        const token = String(body?.token ?? "");
        if (!token) return err(422, "invalid", "A key is needed.");
        v.fromMind.push({ op: "probe", auth: `Bearer ${token}` });
        if (v.bearer !== token) return err(422, "bad_token", "That server did not accept the token.");
        return json(200, { status: "connected", server: pub(addServer(user, v, { name, auth: "key", sealed: token, preset, allow: Array.isArray(body.allow) ? body.allow : undefined })) });
      }
      if (mode === "oauth") {
        if (!v.oauth) return err(422, "no_oauth", "That server does not offer a sign-in.");
        return json(200, { status: "authorize", url: `https://vendor.test/authorize?state=${randomBytes(4).toString("hex")}&return_to=${encodeURIComponent(String(body?.return_to ?? ""))}` });
      }
      return err(422, "invalid", "Unknown way to connect.");
    }

    if (path === "/mcp/integrations/link" && method === "POST") {
      state.linkCalls++;
      const mine = integrationTokens.get(user) ?? {};
      const results: unknown[] = [];
      for (const provider of Object.keys(mine)) {
        if (Array.isArray(body?.providers) && !body.providers.includes(provider)) continue;
        const v = vendors.get(`integration:${provider}`);
        const have = list(user).find((s) => s.auth === "integration" && s.integration === provider);
        if (have) { results.push({ provider, status: "already", server_id: have.id }); continue; }
        if (!v) { results.push({ provider, status: "unavailable", server_id: null, reason: "No remote server for that app." }); continue; }
        v.fromMind.push({ op: "probe", auth: `Bearer ${mine[provider]}` });
        if (v.bearer !== mine[provider]) { results.push({ provider, status: "rejected", server_id: null, reason: "The vendor answered 401 to that token." }); continue; }
        const rec = addServer(user, v, { name: provider, auth: "integration", integration: provider, publisher: "official" });
        results.push({ provider, status: "linked", server_id: rec.id });
      }
      return json(200, { results });
    }

    const m = /^\/mcp\/servers\/([A-Za-z0-9_-]{1,40})(?:\/(refresh|tools|tools\/call))?$/.exec(path);
    if (!m) return json(404, { detail: "Not Found" });
    const rec = list(user).find((s) => s.id === m[1]);
    if (!rec) return err(404, "not_found", "No such connected server.");
    if (!m[2] && method === "DELETE") { servers.set(user, list(user).filter((s) => s.id !== rec.id)); return json(200, { ok: true }); }
    if (!m[2] && method === "PATCH") {
      if (typeof body?.enabled === "boolean") rec.enabled = body.enabled;
      if (Array.isArray(body?.allow)) {
        if (body.allow.some((n: string) => !rec.tools.some((t) => t.name === n))) return err(422, "invalid", "That list names a tool the server does not offer.");
        rec.allow = body.allow;
      }
      if (typeof body?.name === "string") rec.name = body.name;
      rec.updated_at = tick();
      return json(200, pub(rec));
    }
    if (m[2] === "refresh" && method === "POST") {
      const v = vendors.get(canon(rec.url)) ?? vendors.get(`integration:${rec.integration}`);
      if (v) { rec.tools = v.tools.map((t) => ({ ...t })); rec.allow = rec.allow.filter((n) => rec.tools.some((t) => t.name === n)); }
      rec.status = "ok"; rec.updated_at = tick();
      return json(200, pub(rec));
    }
    if (m[2] === "tools" && method === "GET") {
      return json(200, { tools: rec.tools.map((t) => ({ name: t.name, description: t.description ?? "", read_only: !!t.read_only, destructive: !!t.destructive, allowed: rec.allow.includes(t.name), schema: t.schema ?? { type: "object", properties: {} } })), truncated: false, updated_at: rec.updated_at });
    }
    if (m[2] === "tools/call" && method === "POST") {
      if (!rec.enabled) return err(409, "disabled", "That server is switched off.");
      const v = vendors.get(canon(rec.url)) ?? vendors.get(`integration:${rec.integration}`);
      const reply = (o: Partial<{ ok: boolean; is_error: boolean; text: string; error_code: string | null; message: string }>) => json(200, { ok: true, is_error: false, text: "", truncated: false, error_code: null, message: "", ...o });
      if (!v) return reply({ ok: false, error_code: "unreachable", message: "MIND could not reach that server." });
      const cred = rec.auth === "integration" ? integrationTokens.get(user)?.[rec.integration ?? ""] : rec.sealed;
      v.fromMind.push({ op: "call", auth: cred ? `Bearer ${cred}` : undefined, name: body?.name });
      if (v.bearer && cred !== v.bearer) { rec.status = "reauth_required"; rec.updated_at = tick(); return reply({ ok: false, error_code: "auth", message: "The server no longer accepts the saved sign-in." }); }
      if (!rec.tools.some((t) => t.name === body?.name)) return reply({ ok: false, error_code: "no_such_tool", message: "That server has no such tool." });
      const out = v.run?.(String(body.name), body.arguments ?? {}) ?? { text: `ran ${body.name} ${JSON.stringify(body.arguments ?? {})}` };
      return reply({ ok: true, is_error: !!out.isError, text: out.text });
    }
    return json(405, { detail: "Method Not Allowed" });
  }

  return {
    fetch: handle as unknown as typeof fetch,
    state, requests, vendors,
    addVendor(v: FakeVendor): FakeVendor { vendors.set(canon(v.url), v); return v; },
    /** The vendor behind a MIND integration (GitHub's own MCP server) and the integration's own token. */
    addIntegrationVendor(provider: string, v: FakeVendor): FakeVendor { vendors.set(`integration:${provider}`, v); vendors.set(canon(v.url), v); return v; },
    connectIntegration(user: string, provider: string, token: string): void { integrationTokens.set(user, { ...(integrationTokens.get(user) ?? {}), [provider]: token }); },
    servers: (user: string): FakeRec[] => list(user),
    /** What a finished OAuth sign-in at MIND's callback leaves behind. */
    completeOAuth(user: string, url: string, name: string): FakeRec {
      const v = vendors.get(canon(url));
      if (!v) throw new Error("no such vendor");
      return addServer(user, v, { name, auth: "oauth", sealed: "oauth-access-token-sealed-in-mind" });
    },
    /** A connection made at MIND itself (another surface). */
    seed(user: string, v: FakeVendor, o: { name: string; auth?: string; sealed?: string; preset?: string | null }): FakeRec { return addServer(user, v, { name: o.name, auth: o.auth ?? "key", sealed: o.sealed, preset: o.preset }); },
    tick,
  };
}

export type FakeMind = ReturnType<typeof createFakeMind>;

/** Daebot's own anonymous probe of a third-party server (the consent card's tool list): in memory, and it records what Daebot sent. */
export function vendorNet(mind: FakeMind): SafeFetch {
  return async (input, init = {}) => {
    const u = new URL(String(input));
    const v = mind.vendors.get(canon(`${u.origin}${u.pathname}`));
    if (!v) return new Response("", { status: 404 });
    const headers = (init.headers ?? {}) as Record<string, string>;
    const auth = headers["authorization"] ?? headers["Authorization"];
    const msg = init.body ? JSON.parse(String(init.body)) : {};
    v.fromDaebot.push({ auth, method: msg.method });
    if (v.bearer && auth !== `Bearer ${v.bearer}`) return new Response("", { status: 401 });
    if (v.notMcp) return new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html" } });
    const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s1" } });
    if (msg.method === "initialize") return rpc({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
    if (msg.method === "notifications/initialized") return new Response("", { status: 202 });
    if (msg.method === "tools/list") return rpc({ tools: v.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema ?? { type: "object", properties: {} }, annotations: { readOnlyHint: !!t.read_only, destructiveHint: !!t.destructive } })) });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
}
