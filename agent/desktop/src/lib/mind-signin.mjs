// "Sign in with MIND" for the desktop app: OAuth 2.1 authorization code + PKCE against MIND's own OAuth server
// (MINDapp backend/routes/mcp_oauth_routes.py), the native-app way (RFC 8252): the consent page opens in the user's real browser and
// MIND redirects back to a one-shot listener on 127.0.0.1 (MIND accepts loopback redirects for public clients). The access token
// MIND returns IS a standard mind_ API key, so the result is stored exactly like a pasted key. No secret is ever put in a URL we
// build, logged, or shown; the listener answers one request on one path and closes.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const CALLBACK_PATH = "/callback";
export const SIGNIN_TIMEOUT_MS = 5 * 60_000;

export const pkceChallenge = (verifier) => createHash("sha256").update(verifier, "ascii").digest("base64url");

/** The OAuth server origin for a MIND API base such as https://m-i-n-d.ai/developer/v1. */
export function oauthOrigin(mindBaseUrl) {
  try { return new URL(mindBaseUrl).origin; } catch { return "https://m-i-n-d.ai"; }
}

export async function discover(origin, fetchImpl = fetch) {
  let ep = { authorize: `${origin}/oauth/mcp/authorize`, token: `${origin}/oauth/mcp/token`, register: `${origin}/oauth/mcp/register` };
  try {
    const r = await fetchImpl(`${origin}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const m = await r.json();
      if (typeof m?.authorization_endpoint === "string" && typeof m?.token_endpoint === "string") {
        ep = { authorize: m.authorization_endpoint, token: m.token_endpoint, register: typeof m.registration_endpoint === "string" ? m.registration_endpoint : ep.register };
      }
    }
  } catch { /* documented paths */ }
  return ep;
}

/** RFC 7591 public-client registration for this exact loopback redirect. */
export async function registerClient(ep, redirectUri, fetchImpl = fetch) {
  const r = await fetchImpl(ep.register, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Daebot Desktop", client_uri: "https://daebot.live", redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "mind:full",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || typeof body?.client_id !== "string") throw new Error("MIND refused Daebot's sign-in registration.");
  return body.client_id;
}

export function authorizeUrl(ep, { clientId, redirectUri, state, challenge }) {
  const u = new URL(ep.authorize);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("scope", "mind:full");
  return u.toString();
}

export async function exchangeCode(ep, { code, clientId, redirectUri, verifier }, fetchImpl = fetch) {
  const r = await fetchImpl(ep.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || typeof body?.access_token !== "string") throw new Error("MIND did not finish the sign-in. Try again.");
  return body.access_token;
}

const page = (title, line) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;background:#fbf6ee;color:#141211}main{text-align:center;max-width:360px}h1{font-size:26px;margin:0 0 8px}</style></head><body><main><h1>${title}</h1><p>${line}</p></main></body></html>`;

/**
 * Runs one browser sign-in. Resolves with the mind_ key; rejects with a plain message the window can show.
 * openExternal(url) opens the system browser. `signal` cancels (e.g. the sign-in window was closed).
 */
export function signInWithMind({ mindBaseUrl, openExternal, fetchImpl = fetch, timeoutMs = SIGNIN_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    let settled = false, ep, clientId, redirectUri;
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== CALLBACK_PATH) { res.writeHead(404).end(); return; }
      const err = u.searchParams.get("error");
      if (u.searchParams.get("state") !== state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(page("Sign-in failed", "This link did not come from Daebot. Go back to Daebot and try again."));
        return; // a stray or forged request never ends the flow
      }
      const code = u.searchParams.get("code");
      if (err || !code) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Sign-in cancelled", "You can close this tab and try again in Daebot."));
        return done(new Error(err === "access_denied" ? "Sign-in was cancelled in the browser." : "MIND did not finish the sign-in. Try again."));
      }
      exchangeCode(ep, { code, clientId, redirectUri, verifier }, fetchImpl).then((key) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("You're signed in", "Return to Daebot. You can close this tab."));
        done(null, key);
      }, (e) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Sign-in failed", "Go back to Daebot and try again."));
        done(e);
      });
    });
    const timer = setTimeout(() => done(new Error("Sign-in timed out. Try again.")), timeoutMs);
    const onAbort = () => done(new Error("Sign-in was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    function done(e, key) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      server.close();
      server.closeAllConnections?.();
      if (e) reject(e instanceof Error ? e : new Error(String(e))); else resolve(key);
    }
    server.on("error", () => done(new Error("Could not start sign-in on this computer.")));
    server.listen(0, "127.0.0.1", async () => {
      try {
        redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
        ep = await discover(oauthOrigin(mindBaseUrl), fetchImpl);
        clientId = await registerClient(ep, redirectUri, fetchImpl);
        if (settled) return;
        await openExternal(authorizeUrl(ep, { clientId, redirectUri, state, challenge: pkceChallenge(verifier) }));
      } catch (e) {
        done(e instanceof Error && /MIND|sign-in/i.test(e.message) ? e : new Error("Could not reach MIND to start sign-in. Check your connection."));
      }
    });
  });
}
