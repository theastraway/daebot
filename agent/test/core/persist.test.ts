// Server-side session persistence + boot cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore, dataDir, fileNameFor, repairMessages } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import type { Message } from "../../src/types.ts";
import { FakeProvider, baseCfg, call, collect } from "./helpers.ts";

const mindOk = (async () => new Response(JSON.stringify({ context: "BOOT" }), { status: 200, headers: { "content-type": "application/json" } })) as any;
const tmp = () => mkdtempSync(join(tmpdir(), "mc-data-"));

test("dataDir: DATA_DIR wins, otherwise ~/.daebot/data", () => {
  assert.equal(dataDir({ DATA_DIR: "/data" }), "/data");
  assert.equal(dataDir({ HOME: "/home/x" }), "/home/x/.daebot/data");
  assert.equal(dataDir({ HOME: "/home/x", DAEBOT_HOME: "/srv/d" }), "/srv/d/data");
});

test("fileNameFor: plain ids are used, anything path-like is hashed", () => {
  assert.equal(fileNameFor("abc-123"), "abc-123.json");
  for (const bad of ["../../etc/passwd", "a/b", ".hidden", "", "x".repeat(300)]) {
    const n = fileNameFor(bad);
    assert.match(n, /^h-[0-9a-f]{40}\.json$/);
  }
});

test("store: save, load, list; a torn file is skipped", async () => {
  const dir = tmp();
  const st = createFileStore(dir);
  const rec = { v: 1 as const, id: "s1", surface: "web", title: "T", tier: "admin", createdAt: 1, updatedAt: 5,
    state: { messages: [{ role: "user" as const, content: "hi" }], receiptCounter: 2, totalCostUsd: 0.1, userMessageIndex: 1 }, violations: [], history: [{ type: "user" as const, text: "hi" }] };
  await st.save(rec);
  await st.save({ ...rec, id: "s2", title: "newer", updatedAt: 9 });
  assert.deepEqual(st.load("s1"), rec);
  assert.equal(st.load("nope"), undefined);
  assert.deepEqual(createFileStore(dir).list().map((m) => m.id), ["s2", "s1"]);
  assert.ok(readdirSync(join(dir, "sessions")).every((f) => !f.endsWith(".tmp")));
});

test("repairMessages drops orphaned tool calls and results", () => {
  const m: Message[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "x", args: {} }] }, // no result: crash mid-turn
    { role: "user", content: "b" },
    { role: "tool", toolCallId: "ghost", content: "orphan" },
    { role: "assistant", content: "", toolCalls: [{ id: "t2", name: "x", args: {} }] },
    { role: "tool", toolCallId: "t2", name: "x", content: "ok" },
    { role: "assistant", content: "done" },
  ];
  assert.deepEqual(repairMessages(m).map((x) => x.role + ":" + (x.toolCallId ?? x.content)), ["user:a", "user:b", "assistant:", "tool:t2", "assistant:done"]);
});

test("a restart does not lose the chat: a new runtime resumes from disk with the full model history", async () => {
  const dir = tmp();
  const p1 = new FakeProvider([{ text: "first answer" }]);
  const rt1 = createRuntime(baseCfg(), { provider: p1, fetchImpl: mindOk, store: createFileStore(dir) });
  const s1 = await rt1.openSession({ surface: "web", title: "New session" });
  await collect(s1.send("remember the number 42"));
  await new Promise((r) => setTimeout(r, 50)); // async atomic write
  assert.ok(existsSync(join(dir, "sessions", `${s1.id}.json`)));
  const onDisk = JSON.parse(readFileSync(join(dir, "sessions", `${s1.id}.json`), "utf8"));
  assert.equal(onDisk.title, "remember the number 42", "default title becomes the first message");

  // "restart": brand new runtime, same data dir
  const p2 = new FakeProvider([{ text: "it was 42" }]);
  const rt2 = createRuntime(baseCfg(), { provider: p2, fetchImpl: mindOk, store: createFileStore(dir) });
  assert.deepEqual(rt2.listSessions().map((s) => s.id), [s1.id]);
  const hist = rt2.history!(s1.id)!;
  assert.deepEqual(hist.filter((h) => h.type === "user" || h.type === "text").map((h: any) => h.text ?? h.delta), ["remember the number 42", "first answer"]);
  const s2 = await rt2.openSession({ surface: "web", resumeId: s1.id });
  assert.equal(s2.id, s1.id);
  await collect(s2.send("what number?"));
  const sent = p2.requests[0].messages;
  assert.equal(sent[0].role, "system");
  assert.deepEqual(sent.slice(1).map((m) => m.content), ["remember the number 42", "first answer", "what number?"]);
  assert.equal(rt2.history!(s1.id)!.filter((h) => h.type === "user").length, 2);
});

test("no file is written until the first message, and empty sessions are not listed", async () => {
  const dir = tmp();
  const rt = createRuntime(baseCfg(), { provider: new FakeProvider([{ text: "x" }]), fetchImpl: mindOk, store: createFileStore(dir) });
  const s = await rt.openSession({ surface: "web" });
  assert.deepEqual(rt.listSessions(), []);
  assert.deepEqual(readdirSync(join(dir, "sessions")), []);
  await collect(s.send("hello"));
  assert.equal(rt.listSessions().length, 1);
});

test("resume keeps the identity tier: a different tier cannot open the session", async () => {
  const dir = tmp();
  const rt = createRuntime(baseCfg(), { provider: new FakeProvider([{ text: "x" }]), fetchImpl: mindOk, store: createFileStore(dir) });
  const s = await rt.openSession({ surface: "web", identity: "staff" });
  await collect(s.send("hi"));
  await new Promise((r) => setTimeout(r, 50));
  const rt2 = createRuntime(baseCfg(), { provider: new FakeProvider([{ text: "x" }]), fetchImpl: mindOk, store: createFileStore(dir) });
  await assert.rejects(rt2.openSession({ surface: "web", resumeId: s.id, identity: "admin" }), /different identity tier/);
});

test("a crash-damaged history (dangling tool call) still resumes with a valid request", async () => {
  const dir = tmp();
  const st = createFileStore(dir);
  await st.save({ v: 1, id: "crashed", surface: "web", title: "t", tier: "admin", createdAt: 1, updatedAt: 1,
    state: { messages: [{ role: "user", content: "q" }, { role: "assistant", content: "", toolCalls: [call("t1", "mind_query")] }], receiptCounter: 1, totalCostUsd: 0, userMessageIndex: 1 }, violations: [], history: [] });
  const p = new FakeProvider([{ text: "ok" }]);
  const rt = createRuntime(baseCfg(), { provider: p, fetchImpl: mindOk, store: st });
  const s = await rt.openSession({ surface: "web", resumeId: "crashed" });
  await collect(s.send("again"));
  assert.ok(!p.requests[0].messages.some((m) => m.toolCalls?.length));
});

test("boot cache: one load per key per 10 minutes, shared in flight, failures and other keys not cached", async () => {
  let t = 0, loads = 0;
  const c = new BootCache({ now: () => t });
  const load = async () => { loads++; await new Promise((r) => setTimeout(r, 5)); return { ok: true, context: "C" + loads }; };
  const [a, b] = await Promise.all([c.get("k1", load), c.get("k1", load)]);
  assert.equal(loads, 1);
  assert.equal(a.context, b.context);
  t = 9 * 60_000; await c.get("k1", load); assert.equal(loads, 1);
  await c.get("k2", load); assert.equal(loads, 2);
  t = 10 * 60_000 + 1; await c.get("k1", load); assert.equal(loads, 3);
  await c.get("k3", async () => ({ ok: false, context: "", error: "down" })); await c.get("k3", load); assert.equal(loads, 4);
});

test("boot cache: a degraded boot is cached briefly and keeps its degraded flag (notice behavior)", async () => {
  let t = 0, loads = 0;
  const c = new BootCache({ now: () => t });
  const load = async () => { loads++; return { ok: true, degraded: true, context: "d", error: "slow" }; };
  const r = await c.get("k", load);
  assert.equal(r.degraded, true);
  await c.get("k", load); assert.equal(loads, 1);
  t = 61_000; await c.get("k", load); assert.equal(loads, 2);
});

test("runtime: the second session for the same MIND key skips mind_context", async () => {
  let ctxCalls = 0;
  const f = (async (url: any) => { if (String(url).includes("context")) ctxCalls++; return new Response(JSON.stringify({ context: "BOOT" }), { status: 200 }); }) as any;
  const rt = createRuntime(baseCfg(), { provider: new FakeProvider([{ text: "x" }]), fetchImpl: f });
  await rt.openSession({ surface: "web" });
  const first = ctxCalls;
  assert.ok(first >= 1);
  await rt.openSession({ surface: "web" });
  assert.equal(ctxCalls, first, "no further MIND context call within the TTL");
});

test("a turn cut off by a server restart is saved as running, then shown as interrupted (never a silent loss)", async () => {
  const dir = tmp();
  const rt1 = createRuntime(baseCfg(), { provider: new FakeProvider([{ text: "a long answer" }]), fetchImpl: mindOk, store: createFileStore(dir) });
  const s1 = await rt1.openSession({ surface: "web", title: "New session" });
  const it = s1.send("write the long report")[Symbol.asyncIterator]();
  await it.next(); // the turn is in flight; the process "dies" here (the generator is never finished)
  await new Promise((r) => setTimeout(r, 50));
  const onDisk = JSON.parse(readFileSync(join(dir, "sessions", `${s1.id}.json`), "utf8"));
  assert.equal(onDisk.run.status, "running");
  assert.deepEqual(onDisk.history[0], { type: "user", text: "write the long report" }, "the user message is on disk before the model answers");

  const rt2 = createRuntime(baseCfg(), { provider: new FakeProvider([{ text: "second try" }]), fetchImpl: mindOk, store: createFileStore(dir) });
  const hist = rt2.history!(s1.id)!;
  const last = hist[hist.length - 1];
  assert.equal(last.type, "notice");
  assert.match((last as { text: string }).text, /Interrupted/);
  // opening it again marks the run interrupted on disk and a retry works without repeating the dead turn in context
  const s2 = await rt2.openSession({ surface: "web", resumeId: s1.id });
  await collect(s2.send("write the long report"));
  await new Promise((r) => setTimeout(r, 50));
  const after = JSON.parse(readFileSync(join(dir, "sessions", `${s1.id}.json`), "utf8"));
  assert.equal(after.run.status, "done");
  assert.equal(after.state.messages.filter((m: { role: string }) => m.role === "user").length, 1);
});
