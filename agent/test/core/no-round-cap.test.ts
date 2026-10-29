import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession } from "../../src/loop.ts";
import { loadConfig } from "../../src/config.ts";
import { FakeKernel, FakeProvider, FakeSync, baseCfg, call, collect, fakeTool } from "./helpers.ts";

function rig(rounds: ConstructorParameters<typeof FakeProvider>[0], cfg: Partial<ReturnType<typeof baseCfg>> = {}, now?: () => number, tool = fakeTool("r", "read")) {
  const provider = new FakeProvider(rounds);
  const session = createAgentSession({
    id: "s1", surface: "headless", provider, kernel: new FakeKernel(), tools: [tool], sync: new FakeSync(),
    cfg: baseCfg(cfg), cwd: process.cwd(), systemPrompt: "SYS", bootContext: "BOOT", ...(now ? { now } : {}),
  });
  return { provider, session, tool };
}
const manyCalls = (n: number) => Array.from({ length: n }, (_, i) => ({ calls: [call(`c${i}`, "r", { step: i })] }));
const hasCheckIn = (m: { role: string; content: string }) => m.role === "system" && m.content.startsWith("[Check-in");

test("default: a turn is not stopped at 25 rounds; 40 tool rounds then a final answer, no stop notice", async () => {
  const { session, provider } = rig([...manyCalls(40), { text: "all 40 done" }]);
  const ev = await collect(session.send("go"));
  assert.equal(provider.requests.length, 41);
  assert.ok(!ev.some((e) => e.type === "notice" && /tool rounds/.test((e as any).text)));
  assert.equal((ev.at(-1) as any).finalText, "all 40 done");
});

test("config: unset = no limit; MINDCLAW_MAX_TOOL_ROUNDS still caps; DAEBOT_CHECKIN_MS overrides the 5 minute default", () => {
  const dir = "/nonexistent-daebot-home";
  assert.equal(loadConfig({ DAEBOT_HOME: dir } as any).maxToolRoundsPerTurn, undefined);
  assert.equal(loadConfig({ DAEBOT_HOME: dir, MINDCLAW_MAX_TOOL_ROUNDS: "7" } as any).maxToolRoundsPerTurn, 7);
  assert.equal(loadConfig({ DAEBOT_HOME: dir, MINDCLAW_MAX_TOOL_ROUNDS: "" } as any).maxToolRoundsPerTurn, undefined);
  assert.equal(loadConfig({ DAEBOT_HOME: dir } as any).checkInMs, 300_000);
  assert.equal(loadConfig({ DAEBOT_HOME: dir, DAEBOT_CHECKIN_MS: "20000" } as any).checkInMs, 20_000);
});

test("env override cap still stops a runaway turn with the notice", async () => {
  const { session, provider } = rig(manyCalls(50), { maxToolRoundsPerTurn: 30 });
  const ev = await collect(session.send("go"));
  assert.equal(provider.requests.length, 30);
  assert.ok(ev.some((e) => e.type === "notice" && /stopped after 30 tool rounds/.test((e as any).text)));
});

test("check-in: after the interval (fake clock) the model sees the reminder once, its one-liner streams, the turn continues, the reminder is never shown or kept", async () => {
  let t = 1_000_000;
  const tool = fakeTool("r", "read");
  const orig = tool.run;
  tool.run = async (a, c) => { t += 120_000; return orig(a, c); }; // each tool call takes 2 minutes
  const { session, provider } = rig([
    { calls: [call("a", "r", { n: 1 })] },
    { calls: [call("b", "r", { n: 2 })] },
    { calls: [call("c", "r", { n: 3 })] },                                // 6 min elapsed after this round: check-in due
    { text: "Checking my board: 2 of 3 steps done, running the last now.", calls: [call("d", "r", { n: 4 })] },
    { text: "All steps finished." },
  ], { checkInMs: 300_000 }, () => t, tool);
  const ev = await collect(session.send("go"));
  const withNote = provider.requests.map((r, i) => [i, r.messages.some(hasCheckIn)] as const).filter(([, x]) => x).map(([i]) => i);
  assert.deepEqual(withNote, [3], "reminder reaches the model on exactly the round after the interval");
  const note = provider.requests[3].messages.find(hasCheckIn)!;
  assert.match(note.content, /ONE line/);
  assert.match(note.content, /task_board get/);
  const texts = ev.filter((e) => e.type === "text").map((e: any) => e.delta);
  assert.ok(texts.includes("Checking my board: 2 of 3 steps done, running the last now."), "one-liner is normal visible text");
  assert.ok(!JSON.stringify(ev).includes("[Check-in"), "reminder never reaches the user stream");
  assert.equal((ev.at(-1) as any).finalText, "All steps finished.");
  assert.ok(!provider.requests[4].messages.some(hasCheckIn), "reminder is dropped after its round (history stays clean)");
  assert.ok(provider.requests[4].messages.some((m) => m.role === "assistant" && m.content.startsWith("Checking my board")), "one-liner is saved in history");
});

test("check-in repeats each interval and is off when checkInMs is absent", async () => {
  let t = 0;
  const tool = fakeTool("r", "read");
  const orig = tool.run;
  tool.run = async (a, c) => { t += 100_000; return orig(a, c); };
  const a = rig([...manyCalls(12), { text: "end" }], { checkInMs: 300_000 }, () => t, tool);
  await collect(a.session.send("go"));
  const due = a.provider.requests.filter((r) => r.messages.some(hasCheckIn)).length;
  assert.ok(due >= 3 && due <= 5, `expected ~4 check-ins over 1200s, got ${due}`);
  t = 0;
  const b = rig([...manyCalls(12), { text: "end" }], {}, () => t, tool);
  await collect(b.session.send("go"));
  assert.equal(b.provider.requests.filter((r) => r.messages.some(hasCheckIn)).length, 0);
});

test("Stop still aborts immediately, even with a check-in due", async () => {
  let t = 0;
  const ctl = new AbortController();
  const tool = fakeTool("r", "read");
  tool.run = async () => { t += 400_000; ctl.abort(); return { ok: true, output: "x" }; };
  const { session, provider } = rig(manyCalls(20), { checkInMs: 300_000 }, () => t, tool);
  const ev = await collect(session.send("go", { signal: ctl.signal }));
  assert.equal((ev.at(-1) as any).finalText, "[aborted]");
  assert.equal(provider.requests.length, 1);
});

test("loop guard: 8 identical consecutive calls inject a change-approach reminder, the turn is not stopped; varied calls never trigger it", async () => {
  const same = Array.from({ length: 9 }, (_, i) => ({ calls: [call(`s${i}`, "r", { q: "same" })] }));
  const g = rig([...same, { text: "changed approach, done" }]);
  const ev = await collect(g.session.send("go"));
  const nudged = g.provider.requests.map((r, i) => [i, r.messages.some((m) => m.role === "system" && m.content.startsWith("[Loop guard"))] as const).filter(([, x]) => x).map(([i]) => i);
  assert.equal(nudged[0], 8, "reminder appears on the round after the 8th identical call");
  assert.equal((ev.at(-1) as any).finalText, "changed approach, done");
  const v = rig([...manyCalls(20), { text: "ok" }]);
  await collect(v.session.send("go"));
  assert.ok(!v.provider.requests.some((r) => r.messages.some((m) => m.content.startsWith("[Loop guard"))));
});
