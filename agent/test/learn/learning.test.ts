import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSES } from "../../src/eval/learning/classes.ts";
import { FakeMind } from "../../src/eval/learning/fake-mind.ts";
import { Reflector, alwaysGood, reflectorFor, runSession, scriptFor } from "../../src/eval/learning/harness.ts";
import { createLearning, resolveLearnConfig } from "../../src/learn/index.ts";
import { parseReflection } from "../../src/learn/reflect.ts";
import { FakeProvider, baseCfg, collect } from "../core/helpers.ts";
import { createAgentSession } from "../../src/loop.ts";
import { createKernel } from "../../src/kernel/index.ts";
import type { LearnHooks } from "../../src/learn/types.ts";

const brevity = CLASSES[0];
const turns = [{ user: brevity.session1, script: scriptFor(brevity) }, { user: brevity.correction, script: alwaysGood(brevity) }];

test("config: MINDCLAW_LEARNING=1 enables, default on only when hosted, 0 disables even when hosted", () => {
  assert.equal(resolveLearnConfig({}).enabled, false);
  assert.equal(resolveLearnConfig({}, { hosted: true }).enabled, true);
  assert.equal(resolveLearnConfig({ MINDCLAW_LEARNING: "1" }).enabled, true);
  assert.equal(resolveLearnConfig({ MINDCLAW_LEARNING: "0" }, { hosted: true }).enabled, false);
  assert.equal(resolveLearnConfig({ MINDCLAW_LEARN_USER: "Ann Smith!" }).user, "annsmith");
});

test("reflection parse: tolerates prose and fences, drops malformed output, caps lists", () => {
  assert.deepEqual(parseReflection("nothing here"), {});
  assert.deepEqual(parseReflection("{not json}"), {});
  const r = parseReflection('Sure!\n```json\n{"lesson":{"kind":"win","trigger":"t","behavior":"b","rule":"do the careful thing","evidence":"e"},"skill":{"name":"x","steps":["only one"]},"user_prefs":[{"area":"a","statement":"s"}]}\n```');
  assert.equal(r.lesson?.kind, "win");
  assert.equal(r.skill, undefined, "a skill needs at least two steps");
  assert.equal(r.userPrefs?.length, 1);
});

test("reflection runs on the cheap model, off the reply path: done arrives before a slow reflector finishes", async () => {
  const mind = new FakeMind();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow = new Reflector([]);
  const origStream = slow.stream.bind(slow);
  let model = "";
  slow.stream = async function* (req: any) { model = req.model; await gate; yield* origStream(req); } as any;
  const learning = createLearning({ client: mind, provider: slow, cfg: baseCfg(), learn: resolveLearnConfig({ MINDCLAW_LEARNING: "1" }), tier: "admin" });
  const provider = new FakeProvider([{ text: "Short." }]);
  const s = createAgentSession({ id: "s", surface: "headless", provider, kernel: createKernel({ shadow: false, enabled: true }), tools: [], sync: { async open() {}, async append() {}, async pendingReplies() { return []; }, async close() {} }, cfg: baseCfg(), cwd: "/", systemPrompt: "sys", bootContext: "ctx", learn: learning });
  await collect(s.send("hello"));
  await collect(s.send("No, that is wrong. Keep it short."));   // triggers reflection
  assert.equal(learning.stats.reflections, 1, "reflection started");
  assert.equal(mind.docs.length, 0, "...and has not finished: the reply did not wait for it");
  release();
  await learning.idle();
  assert.equal(model, "m/cheap", "reflection uses cfg.models.cheap");
});

test("loop: exactly one learned note is in the transcript, replaced on each turn, never persisted", async () => {
  const mind = new FakeMind();
  await runSession({ mind, reflector: reflectorFor(CLASSES), turns });
  const provider = new FakeProvider([{ text: "Two items open." }]);
  const learning = createLearning({ client: mind, provider: new Reflector([]), cfg: baseCfg(), learn: resolveLearnConfig({ MINDCLAW_LEARNING: "1" }), tier: "admin" });
  const s = createAgentSession({ id: "s", surface: "headless", provider, kernel: createKernel({ shadow: false, enabled: true }), tools: [], sync: { async open() {}, async append() {}, async pendingReplies() { return []; }, async close() {} }, cfg: baseCfg(), cwd: "/", systemPrompt: "sys", bootContext: "ctx", learn: learning });
  await collect(s.send(brevity.tasks[0].user));
  await collect(s.send(brevity.tasks[1].user));
  const last = provider.requests.at(-1)!.messages;
  assert.equal(last.filter((m) => m.role === "system" && m.content.startsWith("[learned]")).length, 1);
  assert.match(last.find((m) => m.content.startsWith("[learned]"))!.content, /L-[0-9a-f]{6}/);
  const state = s.exportState!();
  assert.equal(state.messages.some((m) => m.content.startsWith("[learned]")), false);
  // resuming from that state with a stale note in it must not keep the note
  const stale = { ...state, messages: [{ role: "system" as const, content: "[learned] old note" }, ...state.messages] };
  const s2 = createAgentSession({ id: "s", surface: "headless", provider, kernel: createKernel({ shadow: false, enabled: true }), tools: [], sync: { async open() {}, async append() {}, async pendingReplies() { return []; }, async close() {} }, cfg: baseCfg(), cwd: "/", systemPrompt: "sys", bootContext: "ctx", restore: stale });
  assert.equal(s2.exportState!().messages.some((m) => m.content === "[learned] old note"), false);
});

test("loop: a learning layer that throws or hangs cannot break or stall a turn", async () => {
  const boom: LearnHooks = {
    beforeTurn: async () => { throw new Error("boom"); },
    afterTurn: () => { throw new Error("boom"); },
    idle: async () => {}, close: async () => { throw new Error("boom"); },
  };
  const provider = new FakeProvider([{ text: "fine" }]);
  const s = createAgentSession({ id: "s", surface: "headless", provider, kernel: createKernel({ shadow: false, enabled: true }), tools: [], sync: { async open() {}, async append() {}, async pendingReplies() { return []; }, async close() {} }, cfg: baseCfg(), cwd: "/", systemPrompt: "sys", bootContext: "ctx", learn: boom });
  const ev = await collect(s.send("hi"));
  assert.equal((ev.at(-1) as any).finalText, "fine");
  await s.close();
});

test("beforeTurn is time-bounded: a hung MIND query yields no note instead of a stalled turn", async () => {
  const mind = new FakeMind();
  mind.query = () => new Promise<string>(() => {});
  const cfg = { ...resolveLearnConfig({ MINDCLAW_LEARNING: "1" }), beforeTurnTimeoutMs: 50 };
  const learning = createLearning({ client: mind, provider: new Reflector([]), cfg: baseCfg(), learn: cfg, tier: "admin" });
  const t0 = Date.now();
  assert.equal(await learning.beforeTurn("What is the status of the deploy progress?"), undefined);
  assert.ok(Date.now() - t0 < 1000);
});

test("outcomes: a correction right after an injected lesson counts against it, a clean follow-up counts for it", async () => {
  const mind = new FakeMind();
  await runSession({ mind, reflector: reflectorFor(CLASSES), turns });
  const learning = createLearning({ client: mind, provider: new Reflector([]), cfg: baseCfg(), learn: resolveLearnConfig({ MINDCLAW_LEARNING: "1" }), tier: "admin" });
  const q = "Give me a quick status update on the migration progress.";
  assert.match((await learning.beforeTurn(q)) ?? "", /L-/);
  await learning.beforeTurn("Thanks, now draft the next step");
  const key = learning.store.all().find((i) => i.type === "lesson")!.key;
  assert.equal(learning.store.get(key)!.helped, 1);
  assert.match((await learning.beforeTurn(q)) ?? "", /L-/);
  await learning.beforeTurn("No, that is wrong.");
  assert.equal(learning.store.get(key)!.hurt, 1);
});

test("reflection budget: at most N reflections per session", async () => {
  const mind = new FakeMind();
  const cfg = { ...resolveLearnConfig({ MINDCLAW_LEARNING: "1" }), maxReflectionsPerSession: 1 };
  const refl = reflectorFor(CLASSES);
  const learning = createLearning({ client: mind, provider: refl, cfg: baseCfg(), learn: cfg, tier: "admin" });
  const summary = (msg: string) => ({ sessionId: "s", userMessage: msg, finalText: "ok", userHistory: [], calls: [], violations: [], failed: false });
  learning.afterTurn(summary("No, that is wrong. Do it again."));
  await learning.idle();
  learning.afterTurn(summary("No, that is wrong. Do it once more."));
  await learning.idle();
  assert.equal(refl.calls, 1);
  assert.ok(learning.events.some((e) => e.type === "skipped" && /budget/.test(e.detail)));
});

test("a win lesson needs a successful multi-step turn; a failure lesson needs a negative signal", async () => {
  const mind = new FakeMind();
  const cfg = resolveLearnConfig({ MINDCLAW_LEARNING: "1" });
  const win = { lesson: { kind: "win", trigger: "finding a setting", behavior: "Grep first", rule: "Grep for the setting before opening files.", evidence: "worked" } };
  const learning = createLearning({ client: mind, provider: new Reflector([{ match: "User said", json: win }]), cfg: baseCfg(), learn: cfg, tier: "admin" });
  learning.afterTurn({ sessionId: "s", userMessage: "No, wrong.", finalText: "ok", userHistory: [], calls: [], violations: [], failed: false });
  await learning.idle();
  assert.equal(mind.docs.length, 0);
  assert.ok(learning.events.some((e) => /win lesson needs/.test(e.detail)));
});
