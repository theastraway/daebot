// Consent card routes: cookie-only, same-origin rules, OAuth callback bound to the browser that pressed Connect, /health reports mcp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { McpStore } from "../../src/mcpconnect/store.ts";
import { McpConnectService } from "../../src/mcpconnect/service.ts";
import { fakeRuntime, http, tmpStatic } from "../gateway/helpers.ts";

const H = { host: "daebot.live", "x-forwarded-proto": "https", origin: "https://daebot.live" };

async function boot(env: NodeJS.ProcessEnv = {}) {
  const st = tmpStatic();
  for (const f of ["login.html", "login.js", "login.css", "favicon.svg"]) writeFileSync(join(st.dir, f), "x");
  const token = randomBytes(18).toString("hex");
  const store = new McpStore({ dir: mkdtempSync(join(tmpdir(), "mcpg-")), secretKey: "k".repeat(40) });
  const mcpConnect = new McpConnectService({ store, env });
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: { token, allowedHosts: ["daebot.live"] }, mcpConnect });
  const r = await http(gw.url, "POST", "/login", { headers: H, body: { token } });
  const cookie = String(([] as string[]).concat(r.headers["set-cookie"] as string[])[0]).split(";")[0];
  return { gw, token, cookie, mcpConnect };
}

test("routes need the signed-in session; a cookie-less call and a foreign origin get nothing", async () => {
  const { gw, cookie } = await boot();
  try {
    for (const [m, p] of [["GET", "/mcp/servers"], ["POST", "/mcp/pending/mcp_x/approve"], ["POST", "/mcp/pending/mcp_x/deny"], ["DELETE", "/mcp/servers/srv_x"], ["PATCH", "/mcp/servers/srv_x"]] as const)
      assert.equal((await http(gw.url, m, p, { headers: H, body: m === "GET" || m === "DELETE" ? undefined : {} })).status, 401, `${m} ${p}`);
    assert.equal((await http(gw.url, "GET", "/mcp/servers", { headers: { ...H, cookie, origin: "https://evil.example" } })).status, 403);
    const ok = await http(gw.url, "GET", "/mcp/servers", { headers: { ...H, cookie } });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body).servers, []);
    assert.equal((await http(gw.url, "POST", "/mcp/pending/mcp_nope/approve", { headers: { ...H, cookie }, body: {} })).status, 404);
  } finally { await gw.close(); }
});

test("OAuth callback: arrives without the Strict session cookie, so it must carry the Lax binding cookie for THIS state or it is refused", async () => {
  const { gw, token } = await boot();
  try {
    const noCookie = await http(gw.url, "GET", "/mcp/oauth/callback?state=abc&code=xyz", { headers: H });
    assert.equal(noCookie.status, 400);
    assert.match(noCookie.body, /did not come from this browser/);
    const mac = (uid: string, state: string) => createHmac("sha256", token).update(`mcp-oauth:${uid}:${state}`).digest("base64url");
    const forged = await http(gw.url, "GET", "/mcp/oauth/callback?state=abc&code=xyz", { headers: { ...H, cookie: `mc_mcpo=owner.abc.${mac("owner", "different")}` } });
    assert.equal(forged.status, 400);
    const wrongState = await http(gw.url, "GET", "/mcp/oauth/callback?state=zzz&code=xyz", { headers: { ...H, cookie: `mc_mcpo=owner.abc.${mac("owner", "abc")}` } });
    assert.equal(wrongState.status, 400);
    // a valid binding but no such flow: the service refuses (nothing is connected)
    const noFlow = await http(gw.url, "GET", "/mcp/oauth/callback?state=abc&code=xyz", { headers: { ...H, cookie: `mc_mcpo=owner.abc.${mac("owner", "abc")}` } });
    assert.match(noFlow.body, /expired/);
  } finally { await gw.close(); }
});

test("/health reports mcp, and the kill switch turns the routes into 404", async () => {
  const on = await boot();
  const off = await boot({ DAEBOT_MCP_CONNECT_ENABLED: "false" });
  try {
    assert.equal(JSON.parse((await http(on.gw.url, "GET", "/health", { headers: H })).body).mcp, true);
    assert.equal(JSON.parse((await http(off.gw.url, "GET", "/health", { headers: H })).body).mcp, false);
    assert.equal((await http(off.gw.url, "GET", "/mcp/servers", { headers: { ...H, cookie: off.cookie } })).status, 404);
  } finally { await on.gw.close(); await off.gw.close(); }
});
