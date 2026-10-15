// Sign-in against MIND itself. Two methods, both verified against MIND's real endpoints:
//   1. OAuth 2.1 authorization code + PKCE (S256) against MIND's MCP OAuth server
//      (MINDapp backend/routes/mcp_oauth_routes.py): /oauth/mcp/{register,authorize,token}. Public clients
//      self-register (RFC 7591, no admin action). The access token IS a standard mind_ API key; refresh rotates it.
//   2. A pasted mind_ API key, validated live with GET /developer/v1/profile (X-API-Key) which returns {username}.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class MindAuthError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const KEY_RE = /^mind_[A-Za-z0-9_-]{12,400}$/;

export function looksLikeMindKey(k: unknown): k is string {
  return typeof k === "string" && KEY_RE.test(k.trim());
}

/** Validates a key live and returns the MIND username it belongs to. Never echoes the key in errors. */
export async function whoami(mindBaseUrl: string, key: string, fetchImpl: typeof fetch = fetch): Promise<{ username: string }> {
  if (!looksLikeMindKey(key)) throw new MindAuthError("That does not look like a MIND API key (it starts with mind_).", 400);
  let res: Response;
  try {
    res = await fetchImpl(`${mindBaseUrl.replace(/\/+$/, "")}/profile`, {
      headers: { "X-API-Key": key.trim(), Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MindAuthError("Could not reach MIND to check that key. Try again in a moment.", 502);
  }
  if (res.status === 401 || res.status === 403) throw new MindAuthError("MIND did not accept that API key.", 401);
  if (!res.ok) throw new MindAuthError("MIND could not check that key right now. Try again in a moment.", 502);
  let body: any;
  try { body = await res.json(); } catch { body = {}; }
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  if (!username || username.length > 120 || /[\s\u0000-\u001f]/.test(username)) throw new MindAuthError("MIND did not return a username for that key.", 502);
  return { username };
}

// ---------- OAuth ----------
export interface OAuthSettings {
  /** MIND origin that serves /oauth/mcp/* and /.well-known (default: origin of the developer API base). */
  baseUrl: string;
  /** Daebot's own public origin, used for the redirect URI, e.g. https://daebot.live */
  publicUrl: string;
  clientId?: string;      // MIND_OAUTH_CLIENT_ID (optional: Daebot self-registers when absent)
  clientSecret?: string;  // MIND_OAUTH_CLIENT_SECRET (optional: MIND treats Daebot as a public PKCE client)
  dataDir: string;
}

interface Endpoints { authorize: string; token: string; register?: string }
interface Pending { verifier: string; expires: number }

export const CALLBACK_PATH = "/auth/mind/callback";
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 500;

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export class MindOAuth {
  readonly redirectUri: string;
  private s: OAuthSettings;
  private f: typeof fetch;
  private endpoints?: Endpoints;
  private clientId?: string;
  private pending = new Map<string, Pending>();
  private now: () => number;

  constructor(s: OAuthSettings, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    this.s = { ...s, baseUrl: s.baseUrl.replace(/\/+$/, ""), publicUrl: s.publicUrl.replace(/\/+$/, "") };
    this.redirectUri = `${this.s.publicUrl}${CALLBACK_PATH}`;
    this.f = fetchImpl;
    this.clientId = s.clientId?.trim() || undefined;
    this.now = now;
  }

  private async discover(): Promise<Endpoints> {
    if (this.endpoints) return this.endpoints;
    const base = this.s.baseUrl;
    let ep: Endpoints = { authorize: `${base}/oauth/mcp/authorize`, token: `${base}/oauth/mcp/token`, register: `${base}/oauth/mcp/register` };
    try {
      const r = await this.f(`${base}/.well-known/oauth-authorization-server`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const m: any = await r.json();
        if (typeof m?.authorization_endpoint === "string" && typeof m?.token_endpoint === "string") {
          ep = { authorize: m.authorization_endpoint, token: m.token_endpoint, register: typeof m.registration_endpoint === "string" ? m.registration_endpoint : undefined };
        }
      }
    } catch { /* fall back to the documented paths */ }
    this.endpoints = ep;
    return ep;
  }

  private clientFile(): string { return join(this.s.dataDir, "daebot-oauth-client.json"); }

  /** The OAuth client id: env, else cached from an earlier registration, else a fresh RFC 7591 registration. */
  async ensureClient(): Promise<string> {
    if (this.clientId) return this.clientId;
    try {
      const saved = JSON.parse(readFileSync(this.clientFile(), "utf8"));
      if (saved?.redirectUri === this.redirectUri && saved?.baseUrl === this.s.baseUrl && typeof saved.clientId === "string") return (this.clientId = saved.clientId);
    } catch { /* none yet */ }
    const ep = await this.discover();
    if (!ep.register) throw new MindAuthError("MIND OAuth is not set up for Daebot yet (no client id and no registration endpoint).", 503);
    let r: Response;
    try {
      r = await this.f(ep.register, {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_name: "Daebot", client_uri: this.s.publicUrl, redirect_uris: [this.redirectUri],
          grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
          token_endpoint_auth_method: "none", scope: "mind:full",
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new MindAuthError("Could not reach MIND to start sign-in.", 502); }
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok || typeof body?.client_id !== "string") throw new MindAuthError("MIND refused Daebot's sign-in registration.", 502);
    this.clientId = body.client_id;
    try {
      mkdirSync(this.s.dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(this.clientFile(), JSON.stringify({ clientId: this.clientId, redirectUri: this.redirectUri, baseUrl: this.s.baseUrl }), { mode: 0o600 });
    } catch { /* cache is best effort */ }
    return this.clientId!;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expires <= t) this.pending.delete(k);
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
  }

  /** Builds the MIND consent URL. `state` is bound to the browser by the caller via a cookie. */
  async start(): Promise<{ url: string; state: string }> {
    const [ep, clientId] = [await this.discover(), await this.ensureClient()];
    this.sweep();
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    this.pending.set(state, { verifier, expires: this.now() + PENDING_TTL_MS });
    const u = new URL(ep.authorize);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", this.redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", pkceChallenge(verifier));
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("scope", "mind:full");
    return { url: u.toString(), state };
  }

  private async tokenCall(form: Record<string, string>): Promise<{ accessToken: string; refreshToken?: string }> {
    const ep = await this.discover();
    if (this.s.clientSecret) form.client_secret = this.s.clientSecret;
    let r: Response;
    try {
      r = await this.f(ep.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new MindAuthError("Could not reach MIND to finish sign-in.", 502); }
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok || typeof body?.access_token !== "string") {
      throw new MindAuthError(r.status === 400 || r.status === 401 ? "MIND rejected the sign-in (the link may have expired). Start again." : "MIND could not complete sign-in.", r.status === 400 || r.status === 401 ? 401 : 502);
    }
    return { accessToken: body.access_token, refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined };
  }

  /** Completes the callback: single-use state, PKCE verifier, code exchange. */
  async finish(code: string, state: string): Promise<{ accessToken: string; refreshToken?: string; clientId: string }> {
    this.sweep();
    const p = this.pending.get(state);
    this.pending.delete(state); // single use, success or fail
    if (!p || p.expires <= this.now()) throw new MindAuthError("That sign-in link expired. Start again.", 400);
    if (!code || code.length > 2000) throw new MindAuthError("Missing authorization code.", 400);
    const clientId = await this.ensureClient();
    const t = await this.tokenCall({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri, client_id: clientId, code_verifier: p.verifier });
    return { ...t, clientId };
  }

  /** Rotates the pair. MIND revokes the old key and refresh token as it issues the new ones. */
  async refresh(refreshToken: string, clientId: string): Promise<{ accessToken: string; refreshToken?: string }> {
    return this.tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
  }
}

export function oauthSettingsFromEnv(env: NodeJS.ProcessEnv, o: { mindBaseUrl: string; allowedHosts: string[]; dataDir: string }): OAuthSettings {
  let origin = "https://m-i-n-d.ai";
  try { origin = new URL(o.mindBaseUrl).origin; } catch { /* default */ }
  const host = o.allowedHosts.find((h) => !h.endsWith(".onrender.com")) ?? o.allowedHosts[0] ?? "localhost";
  return {
    baseUrl: (env.MIND_OAUTH_BASE_URL ?? "").trim() || origin,
    publicUrl: (env.DAEBOT_PUBLIC_URL ?? "").trim() || `https://${host}`,
    clientId: (env.MIND_OAUTH_CLIENT_ID ?? "").trim() || undefined,
    clientSecret: (env.MIND_OAUTH_CLIENT_SECRET ?? "").trim() || undefined,
    dataDir: o.dataDir,
  };
}
