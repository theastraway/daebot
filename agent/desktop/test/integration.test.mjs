// Real child process: spawns child-entry.mjs with the scripted fake runtime (no models, no MIND, loopback only),
// reads the ready line, checks /health, proves the token gate, then stops it and confirms the process is gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildGateway, waitForHealth } from "../src/lib/child.mjs";
import { buildSpawnPlan, findNode } from "../src/lib/launcher.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(here, "..", "..");
const node = findNode();

test("real gateway child: random port, token only via pipe, health ok, auth enforced, clean stop", { skip: !node || !existsSync(join(agentRoot, "src/gateway/index.ts")) }, async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-int-"));
  const gw = new ChildGateway({
    spawn,
    readyTimeoutMs: 15_000,
    plan: () => buildSpawnPlan({ agentRoot, entry: join(here, "..", "src", "child-entry.mjs"), kernelMode: "shadow", nodePath: node, electronPath: process.execPath, baseEnv: process.env, fake: true, tokenPath: join(home, "tok") }),
  });
  const { url, token } = await gw.start();
  const pid = gw.child.pid;
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(new URL(url).port, "7777");
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(statSync(join(home, "tok")).mode & 0o777, 0o600);
    await waitForHealth(url);
    assert.equal((await fetch(`${url}/sessions`)).status, 401);
    const ok = await fetch(`${url}/sessions`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200);
    const page = await fetch(`${url}/?token=${token}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /btn-new/);
  } finally {
    await gw.stop();
  }
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "child must be gone after stop");
});

test("watcher design holds against the real gateway: a WS resume of a live session sees confirm events from another surface's SSE turn", { skip: !node || typeof WebSocket === "undefined" }, async () => {
  const { ConfirmWatcher } = await import("../src/lib/watcher.mjs");
  const home = mkdtempSync(join(tmpdir(), "mcd-int-"));
  const gw = new ChildGateway({
    spawn, readyTimeoutMs: 15_000,
    plan: () => buildSpawnPlan({ agentRoot, entry: join(here, "..", "src", "child-entry.mjs"), kernelMode: "enforced", nodePath: node, electronPath: process.execPath, baseEnv: process.env, fake: true, tokenPath: join(home, "tok") }),
  });
  const { url, token } = await gw.start();
  const auth = { authorization: `Bearer ${token}` };
  const seen = [];
  const wsUrl = new URL("/ws", url); wsUrl.protocol = "ws:"; wsUrl.searchParams.set("token", token);
  const watcher = new ConfirmWatcher({
    pollMs: 1e9,
    listSessions: async () => (await (await fetch(`${url}/sessions`, { headers: auth })).json()).sessions,
    connect: () => {
      const ws = new WebSocket(wsUrl.toString());
      const pending = [];
      const s = { onmessage: null, onclose: null, close: () => ws.close(), send: (t) => (ws.readyState === 1 ? ws.send(t) : pending.push(t)) };
      ws.onopen = () => pending.splice(0).forEach((t) => ws.send(t));
      ws.onmessage = (e) => s.onmessage?.(String(e.data));
      ws.onclose = () => s.onclose?.();
      return s;
    },
    onConfirm: (e, sid) => seen.push({ e, sid }),
  });
  try {
    const { sessionId } = await (await fetch(`${url}/sessions`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ surface: "web" }) })).json();
    watcher.start();
    await watcher.tick();
    await new Promise((r) => setTimeout(r, 200)); // let the resume frame land
    const res = await fetch(`${url}/sessions/${sessionId}/send`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ text: "please email Jane" }) });
    await res.text(); // drains the SSE stream to its end
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].sid, sessionId);
    assert.equal(seen[0].e.type, "confirm");
    assert.equal(seen[0].e.tool, "send_email");
  } finally {
    watcher.stop();
    await gw.stop();
  }
});
