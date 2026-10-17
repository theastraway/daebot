// A fake MIND server for sign-in tests: /developer/v1/profile, the MCP OAuth surface (register, authorize with
// PKCE, token with code + refresh, discovery) and a request log. Localhost only; all keys are throwaway.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen { method: string; path: string; key: string; body: any; bot?: string }

export interface FakeMind {
  url: string;            // origin
  base: string;           // /developer/v1
  seen: Seen[];
  /** username by API key (mutable: tests add/revoke) */
  keys: Map<string, string>;
  registered: { client_id: string; redirect_uris: string[] }[];
  /** who is "logged in" on the consent screen when /authorize is hit */
  consentUser: string;
  codes: Map<string, { challenge: string; username: string; client: string; redirect: string }>;
  refreshTokens: Map<string, { username: string; key: string; client: string }>;
  lastVerifier?: string;
  /** audio endpoints: force an HTTP status (e.g. 402 / 404) for the next calls; undefined = succeed */
  audioStatus?: number;
  /** bots by username -> slug -> record (POST/GET/DELETE /developer/v1/bots) */
  bots: Map<string, Map<string, { slug: string; label: string; workspace_id: string; created_at: string }>>;
  /** max bots per user before POST /bots answers 402 bot_limit (default: unlimited) */
  botLimit?: number;
  /** when true GET /bots answers 503 (MIND down) */
  botsDown?: boolean;
  /** GET /profile/models (MIND's model list); undefined = the route answers the generic {ok:true} */
  models?: { id: string; name: string; tier?: string }[];
  newKey(username: string): string;
  close(): Promise<void>;
}

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => { let b = ""; req.setEncoding("utf8"); req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });

const json = (res: ServerResponse, status: number, v: unknown, extra: Record<string, string> = {}) => {
  const d = JSON.stringify(v);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(d)), ...extra });
  res.end(d);
};

export async function startFakeMind(initial: Record<string, string> = {}): Promise<FakeMind> {
  const m: FakeMind = {
    url: "", base: "", seen: [], keys: new Map(Object.entries(initial)), registered: [], consentUser: "", codes: new Map(), refreshTokens: new Map(),
    bots: new Map(),
    newKey(username) { const k = "mind_" + randomBytes(24).toString("base64url"); m.keys.set(k, username); return k; },
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const raw = await body(req);
    const key = String(req.headers["x-api-key"] ?? "");
    let parsed: any = raw;
    try { parsed = raw && String(req.headers["content-type"]).includes("json") ? JSON.parse(raw) : raw; } catch { /* keep raw */ }
    const botHdr = req.headers["x-mind-bot"] ? String(req.headers["x-mind-bot"]) : undefined;
    m.seen.push({ method: req.method ?? "GET", path: u.pathname, key, body: parsed, ...(botHdr ? { bot: botHdr } : {}) });

    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: m.url, authorization_endpoint: `${m.url}/oauth/mcp/authorize`, token_endpoint: `${m.url}/oauth/mcp/token`,
        registration_endpoint: `${m.url}/oauth/mcp/register`, code_challenge_methods_supported: ["S256"],
      });
    }
    if (u.pathname === "/oauth/mcp/register" && req.method === "POST") {
      const client_id = "mcp_client_" + randomBytes(6).toString("hex");
      m.registered.push({ client_id, redirect_uris: parsed.redirect_uris });
      return json(res, 201, { client_id, redirect_uris: parsed.redirect_uris, token_endpoint_auth_method: "none" });
    }
    if (u.pathname === "/oauth/mcp/authorize") {
      const q = u.searchParams;
      const client = m.registered.find((c) => c.client_id === q.get("client_id"));
      if (!client || !client.redirect_uris.includes(q.get("redirect_uri") ?? "")) return json(res, 400, { detail: "bad client or redirect" });
      if (!q.get("code_challenge") || q.get("code_challenge_method") !== "S256") return json(res, 400, { detail: "PKCE required" });
      const code = randomBytes(12).toString("hex");
      m.codes.set(code, { challenge: q.get("code_challenge")!, username: m.consentUser, client: client.client_id, redirect: q.get("redirect_uri")! });
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("code", code);
      if (q.get("state")) back.searchParams.set("state", q.get("state")!);
      res.writeHead(302, { location: back.toString() });
      return void res.end();
    }
    if (u.pathname === "/oauth/mcp/token" && req.method === "POST") {
      const f = new URLSearchParams(raw);
      const issue = (username: string, client: string) => {
        const access = m.newKey(username);
        const refresh = "mind_rt_" + randomBytes(18).toString("base64url");
        m.refreshTokens.set(refresh, { username, key: access, client });
        return json(res, 200, { access_token: access, token_type: "Bearer", scope: "mind:full", refresh_token: refresh });
      };
      if (f.get("grant_type") === "authorization_code") {
        const c = m.codes.get(f.get("code") ?? "");
        m.codes.delete(f.get("code") ?? "");
        const verifier = f.get("code_verifier") ?? "";
        m.lastVerifier = verifier;
        if (!c || createHash("sha256").update(verifier, "ascii").digest("base64url") !== c.challenge) return json(res, 400, { error: "invalid_grant" });
        if (f.get("redirect_uri") !== c.redirect) return json(res, 400, { error: "invalid_grant" });
        return issue(c.username, c.client);
      }
      if (f.get("grant_type") === "refresh_token") {
        const rt = m.refreshTokens.get(f.get("refresh_token") ?? "");
        if (!rt) return json(res, 400, { error: "invalid_grant" });
        m.refreshTokens.delete(f.get("refresh_token")!);
        m.keys.delete(rt.key); // rotation revokes the old key
        return issue(rt.username, rt.client);
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (u.pathname.startsWith("/developer/v1/")) {
      const username = m.keys.get(key);
      if (!username) return json(res, 401, { detail: "Invalid or revoked API key." });
      const rest = u.pathname.slice("/developer/v1".length);
      // ---- bots admin API (main key only)
      if (rest === "/bots" || rest.startsWith("/bots/")) {
        const mine = m.bots.get(username) ?? m.bots.set(username, new Map()).get(username)!;
        if (rest === "/bots" && req.method === "GET") return m.botsDown ? json(res, 503, { detail: "down" }) : json(res, 200, { bots: [...mine.values()] });
        if (rest === "/bots" && req.method === "POST") {
          const slug = String(parsed?.slug ?? "");
          if (mine.has(slug)) return json(res, 409, { detail: "duplicate" });
          if (m.botLimit !== undefined && mine.size >= m.botLimit) return json(res, 402, { error: "bot_limit", limit: m.botLimit, tier: "free", upgrade_url: "https://m-i-n-d.ai/#/billing" });
          const rec = { slug, label: String(parsed?.label ?? slug), workspace_id: `ws_${username}_${slug}`, created_at: new Date().toISOString() };
          mine.set(slug, rec);
          return json(res, 200, rec);
        }
        if (rest.startsWith("/bots/") && req.method === "DELETE") {
          const slug = decodeURIComponent(rest.slice(6));
          if (!mine.delete(slug)) return json(res, 404, { detail: "no such bot" });
          return json(res, 200, { ok: true });
        }
        return json(res, 405, { detail: "method" });
      }
      // ---- X-MIND-Bot: only these routes work on a bot's MIND
      if (botHdr) {
        const mine = m.bots.get(username);
        if (!mine?.has(botHdr)) return json(res, 404, { error: "bot_not_found" });
        if (!/^\/(query|context|documents|entries|graph|profile)(\/|$)/.test(rest)) return json(res, 400, { error: "bot_unsupported" });
        if (rest === "/context") return json(res, 200, { sections: [{ section: "soul", items: [{ text: `MIND of ${username} / bot ${botHdr}` }] }] });
        if (rest === "/query") return json(res, 200, { response: `bot ${botHdr} of ${username} says hello` });
        return json(res, 200, { ok: true, bot: botHdr });
      }
      if (rest === "/audio/transcriptions" || rest === "/audio/speech") {
        if (m.audioStatus) return json(res, m.audioStatus, m.audioStatus === 402 ? { error: "insufficient_credits", message: "Not enough MIND credits for voice.", upgrade_url: "https://m-i-n-d.ai/#/billing" } : { detail: "x" });
        if (rest === "/audio/transcriptions") return json(res, 200, { text: `hello from ${username}`, duration: 2.5, credits_used: 0.01 }, { "x-mind-credits-used": "0.01" });
        res.writeHead(200, { "content-type": "audio/mpeg", "x-mind-credits-used": "0.25" });
        return void res.end(Buffer.from("ID3fakemp3"));
      }
      if (rest === "/profile") return json(res, 200, { username, bio: "" });
      if (rest === "/profile/models" && m.models) return json(res, 200, { models: m.models, current: m.models[0]?.id });
      if (rest === "/context") return json(res, 200, { sections: [{ section: "soul", items: [{ text: `MIND of ${username}` }] }] });
      if (rest === "/agent-sessions/open") return json(res, 200, { session_id: `ms-${username}`, pending_replies: [] });
      return json(res, 200, { ok: true });
    }
    json(res, 404, { detail: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  m.url = `http://127.0.0.1:${port}`;
  m.base = `${m.url}/developer/v1`;
  return m;
}
