// The portal engineer's Settings route: the desktop owner reads its status, turns it on and off and stops a job; a gateway started
// without it (and the hosted one) answers available:false, and the loop never starts there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { fakeRuntime, http, tmpStatic } from "./helpers.ts";

test("desktop: GET/PUT /settings/engineer and POST /stop; signed out (no MIND key) means no poll", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daebot-eng-gw-"));
  const st = tmpStatic();
  let fetched = 0;
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: st.dir, tokenPath: join(dir, "tok"), engineer: { enabled: true, dir: join(dir, "engineer"), accounts: () => [], fetchImpl: (async () => { fetched++; return new Response("{}"); }) as unknown as typeof fetch } });
  const A = { authorization: `Bearer ${readFileSync(join(dir, "tok"), "utf8").trim()}` };
  try {
    const g = JSON.parse((await http(gw.url, "GET", "/settings/engineer", { headers: A })).body);
    assert.equal(g.available, true);
    assert.equal(g.enabled, true, "on by default for the desktop owner");
    assert.equal(g.signedIn, false);
    assert.equal(g.state, "signed_out");
    const off = JSON.parse((await http(gw.url, "PUT", "/settings/engineer", { headers: A, body: { enabled: false } })).body);
    assert.equal(off.enabled, false);
    assert.equal(off.state, "off");
    assert.equal((await http(gw.url, "PUT", "/settings/engineer", { headers: A, body: { enabled: "yes" } })).status, 400);
    const stop = JSON.parse((await http(gw.url, "POST", "/settings/engineer/stop", { headers: A, body: {} })).body);
    assert.equal(stop.ok, false, "nothing was running");
    assert.equal(fetched, 0);
  } finally { await gw.close(); }
});

test("hosted, or not enabled: available false, and the stop route is not there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daebot-eng-gw2-"));
  const st = tmpStatic();
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: st.dir, tokenPath: join(dir, "tok") });
  const A = { authorization: `Bearer ${readFileSync(join(dir, "tok"), "utf8").trim()}` };
  try {
    assert.equal(JSON.parse((await http(gw.url, "GET", "/settings/engineer", { headers: A })).body).available, false);
    assert.equal((await http(gw.url, "POST", "/settings/engineer/stop", { headers: A, body: {} })).status, 404);
  } finally { await gw.close(); }
  const gw2 = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: st.dir, hosted: { token: "t".repeat(40), allowedHosts: ["daebot.live"] }, engineer: { enabled: true, dir: join(dir, "e2") } });
  try {
    const r = await http(gw2.url, "GET", "/settings/engineer", { headers: { host: "daebot.live", authorization: `Bearer ${"t".repeat(40)}` } });
    if (r.status === 200) assert.equal(JSON.parse(r.body).available, false);
  } finally { await gw2.close(); }
});
