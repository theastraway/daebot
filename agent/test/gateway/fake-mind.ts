// A fake MIND server for sign-in tests: /developer/v1/profile, the MCP OAuth surface (register, authorize with
// PKCE, token with code + refresh, discovery) and a request log. Localhost only; all keys are throwaway.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen { method: string; path: string; key: string; body: any }

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
    newKey(username) { const k = "mind_" + randomBytes(24).toString("base64url"); m.keys.set(k, username); return k; },
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const raw = await body(req);
    const key = String(req.headers["x-api-key"] ?? "");
    let parsed: any = raw;
    try { parsed = raw && String(req.headers["content-type"]).includes("json") ? JSON.parse(raw) : raw; } catch { /* keep raw */ }
    m.seen.push({ method: req.method ?? "GET", path: u.pathname, key, body: parsed });

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
      if (rest === "/profile") return json(res, 200, { username, bio: "" });
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
