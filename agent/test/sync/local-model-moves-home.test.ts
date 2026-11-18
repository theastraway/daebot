// A local model (ollama/...) only exists on this computer. Picking one for a session that runs in MIND Cloud moves the session onto this
// computer first (Nov 18 2026: the cloud could not serve it and answered on the free model while the window said "ollama/...").

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostedRig, deskRig, until } from "./rig.ts";
import { applyLocalLlm } from "../../src/provider/local.ts";

async function fakeOllama(models: string[]): Promise<{ base: string; close(): Promise<void> }> {
  const srv = createServer((req, res) => {
    if (req.url === "/api/tags") { const d = JSON.stringify({ models: models.map((name) => ({ name })) }); res.writeHead(200, { "content-type": "application/json", "content-length": String(d.length) }); return void res.end(d); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections(); }) };
}

test("picking a local model for a MIND Cloud session moves the session onto this computer, and the next turn runs here", async () => {
  const oll = await fakeOllama(["qwen3:14b"]);
  const hosted = await hostedRig({ script: [{ text: "CLOUD SHOULD NOT RUN" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "answered on this computer" }] });
  try {
    const put = await desk.api("PUT", "/settings/local-llm", { base: oll.base });
    assert.equal(put.status, 200, put.body);
    const sid = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop", title: "cloud by default" })).body).sessionId;
    const models = JSON.parse((await desk.api("GET", "/models")).body).models.map((m: { id: string }) => m.id);
    assert.ok(models.includes("ollama/qwen3:14b"), `the local model is in the list: ${models.join(", ")}`);

    const pick = await desk.api("PATCH", `/sessions/${sid}`, { model: "ollama/qwen3:14b" });
    assert.equal(pick.status, 200, pick.body);
    const body = JSON.parse(pick.body);
    assert.equal(body.model, "ollama/qwen3:14b");
    assert.equal(body.home, "local", "the pick moved the session onto this computer");
    assert.equal(body.env.kind, "machine");

    const res = await desk.api("POST", `/sessions/${sid}/send`, { text: "where do you run now?" });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.headers["x-daebot-cloud"], undefined, "not forwarded to the cloud");
    await until(() => desk.provider.requests.length === 1);
    assert.equal(hosted.provider.requests.length, 0, "the cloud model never ran it");
    const rec = (await until(() => desk.store.load(sid)))!;
    assert.equal(rec.env!.kind, "machine", "the saved session lives on this computer now");

    // a cloud (non-local) model on a cloud session changes nothing about where it runs
    const sid2 = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop", title: "stays in the cloud" })).body).sessionId;
    const cloudPick = JSON.parse((await desk.api("PATCH", `/sessions/${sid2}`, { model: null })).body);
    assert.equal(cloudPick.home, undefined);
  } finally {
    applyLocalLlm({});
    await desk.close(); await hosted.close(); await oll.close();
  }
});

test("a new session started on a local model (the remembered pick) lives on this computer from its first turn", async () => {
  const oll = await fakeOllama(["qwen3:14b"]);
  const hosted = await hostedRig({ script: [{ text: "CLOUD SHOULD NOT RUN" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "answered on this computer" }] });
  try {
    assert.equal((await desk.api("PUT", "/settings/local-llm", { base: oll.base })).status, 200);
    // the web app sends the remembered model with POST /sessions (models.defaultForNew)
    const made = await desk.api("POST", "/sessions", { surface: "desktop", title: "new chat on a local model", model: "ollama/qwen3:14b" });
    assert.equal(made.status, 200, made.body);
    const body = JSON.parse(made.body);
    assert.equal(body.home, "local", "the new session was homed on this computer, not in MIND Cloud");
    assert.equal(body.env.kind, "machine");
    const sid = body.sessionId;

    const res = await desk.api("POST", `/sessions/${sid}/send`, { text: "first message" });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.headers["x-daebot-cloud"], undefined, "not forwarded to the cloud");
    await until(() => desk.provider.requests.length === 1);
    assert.equal(hosted.provider.requests.length, 0, "the cloud model never ran it");
    const rec = (await until(() => desk.store.load(sid)))!;
    assert.equal(rec.env!.kind, "machine");
    assert.equal(rec.model, "ollama/qwen3:14b", "the session keeps the local model");

    // a new session on a cloud model still starts in MIND Cloud
    const plain = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop", title: "cloud by default" })).body);
    assert.equal(plain.home, undefined);
  } finally {
    applyLocalLlm({});
    await desk.close(); await hosted.close(); await oll.close();
  }
});
