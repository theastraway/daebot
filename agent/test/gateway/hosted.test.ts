import { test } from "node:test";
import assert from "node:assert/strict";
import { startGateway } from "../../src/gateway/index.ts";
import { HostedConfigError, LoginLimiter, issueSession, loadHostedOptions, verifySession } from "../../src/hosted.ts";
import { main } from "../../src/cli.ts";
import { fakeRuntime, http, tmpStatic, wsConnect } from "./helpers.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const secret = () => randomBytes(18).toString("hex"); // 36 chars, throwaway

async function boot(over: { allowed?: string[]; maxFails?: number; ttl?: number } = {}) {
  const st = tmpStatic();
  writeFileSync(join(st.dir, "login.html"), "<!doctype html><title>login</title>");
  writeFileSync(join(st.dir, "login.js"), "export {}");
  writeFileSync(join(st.dir, "login.css"), "body{}");
  writeFileSync(join(st.dir, "favicon.svg"), "<svg/>");
  const token = secret();
  const gw = await startGateway({
    runtime: fakeRuntime(), port: 0, host: "127.0.0.1", staticDir: st.dir,
    hosted: { token, allowedHosts: over.allowed ?? ["daebot.live", "localhost"], loginMaxFails: over.maxFails, sessionTtlMs: over.ttl },
  });
  return { gw, token };
}
const H = { host: "daebot.live", "x-forwarded-proto": "https" };
const login = (base: string, token: unknown, headers: Record<string, string> = H) => http(base, "POST", "/login", { headers, body: { token } });
const cookieOf = (r: { headers: Record<string, string | string[] | undefined> }) => String(([] as string[]).concat(r.headers["set-cookie"] as string[])[0]).split(";")[0];

test("hosted start: refuses without GATEWAY_TOKEN, a short one, or no ALLOWED_HOSTS; never echoes the secret", async () => {
  assert.throws(() => loadHostedOptions({ MINDCLAW_HOSTED: "1", ALLOWED_HOSTS: "daebot.live" }), HostedConfigError);
  assert.throws(() => loadHostedOptions({ GATEWAY_TOKEN: "short-secret-123", ALLOWED_HOSTS: "daebot.live" }), /too short/);
  const t = secret();
  assert.throws(() => loadHostedOptions({ GATEWAY_TOKEN: t }), (e: Error) => /ALLOWED_HOSTS/.test(e.message) && !e.message.includes(t));
  const ok = loadHostedOptions({ GATEWAY_TOKEN: t, ALLOWED_HOSTS: "DaeBot.live, www.daebot.live:443 ,", RENDER_EXTERNAL_HOSTNAME: "daebot.onrender.com" });
  assert.deepEqual(ok.allowedHosts, ["daebot.live", "www.daebot.live", "daebot.onrender.com"]);
  // the gateway itself also refuses
  await assert.rejects(startGateway({ runtime: fakeRuntime(), port: 0, hosted: { token: "tiny", allowedHosts: ["a.b"] } }), HostedConfigError);
  await assert.rejects(startGateway({ runtime: fakeRuntime(), port: 0, hosted: { token: t, allowedHosts: [] } }), HostedConfigError);
});

test("cli: `serve --hosted` exits non-zero without GATEWAY_TOKEN and prints nothing secret", async () => {
  const keep = { ...process.env };
  const err: string[] = [];
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (c: any) => { err.push(String(c)); return true; };
  try {
    delete process.env.GATEWAY_TOKEN;
    process.env.MINDCLAW_HOSTED = "1";
    process.env.ALLOWED_HOSTS = "daebot.live";
    process.env.OPENROUTER_API_KEY = "or-test";
    const code = await main(["serve", "--hosted"]);
    assert.equal(code, 1);
    assert.match(err.join(""), /GATEWAY_TOKEN/);
  } finally {
    (process.stderr as any).write = realErr;
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
});

test("hosted: unauthenticated API calls are 401, the app shell is not served, / is the login page", async () => {
  const { gw } = await boot();
  try {
    for (const [m, p] of [["GET", "/sessions"], ["POST", "/sessions"], ["GET", "/sessions/x/violations"], ["POST", "/sessions/x/send"], ["DELETE", "/sessions/x"]] as const) {
      assert.equal((await http(gw.url, m, p, { headers: H, body: m === "POST" ? {} : undefined })).status, 401, `${m} ${p}`);
    }
    assert.equal((await http(gw.url, "GET", "/app.js", { headers: H })).status, 401);
    const root = await http(gw.url, "GET", "/", { headers: H });
    assert.equal(root.status, 200);
    assert.match(root.body, /<title>login<\/title>/);
    assert.equal((await http(gw.url, "GET", "/login.js", { headers: H })).status, 200);
    assert.equal((await http(gw.url, "GET", "/style.css", { headers: H })).status, 200);
    // a bearer token or ?token= is not a credential in hosted mode
    assert.equal((await http(gw.url, "GET", `/sessions?token=${gw.token}`, { headers: H })).status, 401);
    assert.equal((await http(gw.url, "GET", "/sessions", { headers: { ...H, authorization: `Bearer ${gw.token}` } })).status, 401);
    assert.match((await http(gw.url, "GET", `/?token=${gw.token}`, { headers: H })).body, /<title>login<\/title>/);
    assert.equal((await http(gw.url, "GET", `/?token=${gw.token}`, { headers: H })).headers["set-cookie"], undefined);
  } finally { await gw.close(); }
});

test("hosted login: wrong code 401, right code sets a Secure HttpOnly SameSite=Strict cookie that unlocks the app", async () => {
  const { gw, token } = await boot();
  try {
    const bad = await login(gw.url, "nope-nope-nope-nope-nope-nope");
    assert.equal(bad.status, 401);
    assert.equal(bad.headers["set-cookie"], undefined);
    assert.equal((await login(gw.url, undefined)).status, 401);
    assert.equal((await login(gw.url, 12345)).status, 401);

    const good = await login(gw.url, token);
    assert.equal(good.status, 200);
    const raw = String(([] as string[]).concat(good.headers["set-cookie"] as string[])[0]);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(raw.includes(flag), `${flag} in ${raw.replace(/=[^;]+/, "=<v>")}`);
    assert.ok(!raw.includes(token), "the login secret is not in the cookie");
    const cookie = cookieOf(good);

    const authed = { ...H, cookie };
    assert.equal((await http(gw.url, "GET", "/sessions", { headers: authed })).status, 200);
    const home = await http(gw.url, "GET", "/", { headers: authed });
    assert.match(home.body, /<title>t<\/title>/); // index.html, not the login page
    assert.equal((await http(gw.url, "GET", "/app.js", { headers: authed })).status, 200);

    // forged / tampered cookies fail
    const [exp] = cookie.split("=")[1].split(".");
    assert.equal((await http(gw.url, "GET", "/sessions", { headers: { ...H, cookie: `mc_session=${exp}.AAAA` } })).status, 401);
    assert.equal((await http(gw.url, "GET", "/sessions", { headers: { ...H, cookie: `mc_session=${Number(exp) + 99999}.${cookie.split(".")[1]}` } })).status, 401);

    // logout clears it
    const out = await http(gw.url, "POST", "/logout", { headers: authed });
    assert.equal(out.status, 200);
    assert.match(String(([] as string[]).concat(out.headers["set-cookie"] as string[])[0]), /Max-Age=0/);
  } finally { await gw.close(); }
});

test("hosted login: expired sessions are rejected; session helpers are tamper-proof", () => {
  const t = secret();
  const t0 = 1_760_000_000_000;
  const s = issueSession(t, 1000, t0);
  assert.equal(verifySession(t, s.value, t0 + 500), true);
  assert.equal(verifySession(t, s.value, t0 + 1001), false);
  assert.equal(verifySession(secret(), s.value, t0 + 500), false);
  assert.equal(verifySession(t, undefined), false);
  assert.equal(verifySession(t, "garbage"), false);
});

test("hosted login: rate limit, 5 failures per IP then 429 even for the right code; other IPs unaffected", async () => {
  const { gw, token } = await boot({ maxFails: 5 });
  try {
    const ipA = { ...H, "x-forwarded-for": "198.51.100.7" };
    for (let i = 0; i < 5; i++) assert.equal((await login(gw.url, "wrong-wrong-wrong-wrong-wrong", ipA)).status, 401, `attempt ${i + 1}`);
    const blocked = await login(gw.url, token, ipA);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
    // a spoofed left-most X-Forwarded-For does not dodge the limit (only the proxy-appended entry counts)
    const spoof = await login(gw.url, token, { ...H, "x-forwarded-for": "203.0.113.9, 198.51.100.7" });
    assert.equal(spoof.status, 429);
    // another client is still fine
    assert.equal((await login(gw.url, token, { ...H, "x-forwarded-for": "198.51.100.8" })).status, 200);
  } finally { await gw.close(); }
});

test("limiter window slides: attempts are allowed again after the window", () => {
  const l = new LoginLimiter({ maxFails: 2, windowMs: 1000 });
  l.fail("ip", 0); l.fail("ip", 10);
  assert.ok(l.retryAfter("ip", 20) > 0);
  assert.equal(l.retryAfter("ip", 1011), 0);
  l.fail("ip", 1100); l.success("ip");
  assert.equal(l.retryAfter("ip", 1101), 0);
});

test("hosted Host allowlist: accepts listed hosts, rejects others and spoofed X-Forwarded-Host", async () => {
  const { gw, token } = await boot({ allowed: ["daebot.live", "www.daebot.live"] });
  try {
    const ok = async (headers: Record<string, string>) => (await http(gw.url, "GET", "/", { headers })).status;
    assert.equal(await ok({ host: "daebot.live" }), 200);
    assert.equal(await ok({ host: "WWW.DAEBOT.LIVE:443" }), 200);
    assert.equal(await ok({ host: "evil.example" }), 403);
    assert.equal(await ok({ host: "localhost" }), 403, "loopback is not special in hosted mode");
    assert.equal(await ok({ host: "daebot.live", "x-forwarded-host": "evil.example" }), 403, "spoofed forwarded host");
    assert.equal(await ok({ host: "evil.example", "x-forwarded-host": "daebot.live" }), 403, "forwarded host cannot launder a bad Host");
    assert.equal(await ok({ host: "daebot.live", "x-forwarded-host": "www.daebot.live" }), 200);
    // login endpoint is guarded the same way
    assert.equal((await login(gw.url, token, { host: "evil.example" })).status, 403);
    // Origin: https://<allowed host> passes, others fail
    assert.equal((await login(gw.url, token, { host: "daebot.live", origin: "https://daebot.live" })).status, 200);
    assert.equal((await login(gw.url, token, { host: "daebot.live", origin: "https://evil.example" })).status, 403);
    assert.equal((await login(gw.url, token, { host: "daebot.live", origin: "http://daebot.live" })).status, 403);
    assert.equal((await login(gw.url, token, { host: "daebot.live", origin: "null" })).status, 403);
    // /health stays reachable for platform probes and says nothing else
    const h = await http(gw.url, "GET", "/health", { headers: { host: "10.0.0.5" } });
    assert.equal(h.status, 200);
    assert.deepEqual(JSON.parse(h.body), { ok: true, name: "mindclaw-gateway", hosted: true, build: "dev", bots: false });
  } finally { await gw.close(); }
});

test("hosted: plain-http hops behind the proxy are sent to https", async () => {
  const { gw } = await boot();
  try {
    const r = await http(gw.url, "GET", "/", { headers: { host: "daebot.live", "x-forwarded-proto": "http" } });
    assert.equal(r.status, 308);
    assert.equal(r.headers.location, "https://daebot.live/");
    assert.equal((await http(gw.url, "POST", "/login", { headers: { host: "daebot.live", "x-forwarded-proto": "http" }, body: {} })).status, 400);
  } finally { await gw.close(); }
});

test("hosted security headers on every response: HSTS, nosniff, no-referrer, CSP frame-ancestors none, no-store on API", async () => {
  const { gw, token } = await boot();
  try {
    const cookie = cookieOf(await login(gw.url, token));
    const responses = [
      await http(gw.url, "GET", "/", { headers: H }),
      await http(gw.url, "GET", "/health", { headers: H }),
      await http(gw.url, "GET", "/sessions", { headers: H }),                 // 401
      await http(gw.url, "GET", "/sessions", { headers: { ...H, cookie } }),  // 200 API
      await http(gw.url, "GET", "/nope", { headers: { ...H, cookie } }),      // 404
      await http(gw.url, "GET", "/", { headers: { host: "evil.example" } }),  // 403
    ];
    for (const r of responses) {
      assert.match(String(r.headers["strict-transport-security"]), /max-age=\d{7,}; includeSubDomains/, `HSTS on ${r.status}`);
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.equal(r.headers["referrer-policy"], "no-referrer");
      assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/);
    }
    assert.equal(responses[2].headers["cache-control"], "no-store");
    assert.equal(responses[3].headers["cache-control"], "no-store");
    assert.equal(responses[0].headers["cache-control"], "no-store", "login page is not cached");
  } finally { await gw.close(); }
});

test("local (non-hosted) gateway is unchanged: no HSTS, loopback hosts only", async () => {
  const st = tmpStatic();
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: st.dir, tokenPath: join(st.dir, "..", "tok") });
  try {
    const r = await http(gw.url, "GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.headers["strict-transport-security"], undefined);
    assert.equal((await http(gw.url, "GET", "/health", { headers: { host: "daebot.live" } })).status, 403);
  } finally { await gw.close(); }
});

test("hosted websocket: needs the session cookie and an allowed host", async () => {
  const { gw, token } = await boot();
  try {
    const noCookie = await wsConnect(gw.url, "/ws", { Host: "daebot.live" }).catch((e) => e);
    assert.ok(noCookie instanceof Error || (noCookie as any).status === 401);
    const cookie = cookieOf(await login(gw.url, token));
    const badHost = await wsConnect(gw.url, "/ws", { Host: "evil.example", Cookie: cookie }).catch((e) => e);
    assert.ok(badHost instanceof Error || (badHost as any).status === 403);
    const good = await wsConnect(gw.url, "/ws", { Host: "daebot.live", Cookie: cookie });
    assert.equal(good.status, 101);
    good.close();
  } finally { await gw.close(); }
});
