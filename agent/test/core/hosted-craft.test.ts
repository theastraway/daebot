import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/runtime.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { createAgentSession } from "../../src/loop.ts";
import { createFileStore } from "../../src/persist.ts";
import { hostedCallAllowed, hostedToolAllowed } from "../../src/hosted.ts";
import { CLIENT_CAPABILITIES, parseCapabilities } from "../../src/gateway/device-relay.ts";
import type { Tool } from "../../src/types.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { FakeKernel, FakeProvider, FakeSync, baseCfg, call, collect, fakeTool } from "./helpers.ts";

const rnd = () => randomBytes(12).toString("hex");

test("hosted kernel: loop is allowed in write mode only; build (or any other mode) is blocked by name AND arguments", () => {
  assert.ok(hostedToolAllowed("loop"));
  assert.ok(hostedCallAllowed("loop", { goal: "g" }), "mode defaults to write");
  assert.ok(hostedCallAllowed("loop", { goal: "g", mode: "write" }));
  assert.ok(!hostedCallAllowed("loop", { goal: "g", mode: "build" }));
  assert.ok(!hostedCallAllowed("loop", { goal: "g", mode: "BUILD" }));
  assert.ok(!hostedCallAllowed("bash", {}));
  const k = createKernel({ shadow: false, enabled: true, hosted: true });
  const state: any = { sessionId: "s", booted: true, calls: [], userMessages: [], userMsgIndex: 1, confirmations: [], shadow: false };
  const build = k.preTool(state, call("x", "loop", { goal: "build the settings page", mode: "build" }), fakeTool("loop", "write"));
  const v = build.find((x) => x.gate === "hosted");
  assert.equal(v?.action, "block");
  assert.match(v!.reason, /write mode only/);
  const write = k.preTool(state, call("y", "loop", { goal: "write a plan", mode: "write" }), fakeTool("loop", "read"));
  assert.ok(!write.some((x) => x.gate === "hosted"));
  assert.deepEqual(k.allowedTools(state, ["loop", "bash", "delegate"].map((n) => fakeTool(n, "read"))).map((t) => t.spec.name), ["loop", "delegate"]);
});

test("craft is a client capability the gateway keeps (and it needs no device relay)", () => {
  assert.ok(CLIENT_CAPABILITIES.has("craft"));
  assert.deepEqual(parseCapabilities(["craft", "nope", "craft"]), ["craft"]);
});

test("the turn loop yields a tool's progress events while it runs, before its toolEnd; other event types are dropped", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const tool: Tool = {
    class: "read",
    spec: { name: "slow", description: "slow", parameters: { type: "object", properties: {} } },
    async run(_a, ctx) {
      const snap = (cycle: number) => ({ id: "L", goal: "g", bar: 9, cycle, cycles: 2, phase: "build" as const, scores: [], categories: {}, rubric: [], startedAt: 1, done: false, mode: "write" as const });
      ctx.progress?.({ type: "loop", loop: snap(1) });
      (ctx.progress as any)?.({ type: "text", delta: "smuggled" });
      setTimeout(() => { ctx.progress?.({ type: "loop", loop: snap(2) }); release(); }, 20);
      await gate;
      return { ok: true, output: "done" };
    },
  };
  const s = createAgentSession({ id: "s1", surface: "headless", provider: new FakeProvider([{ calls: [call("c1", "slow", {})] }, { text: "fin" }]), kernel: new FakeKernel(), tools: [tool], sync: new FakeSync(), cfg: baseCfg(), cwd: process.cwd(), systemPrompt: "SYS", bootContext: "BOOT" });
  const ev = await collect(s.send("go"));
  const types = ev.map((e) => e.type).filter((t) => t === "toolStart" || t === "loop" || t === "toolEnd");
  assert.deepEqual(types, ["toolStart", "loop", "loop", "toolEnd"]);
  assert.ok(!ev.some((e) => e.type === "text" && (e as any).delta === "smuggled"));
});

async function hostedWorld(rounds: ConstructorParameters<typeof FakeProvider>[0]) {
  const key = "mind_" + rnd();
  const fake = await startFakeMind({ [key]: "pat" });
  fake.queryAnswer = () => "Loop win - plan: lead with the outcome.";
  const provider = new FakeProvider(rounds);
  const rt = createRuntime(baseCfg({ mindBaseUrl: fake.base, mindApiKey: key }), { provider, store: createFileStore(mkdtempSync(join(tmpdir(), "craft-rt-"))), hosted: { dailyUsdCap: 50, username: "pat", exempt: true } });
  const s = await rt.openSession({ surface: "web", identity: "admin" });
  return { fake, provider, rt, s };
}

test("hosted Craft end to end: the user's words stay visible, the model is told to loop at bar 9, write helpers + grader run with hosted tools only, the scorecard streams and is saved", async () => {
  const goal = "write a launch plan doc for the sales team";
  const w = await hostedWorld([
    { calls: [call("l1", "loop", { goal, mode: "write", bar: 5, rubric: ["vibes"] })] },
    { text: "DRAFT: the plan" },
    { text: grade({ correctness: 10, completeness: 9.5, clarity: 9.5 }) },
    { text: "Made the plan; cleared 9.6." },
  ]);
  try {
    const parent = w.provider.requests;
    const ev = await collect(w.s.send(goal, { capabilities: ["craft"] }));
    const first = parent[0];
    const loopSpec = first.tools.find((t) => t.name === "loop");
    assert.ok(loopSpec, "hosted offers the loop now");
    assert.deepEqual((loopSpec!.parameters as any).properties.mode.enum, ["write"], "no build mode on hosted");
    const userMsg = first.messages.filter((m) => m.role === "user").at(-1)!;
    assert.match(String(userMsg.content), /\[Craft mode: call the loop tool now/);
    assert.match(String(userMsg.content), /mode "write"/);
    for (const req of parent.slice(1, 3)) assert.ok(req.tools.every((t) => hostedToolAllowed(t.name)) && !req.tools.some((t) => t.name === "bash" || t.name === "loop"), req.tools.map((t) => t.name).join(","));
    const loops = ev.filter((e) => e.type === "loop") as any[];
    assert.ok(loops.length >= 4, String(loops.length));
    const last = loops.at(-1).loop;
    assert.equal(last.done, true); assert.equal(last.phase, "cleared"); assert.equal(last.bar, 9); assert.equal(last.craft, true);
    assert.deepEqual(last.rubric, ["correctness", "completeness", "clarity"]);
    const toolEnd = ev.findIndex((e) => e.type === "toolEnd");
    assert.ok(ev.findIndex((e) => e.type === "loop") < toolEnd, "the scorecard streams before the tool ends");
    const hist = w.rt.history!(w.s.id)!;
    assert.equal((hist.find((h) => h.type === "user") as any).text, goal, "the transcript keeps the user's own words");
    assert.equal(hist.filter((h) => h.type === "loop").length, 1, "one saved scorecard, the newest");
  } finally { await w.s.close(); await w.fake.close(); }
});

test("hosted: a model that asks for a build loop is refused and nothing is spawned", async () => {
  const w = await hostedWorld([
    { calls: [call("l1", "loop", { goal: "build the settings page for the app", mode: "build" })] },
    { text: "Build loops need the desktop app." },
  ]);
  try {
    const ev = await collect(w.s.send("build the settings page for the app", { capabilities: ["craft"] }));
    assert.ok(!w.provider.requests.some((r) => r.messages.some((m) => /Loop goal:/.test(String(m.content)))), "no helper ran");
    assert.ok(ev.some((e) => e.type === "gate" && e.verdict.gate === "hosted"), "the hosted gate refused it");
    assert.ok(!ev.some((e) => e.type === "loop"), "no loop started");
    const toolMsg = w.provider.requests[1].messages.find((m) => m.role === "tool");
    assert.match(String((toolMsg as any).content), /write mode only|only in the desktop app/);
  } finally { await w.s.close(); await w.fake.close(); }
});

function grade(scores: Record<string, number>): string {
  return `{"scores": ${JSON.stringify(scores)}, "notes": "ship it", "checks": "read twice"}`;
}
