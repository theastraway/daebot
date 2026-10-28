import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ChildGateway, parseReadyLine, waitForHealth } from "../src/lib/child.mjs";
import { binaryName, buildSpawnPlan, findBundledBinary, findNode } from "../src/lib/launcher.mjs";

class FakeChild extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stdout.setEncoding = () => {}; this.stderr = new EventEmitter(); this.stderr.setEncoding = () => {}; this.signals = []; this.exitOnTerm = true; this.pid = 4242; }
  kill(sig) { this.signals.push(sig); if (sig === "SIGKILL" || this.exitOnTerm) setImmediate(() => this.emit("exit", null, sig)); return true; }
  say(line) { this.stdout.emit("data", line + "\n"); }
}
const mkGw = (opts = {}) => {
  const kids = [];
  const spawns = [];
  const gw = new ChildGateway({
    spawn: (cmd, args, o) => { spawns.push({ cmd, args, o }); const k = new FakeChild(); if (opts.tune) opts.tune(k); kids.push(k); return k; },
    plan: opts.plan ?? (() => ({ command: "node", args: ["entry.mjs"], env: { A: "1" }, cwd: "/x" })),
    readyTimeoutMs: opts.readyTimeoutMs ?? 500, killGraceMs: opts.killGraceMs ?? 30,
    readToken: opts.readToken,
  });
  return { gw, kids, spawns };
};
const READY = JSON.stringify({ mindclaw: "ready", url: "http://127.0.0.1:50000", token: "t0k" });

test("parseReadyLine: JSON ready/error, stock banner, and noise", () => {
  assert.deepEqual(parseReadyLine(READY), { url: "http://127.0.0.1:50000", token: "t0k" });
  assert.deepEqual(parseReadyLine('{"mindclaw":"error","message":"no key"}'), { error: "no key" });
  assert.deepEqual(parseReadyLine("Daebot gateway on http://127.0.0.1:7777 (token in ~/.daebot/gateway-token)"), { url: "http://127.0.0.1:7777" });
  assert.deepEqual(parseReadyLine("MINDClaw gateway on http://127.0.0.1:7777 (token in ~/.mindclaw/gateway-token)"), { url: "http://127.0.0.1:7777" }, "an older build's banner still parses");
  for (const n of ["", "hello", "{bad json", '{"other":1}', '{"mindclaw":"ready"}']) assert.equal(parseReadyLine(n), null);
});

test("start resolves with url+token from the ready line (split across chunks) and spawns with piped stdio", async () => {
  const { gw, kids, spawns } = mkGw();
  const p = gw.start();
  kids[0].stdout.emit("data", "noise line\n" + READY.slice(0, 20));
  kids[0].stdout.emit("data", READY.slice(20) + "\n");
  assert.deepEqual(await p, { url: "http://127.0.0.1:50000", token: "t0k" });
  assert.equal(gw.running, true);
  assert.deepEqual(spawns[0].o.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(spawns[0].cmd, "node");
  await assert.rejects(gw.start(), /already started/);
});

test("banner without token falls back to readToken", async () => {
  const { gw, kids } = mkGw({ readToken: async (u) => (u.includes("7777") ? "filetoken" : undefined) });
  const p = gw.start();
  kids[0].say("MINDClaw gateway on http://127.0.0.1:7777 (token in ...)");
  assert.deepEqual(await p, { url: "http://127.0.0.1:7777", token: "filetoken" });
});

test("start rejects on error line, early exit, spawn error, and timeout; and cleans up", async () => {
  let m = mkGw();
  let p = m.gw.start();
  m.kids[0].say('{"mindclaw":"error","message":"OPENROUTER_API_KEY is not set"}');
  await assert.rejects(p, /OPENROUTER_API_KEY/);
  assert.equal(m.gw.running, false);
  assert.ok(m.kids[0].signals.includes("SIGTERM"));

  m = mkGw();
  p = m.gw.start();
  m.kids[0].stderr.emit("data", "boom: cannot find module\n");
  m.kids[0].emit("exit", 1, null);
  await assert.rejects(p, /exited before ready \(code 1\).*cannot find module/);

  m = mkGw();
  p = m.gw.start();
  m.kids[0].emit("error", new Error("ENOENT node"));
  await assert.rejects(p, /ENOENT/);

  m = mkGw({ readyTimeoutMs: 20 });
  await assert.rejects(m.gw.start(), /not report ready/);
  assert.equal(m.gw.child, null);
});

test("stop sends SIGTERM to OUR child only, resolves on exit, is idempotent", async () => {
  const { gw, kids } = mkGw();
  const p = gw.start(); kids[0].say(READY); await p;
  await gw.stop();
  assert.deepEqual(kids[0].signals, ["SIGTERM"]);
  assert.equal(gw.running, false);
  await gw.stop();
  assert.deepEqual(kids[0].signals, ["SIGTERM"]);
});

test("stop escalates to SIGKILL after the grace period when the child ignores SIGTERM", async () => {
  const { gw, kids } = mkGw({ tune: (k) => { k.exitOnTerm = false; }, killGraceMs: 25 });
  const p = gw.start(); kids[0].say(READY); await p;
  await gw.stop();
  assert.deepEqual(kids[0].signals, ["SIGTERM", "SIGKILL"]);
});

test("unexpected exit emits crashed; a requested stop does not", async () => {
  const { gw, kids } = mkGw();
  const crashes = [];
  gw.on("crashed", (c) => crashes.push(c));
  let p = gw.start(); kids[0].say(READY); await p;
  kids[0].emit("exit", 137, null);
  assert.deepEqual(crashes, [{ code: 137, signal: null }]);
  assert.equal(gw.running, false);
  p = gw.start(); kids[1].say(READY); await p;
  await gw.stop();
  assert.equal(crashes.length, 1);
});

test("restart rebuilds the plan (new kernel mode env) and spawns a fresh child", async () => {
  let mode = "enforced";
  const { gw, kids, spawns } = mkGw({ plan: () => ({ command: "node", args: ["e"], env: { MINDCLAW_SHADOW: mode === "shadow" ? "1" : "0" } }) });
  let p = gw.start(); kids[0].say(READY); await p;
  mode = "shadow";
  p = gw.restart();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  kids[1].say(READY.replace("50000", "50001"));
  const info = await p;
  assert.equal(info.url, "http://127.0.0.1:50001");
  assert.deepEqual(kids[0].signals, ["SIGTERM"]);
  assert.deepEqual(spawns.map((s) => s.o.env.MINDCLAW_SHADOW), ["0", "1"]);
});

test("waitForHealth retries until ok and then fails on timeout with a reason", async () => {
  let n = 0;
  const fetchImpl = async () => (++n < 3 ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ ok: true }) });
  assert.equal(await waitForHealth("http://127.0.0.1:1", { fetchImpl, intervalMs: 1, sleep: async () => {} }), true);
  assert.equal(n, 3);
  await assert.rejects(waitForHealth("http://127.0.0.1:1", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, timeoutMs: 5, intervalMs: 1 }), /ECONNREFUSED/);
});

test("buildSpawnPlan: kernel env, agent root, optional fake/token, Electron-as-node fallback", () => {
  const base = { PATH: "/usr/bin", KEEP: "1", DROP: undefined };
  const p = buildSpawnPlan({ agentRoot: "/a", entry: "/d/child-entry.mjs", kernelMode: "shadow", nodePath: "/opt/homebrew/bin/node", electronPath: "/E", baseEnv: base });
  assert.equal(p.command, "/opt/homebrew/bin/node");
  assert.deepEqual(p.args, ["/d/child-entry.mjs"]);
  assert.equal(p.cwd, "/a");
  assert.equal(p.env.MINDCLAW_SHADOW, "1");
  assert.equal(p.env.MINDCLAW_KERNEL, "1");
  assert.equal(p.env.MINDCLAW_AGENT_ROOT, "/a");
  assert.equal(p.env.KEEP, "1");
  assert.ok(!("DROP" in p.env) && !("ELECTRON_RUN_AS_NODE" in p.env) && !("MINDCLAW_DESKTOP_FAKE" in p.env));
  const q = buildSpawnPlan({ agentRoot: "/a", entry: "/e.mjs", kernelMode: "off", nodePath: null, electronPath: "/Applications/MINDClaw.app/Contents/MacOS/MINDClaw", baseEnv: {}, fake: true, tokenPath: "/t/tok" });
  assert.equal(q.command, "/Applications/MINDClaw.app/Contents/MacOS/MINDClaw");
  assert.equal(q.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(q.env.MINDCLAW_KERNEL, "0");
  assert.equal(q.env.MINDCLAW_DESKTOP_FAKE, "1");
  assert.equal(q.env.MINDCLAW_DESKTOP_TOKEN_PATH, "/t/tok");
});

test("findNode order: MINDCLAW_NODE, PATH, well-known dirs, else null", () => {
  const has = (set) => (p) => set.includes(p);
  assert.equal(findNode({ env: { MINDCLAW_NODE: "/custom/node", PATH: "/bin" }, exists: has(["/custom/node", "/bin/node"]) }), "/custom/node");
  assert.equal(findNode({ env: { PATH: "/x:/bin" }, exists: has(["/bin/node"]) }), "/bin/node");
  assert.equal(findNode({ env: { PATH: "" }, exists: has(["/opt/homebrew/bin/node"]) }), "/opt/homebrew/bin/node");
  assert.equal(findNode({ env: { MINDCLAW_NODE: "/gone" }, exists: () => false }), null);
});

test("parseReadyLine understands the compiled binary's {mindclawGateway:{url,token}} line", () => {
  const line = JSON.stringify({ mindclawGateway: { url: "http://127.0.0.1:50123", token: "t".repeat(64) } });
  assert.deepEqual(parseReadyLine(line), { url: "http://127.0.0.1:50123", token: "t".repeat(64) });
  assert.deepEqual(parseReadyLine(JSON.stringify({ mindclawGateway: { url: "http://127.0.0.1:1" } })), { url: "http://127.0.0.1:1", token: undefined });
  assert.equal(parseReadyLine(JSON.stringify({ mindclawGateway: {} })), null);
});

test("buildSpawnPlan: a bundled binary wins, serves on port 0, carries the MIND key in env only", () => {
  const p = buildSpawnPlan({ agentRoot: "/a", entry: "/e.mjs", kernelMode: "enforced", binaryPath: "/App/Resources/bin/daebot-darwin-arm64", nodePath: "/usr/bin/node", electronPath: "/E", baseEnv: { PATH: "/usr/bin" }, mindKey: "mind_TESTKEY_1234567890", home: "/Users/u" });
  assert.equal(p.command, "/App/Resources/bin/daebot-darwin-arm64");
  assert.deepEqual(p.args, ["serve", "--port", "0", "--host", "127.0.0.1"]);
  assert.equal(p.cwd, "/Users/u");
  assert.equal(p.env.DAEBOT_BILLING, "mind");
  assert.equal(p.env.MIND_API_KEY, "mind_TESTKEY_1234567890");
  assert.equal(p.env.MINDCLAW_PARENT_PIPE, "1");
  assert.equal(p.env.MINDCLAW_KERNEL, "1");
  assert.ok(!("ELECTRON_RUN_AS_NODE" in p.env));
  assert.ok(!p.args.join(" ").includes("mind_"), "the key never goes in argv");
  // the fake runtime (smoke) never uses the binary; no key -> no billing override
  const f = buildSpawnPlan({ agentRoot: "/a", entry: "/e.mjs", kernelMode: "off", binaryPath: "/bin/x", nodePath: "/usr/bin/node", electronPath: "/E", baseEnv: {}, fake: true });
  assert.equal(f.command, "/usr/bin/node");
  assert.ok(!("DAEBOT_BILLING" in f.env) && !("MIND_API_KEY" in f.env));
});

test("findBundledBinary / binaryName match agent/scripts/build-bin.mjs names", () => {
  assert.equal(binaryName("darwin", "arm64"), "daebot-darwin-arm64");
  assert.equal(binaryName("win32", "x64"), "daebot-windows-x64.exe");
  assert.equal(binaryName("linux", "x64"), "daebot-linux-x64");
  const has = (set) => (p) => set.includes(p);
  assert.equal(findBundledBinary({ resourcesPath: "/R", platform: "linux", arch: "x64", exists: has(["/R/bin/daebot-linux-x64"]) }), "/R/bin/daebot-linux-x64");
  assert.equal(findBundledBinary({ resourcesPath: "/R", platform: "linux", arch: "x64", exists: () => false }), null);
  assert.equal(findBundledBinary({ platform: "linux" }), null);
});
