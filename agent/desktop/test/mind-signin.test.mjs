import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeUrl, oauthOrigin, pkceChallenge, signInWithMind } from "../src/lib/mind-signin.mjs";
import { buildSignInHtml } from "../src/lib/signin-page.mjs";

// A fake MIND OAuth server behind an injected fetch: records what Daebot sent and answers like MINDapp's mcp_oauth_routes.
function fakeMind({ tokenOk = true } = {}) {
  const seen = { register: null, token: null };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/.well-known/oauth-authorization-server")) {
      return Response.json({ authorization_endpoint: "https://mind.test/oauth/mcp/authorize", token_endpoint: "https://mind.test/oauth/mcp/token", registration_endpoint: "https://mind.test/oauth/mcp/register" });
    }
    if (u.endsWith("/oauth/mcp/register")) { seen.register = JSON.parse(init.body); return Response.json({ client_id: "cid_123" }, { status: 201 }); }
    if (u.endsWith("/oauth/mcp/token")) {
      seen.token = Object.fromEntries(new URLSearchParams(init.body));
      return tokenOk ? Response.json({ access_token: "mind_abcdefghijklmnop", token_type: "Bearer", refresh_token: "mind_rt_x" }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return new Response("nope", { status: 404 });
  };
  return { fetchImpl, seen };
}

// Plays the user's browser: follows the consent URL straight to the loopback callback, as MIND does after "Approve".
const browser = (outcome = "approve", stateOverride) => async (url) => {
  const u = new URL(url);
  const cb = new URL(u.searchParams.get("redirect_uri"));
  if (outcome === "approve") { cb.searchParams.set("code", "code_1"); cb.searchParams.set("state", stateOverride ?? u.searchParams.get("state")); }
  else { cb.searchParams.set("error", "access_denied"); cb.searchParams.set("state", u.searchParams.get("state")); }
  setTimeout(() => { fetch(cb).catch(() => {}); }, 10);
};

test("origin and PKCE helpers", () => {
  assert.equal(oauthOrigin("https://m-i-n-d.ai/developer/v1"), "https://m-i-n-d.ai");
  assert.equal(oauthOrigin("not a url"), "https://m-i-n-d.ai");
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"); // RFC 7636 appendix B
  const url = new URL(authorizeUrl({ authorize: "https://mind.test/oauth/mcp/authorize" }, { clientId: "c", redirectUri: "http://127.0.0.1:1/callback", state: "s", challenge: "x" }));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "mind:full");
});

test("browser sign-in: registers a loopback client, exchanges the code with the PKCE verifier, returns the mind_ key", async () => {
  const { fetchImpl, seen } = fakeMind();
  let opened;
  const key = await signInWithMind({ mindBaseUrl: "https://mind.test/developer/v1", fetchImpl, openExternal: async (u) => { opened = u; await browser()(u); } });
  assert.equal(key, "mind_abcdefghijklmnop");
  assert.match(seen.register.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(seen.register.token_endpoint_auth_method, "none");
  assert.equal(seen.token.grant_type, "authorization_code");
  assert.equal(seen.token.code, "code_1");
  assert.equal(seen.token.client_id, "cid_123");
  assert.equal(pkceChallenge(seen.token.code_verifier), new URL(opened).searchParams.get("code_challenge"));
  assert.ok(!opened.includes("mind_"), "no key in the browser URL");
});

test("browser sign-in: cancel, wrong state, bad token and abort all fail cleanly", async () => {
  await assert.rejects(signInWithMind({ mindBaseUrl: "https://mind.test", fetchImpl: fakeMind().fetchImpl, openExternal: browser("deny") }), /cancelled in the browser/);
  await assert.rejects(signInWithMind({ mindBaseUrl: "https://mind.test", fetchImpl: fakeMind({ tokenOk: false }).fetchImpl, openExternal: browser() }), /did not finish/);
  // A forged callback with the wrong state is ignored; the flow then times out instead of accepting it.
  await assert.rejects(signInWithMind({ mindBaseUrl: "https://mind.test", fetchImpl: fakeMind().fetchImpl, openExternal: browser("approve", "forged"), timeoutMs: 400 }), /timed out/);
  const ac = new AbortController();
  const p = signInWithMind({ mindBaseUrl: "https://mind.test", fetchImpl: fakeMind().fetchImpl, openExternal: async () => { setTimeout(() => ac.abort(), 20); }, signal: ac.signal });
  await assert.rejects(p, /cancelled/);
});

test("sign-in page leads with Sign in with MIND and keeps the API key as a fallback", () => {
  const html = buildSignInHtml();
  assert.ok(html.indexOf("Sign in with MIND") < html.indexOf("Use an API key instead"));
  assert.match(html, /<form id="f"[^>]*hidden>/);
  assert.match(html, /window\.daebotSignIn\.mind\(\)/);
});
