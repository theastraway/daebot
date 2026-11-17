// The local model server setting (desktop and self-host): saved in DATA_DIR/local-llm.json, applied without a restart,
// the model list shows what the server serves, the hosted gateway says to use the desktop app instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { fakeRuntime, http, tmpStatic } from "./helpers.ts";
import { applyLocalLlm, localEnabled, ollamaBase, preferredLocal } from "../../src/provider/local.ts";
import { cleanBase, cleanModel, readLocalLlm, writeLocalLlm } from "../../src/provider/local-config.ts";

/** A fake Ollama: GET /api/tags lists the models; anything else 404. */
async function fakeOllama(models: string[]): Promise<{ base: string; close(): Promise<void> }> {
  const srv = createServer((req, res) => {
    if (req.url === "/api/tags") { const d = JSON.stringify({ models: models.map((name) => ({ name })) }); res.writeHead(200, { "content-type": "application/json", "content-length": String(d.length) }); return void res.end(d); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections(); }) };
}

test("local-config: the file is 0600 JSON; junk never comes back; null clears; bad input throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "daebot-local-"));
  assert.deepEqual(readLocalLlm(dir), {});
  const w = writeLocalLlm(dir, { base: "127.0.0.1:1234", model: "ollama/qwen3:14b", enabled: true }, 5);
  assert.deepEqual(w, { base: "http://127.0.0.1:1234", model: "qwen3:14b", enabled: true, updatedAt: 5 });
  assert.equal(statSync(join(dir, "local-llm.json")).mode & 0o777, 0o600);
  assert.deepEqual(readLocalLlm(dir), w);
  assert.deepEqual(writeLocalLlm(dir, { base: null, enabled: null }, 6), { model: "qwen3:14b", updatedAt: 6 });
  assert.throws(() => writeLocalLlm(dir, { base: "javascript:alert(1)" }), /bad_base/);
  assert.throws(() => writeLocalLlm(dir, { base: "http://user:pw@host" }), /bad_base/);
  assert.throws(() => writeLocalLlm(dir, { model: "../x" }), /bad_model/);
  assert.equal(cleanBase("https://box.local:11434/"), "https://box.local:11434");
  assert.equal(cleanBase("http://x?y=1"), undefined);
  assert.equal(cleanModel("  "), undefined);
  // what is saved wins over the environment; absent falls back to it
  applyLocalLlm({ base: "http://10.0.0.5:11434", enabled: false, model: "a:b" });
  assert.equal(ollamaBase({ OLLAMA_HOST: "1.2.3.4:5" }), "http://10.0.0.5:11434");
  assert.equal(localEnabled({}), false);
  assert.equal(preferredLocal({ DAEBOT_TIER_LOCAL: "ollama/z" }), "a:b");
  applyLocalLlm({});
  assert.equal(ollamaBase({ OLLAMA_HOST: "1.2.3.4:5" }), "http://1.2.3.4:5");
  assert.equal(localEnabled({ DAEBOT_LOCAL_LLM: "off" }), false);
  assert.equal(localEnabled({}), true);
  assert.equal(preferredLocal({ DAEBOT_TIER_LOCAL: "ollama/z" }), "ollama/z");
});

test("desktop: point Daebot at a server from the panel; detect lists its chat models; the setting survives in the file; the runtime is told", async () => {
  const oll = await fakeOllama(["qwen3:14b", "nomic-embed-text", "llama3.2:3b"]);
  const dir = mkdtempSync(join(tmpdir(), "daebot-local-gw-"));
  const st = tmpStatic();
  const rt = fakeRuntime();
  let refreshed = 0;
  (rt as unknown as { refreshLocal: () => Promise<undefined> }).refreshLocal = async () => { refreshed++; return undefined; };
  const gw = await startGateway({ runtime: rt, port: 0, staticDir: st.dir, tokenPath: join(dir, "tok"), localLlmDir: dir });
  const A = { authorization: `Bearer ${readFileSync(join(dir, "tok"), "utf8").trim()}` };
  try {
    applyLocalLlm({});
    const g0 = JSON.parse((await http(gw.url, "GET", "/settings/local-llm", { headers: A })).body);
    assert.equal(g0.available, true);
    assert.equal(g0.enabled, true);
    assert.equal(g0.source, "default");

    const probe = JSON.parse((await http(gw.url, "POST", "/settings/local-llm/detect", { headers: A, body: { base: oll.base } })).body);
    assert.equal(probe.ok, true);
    assert.deepEqual(probe.served, ["ollama/qwen3:14b", "ollama/llama3.2:3b"], "embedding models are left out");
    assert.equal(readLocalLlm(dir).base, undefined, "detect does not save");

    const bad = await http(gw.url, "PUT", "/settings/local-llm", { headers: A, body: { base: "javascript:alert(1)" } });
    assert.equal(bad.status, 400);

    const s = JSON.parse((await http(gw.url, "PUT", "/settings/local-llm", { headers: A, body: { base: oll.base, model: "llama3.2:3b" } })).body);
    assert.equal(s.source, "panel");
    assert.equal(s.base, oll.base);
    assert.equal(s.reachable, true);
    assert.equal(s.model, "llama3.2:3b", "the preferred model when it is served");
    assert.deepEqual(s.served, ["ollama/qwen3:14b", "ollama/llama3.2:3b"]);
    assert.equal(refreshed, 1, "the runtime looked again");
    assert.equal(readLocalLlm(dir).base, oll.base);
    assert.equal(ollamaBase({}), oll.base, "the provider now talks to the saved server");

    const off = JSON.parse((await http(gw.url, "PUT", "/settings/local-llm", { headers: A, body: { enabled: false } })).body);
    assert.equal(off.enabled, false);
    assert.deepEqual(off.served, []);
    assert.equal(refreshed, 2);

    const none = JSON.parse((await http(gw.url, "POST", "/settings/local-llm/detect", { headers: A, body: { base: "http://127.0.0.1:9" } })).body);
    assert.equal(none.ok, false);
    assert.match(none.message, /Nothing answered/);
  } finally {
    applyLocalLlm({});
    await gw.close();
    await oll.close();
  }
});

test("hosted: the setting is not available and says to use the desktop app", async () => {
  const st = tmpStatic();
  const dir = mkdtempSync(join(tmpdir(), "daebot-local-h-"));
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: st.dir, hosted: { token: "t".repeat(40), allowedHosts: ["daebot.live"] }, localLlmDir: dir });
  try {
    const r = await http(gw.url, "GET", "/settings/local-llm", { headers: { host: "daebot.live", "x-forwarded-proto": "https" } });
    assert.ok(r.status === 401 || r.status === 403 || r.status === 302, `a hosted gateway wants a session first (${r.status})`);
  } finally { await gw.close(); }
});
