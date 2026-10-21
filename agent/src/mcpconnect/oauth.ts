// MCP OAuth 2.1 client (MCP authorization spec): protected-resource discovery (RFC 9728), authorization-server metadata
// (RFC 8414 / OpenID discovery), dynamic client registration (RFC 7591), authorization code + PKCE S256, resource indicators
// (RFC 8707) and refresh. Every request goes through the SSRF-safe fetch: the metadata documents come from a remote server
// we do not trust, so the endpoints they name are untrusted too (https only, public addresses only).
import { createHash, randomBytes } from "node:crypto";
import type { SafeFetch } from "./ssrf.ts";

export class OAuthError extends Error {}

export interface AuthServerMeta {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes?: string[];
}

export interface Discovery {
  resource: string;            // canonical MCP server URL the token is for (RFC 8707)
  authServer: AuthServerMeta;
  scope?: string;
}

export interface TokenSet { accessToken: string; refreshToken?: string; expiresAt?: number }

const MAX_JSON = 200_000;

export function pkceVerifier(): string { return randomBytes(48).toString("base64url"); }
export function pkceChallenge(verifier: string): string { return createHash("sha256").update(verifier).digest("base64url"); }
export function newState(): string { return randomBytes(24).toString("base64url"); }

/** Reads `resource_metadata="..."` / `scope="..."` out of a WWW-Authenticate: Bearer challenge. */
export function parseChallenge(header: string | undefined | null): { resourceMetadata?: string; scope?: string } {
  if (!header) return {};
  const get = (k: string) => new RegExp(`${k}="([^"]*)"`, "i").exec(header)?.[1];
  return { resourceMetadata: get("resource_metadata"), scope: get("scope") };
}

function httpsUrl(v: unknown, what: string): string {
  if (typeof v !== "string") throw new OAuthError(`the server's sign-in metadata has no ${what}`);
  let u: URL;
  try { u = new URL(v); } catch { throw new OAuthError(`the server's ${what} is not a URL`); }
  if (u.protocol !== "https:" || u.username || u.password) throw new OAuthError(`the server's ${what} is not a plain https URL`);
  return u.toString();
}

async function getJson(net: SafeFetch, url: string): Promise<any | undefined> {
  let res: Response;
  try { res = await net(url, { method: "GET", headers: { accept: "application/json" }, redirects: "public" }); } catch { return undefined; }
  if (!res.ok) return undefined;
  const text = await res.text();
  if (text.length > MAX_JSON) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** The origin-rooted well-known URL with the path inserted (RFC 8414 section 3.1). */
function wellKnown(base: URL, name: string): string {
  const path = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
  return `${base.origin}/.well-known/${name}${path}`;
}

async function fetchAuthServerMeta(net: SafeFetch, issuer: string): Promise<AuthServerMeta> {
  const base = new URL(issuer);
  const candidates = [wellKnown(base, "oauth-authorization-server"), wellKnown(base, "openid-configuration"), `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`];
  for (const c of candidates) {
    const m = await getJson(net, c);
    if (!m || typeof m !== "object") continue;
    const methods = m.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes("S256")) throw new OAuthError("that server's sign-in does not support PKCE S256, so Daebot will not use it");
    if (Array.isArray(m.response_types_supported) && !m.response_types_supported.includes("code")) throw new OAuthError("that server's sign-in does not offer the authorization code flow");
    const iss = typeof m.issuer === "string" ? m.issuer : issuer;
    if (new URL(iss).host !== base.host) throw new OAuthError("the sign-in metadata names a different issuer than the server it came from");
    return {
      issuer: iss,
      authorizationEndpoint: httpsUrl(m.authorization_endpoint, "authorization endpoint"),
      tokenEndpoint: httpsUrl(m.token_endpoint, "token endpoint"),
      registrationEndpoint: m.registration_endpoint ? httpsUrl(m.registration_endpoint, "registration endpoint") : undefined,
      scopes: Array.isArray(m.scopes_supported) ? m.scopes_supported.filter((x: unknown) => typeof x === "string").slice(0, 50) : undefined,
    };
  }
  throw new OAuthError("could not find that server's sign-in metadata");
}

/** Finds how to sign in to an MCP server that answered 401. Throws OAuthError with a plain-words reason. */
export async function discover(net: SafeFetch, mcpUrl: string, challenge?: string | null): Promise<Discovery> {
  const mcp = new URL(mcpUrl);
  const ch = parseChallenge(challenge);
  const prmCandidates: string[] = [];
  if (ch.resourceMetadata) prmCandidates.push(httpsUrl(ch.resourceMetadata, "resource metadata URL"));
  prmCandidates.push(wellKnown(mcp, "oauth-protected-resource"), `${mcp.origin}/.well-known/oauth-protected-resource`);
  let issuer: string | undefined;
  let scope = ch.scope;
  for (const c of prmCandidates) {
    const prm = await getJson(net, c);
    if (!prm || typeof prm !== "object") continue;
    const first = Array.isArray(prm.authorization_servers) ? prm.authorization_servers[0] : undefined;
    if (typeof first === "string") {
      issuer = httpsUrl(first, "authorization server");
      if (!scope && Array.isArray(prm.scopes_supported)) scope = prm.scopes_supported.filter((x: unknown) => typeof x === "string").slice(0, 10).join(" ") || undefined;
      break;
    }
  }
  // 2025-03-26 servers publish no resource metadata: the MCP server's own origin is the authorization server.
  if (!issuer) issuer = mcp.origin;
  const authServer = await fetchAuthServerMeta(net, issuer);
  return { resource: mcp.toString(), authServer, scope };
}

export async function registerClient(net: SafeFetch, meta: AuthServerMeta, redirectUri: string): Promise<{ clientId: string; clientSecret?: string }> {
  if (!meta.registrationEndpoint) throw new OAuthError("that server needs a pre-registered app and does not allow Daebot to register itself; connect with an API key instead");
  let res: Response;
  try {
    res = await net(meta.registrationEndpoint, {
      method: "POST", redirects: "none",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_name: "Daebot", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
  } catch (e) { throw new OAuthError(`could not register with that server (${String((e as Error).message).slice(0, 80)})`); }
  const text = await res.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = undefined; }
  if (!res.ok || !j || typeof j.client_id !== "string" || !j.client_id) throw new OAuthError("that server refused Daebot's registration");
  return { clientId: j.client_id, clientSecret: typeof j.client_secret === "string" ? j.client_secret : undefined };
}

export function buildAuthorizeUrl(o: { meta: AuthServerMeta; clientId: string; redirectUri: string; state: string; verifier: string; resource: string; scope?: string }): string {
  const u = new URL(o.meta.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("state", o.state);
  u.searchParams.set("code_challenge", pkceChallenge(o.verifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", o.resource);
  if (o.scope) u.searchParams.set("scope", o.scope);
  return u.toString();
}

async function tokenRequest(net: SafeFetch, endpoint: string, form: Record<string, string>, now: number): Promise<TokenSet> {
  let res: Response;
  try {
    res = await net(endpoint, {
      method: "POST", redirects: "none",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (e) { throw new OAuthError(`could not reach that server's token endpoint (${String((e as Error).message).slice(0, 80)})`); }
  const text = await res.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = undefined; }
  if (!res.ok || !j || typeof j.access_token !== "string" || !j.access_token) {
    const code = typeof j?.error === "string" ? String(j.error).replace(/[^\w .-]/g, "").slice(0, 60) : `HTTP ${res.status}`;
    throw new OAuthError(`that server did not give a token (${code})`);
  }
  if (typeof j.token_type === "string" && j.token_type.toLowerCase() !== "bearer") throw new OAuthError("that server issued a token type Daebot does not support");
  const exp = Number(j.expires_in);
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : undefined,
    expiresAt: Number.isFinite(exp) && exp > 0 ? now + exp * 1000 : undefined,
  };
}

export function exchangeCode(net: SafeFetch, o: { tokenEndpoint: string; code: string; verifier: string; clientId: string; clientSecret?: string; redirectUri: string; resource: string }, now = Date.now()): Promise<TokenSet> {
  return tokenRequest(net, o.tokenEndpoint, {
    grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri, client_id: o.clientId, code_verifier: o.verifier, resource: o.resource,
    ...(o.clientSecret ? { client_secret: o.clientSecret } : {}),
  }, now);
}

export function refreshToken(net: SafeFetch, o: { tokenEndpoint: string; refreshToken: string; clientId: string; clientSecret?: string; resource: string }, now = Date.now()): Promise<TokenSet> {
  return tokenRequest(net, o.tokenEndpoint, {
    grant_type: "refresh_token", refresh_token: o.refreshToken, client_id: o.clientId, resource: o.resource,
    ...(o.clientSecret ? { client_secret: o.clientSecret } : {}),
  }, now);
}
