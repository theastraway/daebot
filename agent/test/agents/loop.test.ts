import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoopTool, expandLoopCommand, overallScore, parseGrade, suggestRubric, builderPrompt, graderPrompt } from "../../src/agents/loop.ts";
import { HelperHub } from "../../src/agents/hub.ts";
import type { HelperTask, SpawnHelper } from "../../src/agents/delegate.ts";
import type { WorktreeOps } from "../../src/agents/worktree.ts";
import type { MindClient } from "../../src/types.ts";

const ctx = { cwd: "/repo", sessionId: "s1" };

class FakeMind implements MindClient {
  queries: string[] = [];
  saved: any[] = [];
  async context() { return ""; }
  async query(q: string) { this.queries.push(q); return "Loop win - landing page: lead with the outcome, one CTA (origin:tool)."; }
  async remember(a: any) { this.saved.push(a); return "ok"; }
  async call() { return ""; }
}

const grade = (scores: Record<string, number>, notes = "fix the weakest") => `Here is my grading.\n{"scores": ${JSON.stringify(scores)}, "notes": "${notes}", "checks": "npm test: 12 pass"}`;

test("rubric, score and grade parsing follow the Rate-9 rule", () => {
  assert.deepEqual(suggestRubric("write a launch plan doc"), ["correctness", "completeness", "clarity"]);
  assert.ok(suggestRubric("fix the login api bug").includes("verification"));
  assert.ok(suggestRubric("fix the login api bug").includes("security"));
  assert.equal(overallScore({ a: 10, b: 10, c: 4 }), 5.2, "the weakest governs: 0.7*4 + 0.3*8");
  assert.equal(overallScore({ a: 9, b: 9 }), 9);
  assert.equal(overallScore({}), 0);
  const g = parseGrade(grade({ Correctness: 9, completeness: 12, clarity: -3 }), ["correctness", "completeness", "clarity", "evidence"])!;
  assert.deepEqual(g.scores, { correctness: 9, completeness: 10, clarity: 0, evidence: 0 }, "case-insensitive keys, clamped, missing = 0");
  assert.equal(g.weakest, "clarity");
  assert.equal(g.checks, "npm test: 12 pass");
  assert.equal(parseGrade("no json here", ["a"]), undefined);
  assert.equal(parseGrade('{"nope": 1}', ["a"]), undefined);
});

test("/loop expands into a loop tool instruction; other text is untouched", () => {
  assert.equal(expandLoopCommand("hello"), "hello");
  assert.equal(expandLoopCommand("see /loop later"), "see /loop later");
  const e = expandLoopCommand("/loop fix the flaky login test");
  assert.match(e, /^\/loop fix the flaky login test/);
  assert.match(e, /Call the loop tool now/);
  assert.match(e, /mode "build"/);
  assert.doesNotMatch(expandLoopCommand("/loop write a launch plan for the studio"), /mode "build"/);
  assert.match(expandLoopCommand("/loop"), /ask for the goal/);
});

test("prompts: the builder studies MIND first and attacks the weakest category; the grader must end with JSON", () => {
  const b1 = builderPrompt({ goal: "G", rubric: ["a", "b"], bar: 9, cycle: 1, maxCycles: 3, mode: "write", recall: "RECALL" });
  assert.match(b1, /Study first/);
  assert.match(b1, /RECALL/);
  const b2 = builderPrompt({ goal: "G", rubric: ["a", "b"], bar: 9, cycle: 2, maxCycles: 3, mode: "write", last: { grade: { scores: { a: 9, b: 5 }, weakest: "b", notes: "N" }, score: 6.2, artifact: "DRAFT" } });
  assert.match(b2, /Attack the weakest category first: b/);
  assert.match(b2, /DRAFT/);
  assert.match(graderPrompt({ goal: "G", rubric: ["a"], bar: 9, mode: "write", artifact: "X" }), /ONE JSON object/);
});

test("a write loop studies MIND, cycles until it clears the bar, files the win and reports every cycle", async () => {
  const mind = new FakeMind();
  const hub = new HelperHub();
  const seen: HelperTask[] = [];
  let cycle = 0;
  const spawn: SpawnHelper = async (task) => {
    seen.push(task);
    if (task.kind === "draft") { cycle++; return { ok: true, text: `DRAFT v${cycle}`, calls: [], costUsd: 0.01 }; }
    return { ok: true, text: cycle === 1 ? grade({ correctness: 8, completeness: 6, clarity: 7 }) : grade({ correctness: 9, completeness: 9, clarity: 10 }), calls: [], costUsd: 0.01 };
  };
  const tool = createLoopTool({ spawn, hub, mind: () => mind });
  assert.equal(tool.classFor!({ mode: "write" }), "read");
  const r = await tool.run({ goal: "write a launch plan doc for the team", max_cycles: 4 }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /^loop cleared 9\.\d\/10 \(bar 9\) in 2 cycle/);
  assert.match(r.output, /cycle 1: 6\.\d\/10 \(weakest: completeness 6\)/);
  assert.match(r.output, /DRAFT v2/);
  assert.equal(mind.queries.length, 1, "studied MIND once");
  assert.match(seen[0].prompt, /Study first/);
  assert.match(seen[2].prompt, /Attack the weakest category first: completeness/);
  assert.match(seen[2].prompt, /DRAFT v1/, "the next draft improves the last one");
  assert.equal(mind.saved.length, 1);
  assert.equal(mind.saved[0].title, "Loop win - write a launch plan doc for the team");
  assert.ok(mind.saved[0].tags.includes("daebot-loop-win"));
  assert.ok(mind.saved[0].tags.includes("origin:tool"));
  assert.equal((r.meta as any).costUsd.toFixed(2), "0.04");
  const live = hub.list();
  assert.equal(live.loops.length, 1);
  assert.equal(live.loops[0].phase, "cleared");
  assert.equal(live.loops[0].scores.length, 2);
  assert.equal(live.helpers.length, 4, "every builder and grader shows in the hub");
  assert.ok(live.helpers.every((h) => h.loop === live.loops[0].id));
});

test("a loop that never clears stops at max cycles, is partial and files no win; a missing grade stops it", async () => {
  const mind = new FakeMind();
  const spawn: SpawnHelper = async (task) => (task.kind === "draft" ? { ok: true, text: "draft", calls: [], costUsd: 0 } : { ok: true, text: grade({ correctness: 5, completeness: 5 }), calls: [], costUsd: 0 });
  const tool = createLoopTool({ spawn, mind: () => mind });
  const r = await tool.run({ goal: "write something hard to get right", rubric: ["correctness", "completeness"], max_cycles: 2 }, ctx);
  assert.equal(r.ok, true);
  assert.equal((r.meta as any).contract.status, "partial");
  assert.match(r.output, /^loop stopped at 5\/10 after 2 cycle/);
  assert.equal(mind.saved.length, 0);
  const bad = createLoopTool({ spawn: async (t) => ({ ok: true, text: t.kind === "draft" ? "d" : "I think it is fine", calls: [], costUsd: 0 }) });
  const r2 = await bad.run({ goal: "write something to grade properly" }, ctx);
  assert.equal(r2.ok, false);
  assert.match(r2.output, /no readable scores/);
});

test("a build loop works in ONE worktree across cycles and returns its branch", async () => {
  const prepared: string[] = [], finished: string[] = [];
  const wt: WorktreeOps = {
    prepare: (cwd, label) => { prepared.push(label); return { repo: cwd, path: "/wt/1", cwd: "/wt/1", branch: "daebot/helper-loop-1", base: "abc" }; },
    finish: (t) => { finished.push(t.branch); return { changed: true, branch: t.branch, commit: "def", files: ["src/a.ts"], stat: "1 file changed" }; },
  };
  const cwds: string[] = [];
  let n = 0;
  const spawn: SpawnHelper = async (task, o) => {
    cwds.push(o.cwd);
    if (task.kind === "build") { n++; return { ok: true, text: `edited (${n})`, calls: [], costUsd: 0 }; }
    return { ok: true, text: n < 2 ? grade({ correctness: 6 }) : grade({ correctness: 10 }), calls: [], costUsd: 0 };
  };
  const tool = createLoopTool({ spawn, worktrees: wt });
  assert.equal(tool.classFor!({ mode: "build" }), "write");
  const r = await tool.run({ goal: "fix the flaky login test in the api", mode: "build", rubric: ["correctness"] }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.equal(prepared.length, 1, "one worktree for the whole loop");
  assert.deepEqual(finished, ["daebot/helper-loop-1"], "closed once, at the end");
  assert.ok(cwds.every((c) => c === "/wt/1"), "builder and grader both work in the loop's checkout");
  assert.match(r.output, /Branch with the work: daebot\/helper-loop-1/);
  assert.equal((r.meta as any).branch, "daebot/helper-loop-1");
});

test("loop refusals: build mode without worktrees, a vague goal, a peer turn, a second loop in the same chat", async () => {
  const slow: SpawnHelper = async (t) => { await new Promise((r) => setTimeout(r, 30)); return { ok: true, text: t.kind === "draft" ? "d" : grade({ correctness: 10, completeness: 10, clarity: 10 }), calls: [], costUsd: 0 }; };
  const tool = createLoopTool({ spawn: slow });
  assert.match((await tool.run({ goal: "fix the login api bug now", mode: "build" }, ctx)).output, /build loops are not available/);
  assert.match((await tool.run({ goal: "do it" }, ctx)).output, /specific enough/);
  assert.equal((await tool.run({ goal: "write a launch plan doc" }, { ...ctx, origin: "bot" as const })).ok, false);
  const first = tool.run({ goal: "write a launch plan doc for the team" }, ctx);
  const second = await tool.run({ goal: "write another launch plan doc" }, ctx);
  assert.match(second.output, /already running/);
  assert.equal((await first).ok, true);
});

test("parseGrade finds the score JSON when the grader quotes code with braces before it", () => {
  const text = 'The fix in auth.ts looks like `function f() { return 1 }` and the config is {"a": 1}.\n{"scores": {"correctness": 8, "clarity": 9}, "notes": "tighten the error path, see \\"}\\""}';
  const g = parseGrade(text, ["correctness", "clarity"]);
  assert.ok(g, "the grade is read");
  assert.deepEqual(g!.scores, { correctness: 8, clarity: 9 });
  assert.equal(parseGrade("no json here { just code }", ["correctness"]), undefined);
});
