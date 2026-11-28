import { test } from "node:test";
import assert from "node:assert/strict";
import { CRAFT_BAR, expandCraftMessage, isLikenessGoal, previewUrl, referenceUrl } from "../../src/agents/craft.ts";
import { createLoopTool, loopRubric, graderPrompt, builderPrompt } from "../../src/agents/loop.ts";
import { HelperHub } from "../../src/agents/hub.ts";
import type { HelperTask, SpawnHelper } from "../../src/agents/delegate.ts";
import type { WorktreeOps } from "../../src/agents/worktree.ts";
import type { PageCapture } from "../../src/likeness/measure.ts";
import type { LoopProgress, ToolProgressEvent } from "../../src/types.ts";
import { HistoryRecorder } from "../../src/events.ts";

const grade = (scores: Record<string, number>) => `{"scores": ${JSON.stringify(scores)}, "notes": "tighten it", "checks": "read it twice"}`;
const solid = (w: number, hgt: number, rgb: [number, number, number]) => { const d = new Uint8Array(w * hgt * 4); for (let i = 0; i < w * hgt; i++) d.set([...rgb, 255], i * 4); return { width: w, height: hgt, data: d }; };

test("craft helpers: likeness goals, the reference URL, the builder's PREVIEW line", () => {
  assert.ok(isLikenessGoal("make the landing page look like https://stripe.com"));
  assert.ok(isLikenessGoal("rebuild https://example.com/pricing as a static page"));
  assert.ok(isLikenessGoal("make this screen match the screenshot I attached"));
  assert.ok(!isLikenessGoal("write a launch plan for the sales team"));
  assert.ok(!isLikenessGoal("make the API look like REST"), "no UI word, no URL");
  assert.equal(referenceUrl("look like https://stripe.com/pricing."), "https://stripe.com/pricing");
  assert.equal(referenceUrl("no url"), undefined);
  assert.equal(previewUrl("Built it.\nPREVIEW: http://localhost:5173/\n"), "http://localhost:5173/");
  assert.equal(previewUrl("PREVIEW: file:///x.html"), undefined, "only http(s) can be captured");
});

test("a Craft message keeps the user's words and asks for the loop at bar 9 with the auto rubric", () => {
  const e = expandCraftMessage("write a launch plan for the sales team", { canBuild: false });
  assert.match(e, /^write a launch plan for the sales team\n\n\[Craft mode: call the loop tool now/);
  assert.match(e, /mode "write"/);
  assert.match(e, new RegExp(`bar ${CRAFT_BAR}`));
  assert.match(e, /no rubric/);
  assert.match(expandCraftMessage("build the settings page for the app", { canBuild: true }), /mode "build"/);
  assert.match(expandCraftMessage("build the settings page for the app", { canBuild: false }), /mode "write"/, "no build where it cannot build (hosted)");
  assert.match(expandCraftMessage("/loop write a launch plan for the sales team", { canBuild: false }), /\[Craft mode/);
  assert.match(expandCraftMessage("a logo", { canBuild: false }), /too short to grade/);
  assert.match(expandCraftMessage("make the hero look like https://linear.app", { canBuild: true }), /measures likeness/);
});

test("loopRubric: Craft ignores a given rubric; a measurable likeness goal adds likeness", () => {
  assert.deepEqual(loopRubric("write a launch plan doc", ["vibes"]), ["vibes"]);
  assert.deepEqual(loopRubric("write a launch plan doc", ["vibes"], { craft: true }), ["correctness", "completeness", "clarity"]);
  assert.ok(loopRubric("make the page look like https://x.dev", undefined, { craft: true, likeness: true }).includes("likeness"));
  const gp = graderPrompt({ goal: "G", rubric: ["correctness", "likeness"], bar: 9, mode: "build", artifact: "", builderReport: "R", likeness: { measured: true, similarity: 82.5, widths: [{ width: 390, similarity: 80 }] } });
  assert.match(gp, /82\.5% overall; 390px 80%/);
  assert.match(graderPrompt({ goal: "G", rubric: ["likeness"], bar: 9, mode: "build", artifact: "", likeness: { measured: false, note: "not measured here" } }), /Likeness was not measured here/);
  assert.match(builderPrompt({ goal: "G", rubric: ["likeness"], bar: 9, cycle: 1, maxCycles: 3, mode: "build", likeness: { reference: "https://x.dev" } }), /PREVIEW: <http url/);
});

function writeSpawn(scores: Record<string, number>[]): { spawn: SpawnHelper; seen: HelperTask[] } {
  const seen: HelperTask[] = [];
  let n = 0;
  return { seen, spawn: async (task) => { seen.push(task); if (task.kind === "grade") return { ok: true, text: grade(scores[Math.min(n++, scores.length - 1)]), calls: [], costUsd: 0 }; return { ok: true, text: `DRAFT ${n + 1}`, calls: [], costUsd: 0 }; } };
}

test("Craft loop: progress snapshots through ctx.progress (study, build, grade, scores, weakest, done); bar 9 whatever the model passed", async () => {
  const { spawn } = writeSpawn([{ correctness: 9, completeness: 6, clarity: 8 }, { correctness: 10, completeness: 9.5, clarity: 9.5 }]);
  const hub = new HelperHub();
  const tool = createLoopTool({ spawn, hub });
  const evs: ToolProgressEvent[] = [];
  const r = await tool.run({ goal: "write a launch plan doc for the sales team", bar: 4, rubric: ["vibes"], max_cycles: 4 }, { cwd: "/r", sessionId: "s1", capabilities: ["craft"], progress: (e) => evs.push(e) });
  assert.equal(r.ok, true, r.output);
  const snaps = evs.map((e) => e.loop);
  assert.ok(snaps.every((l) => l.bar === 9 && l.craft === true), "Craft forces bar 9");
  assert.deepEqual(snaps[0].rubric, ["correctness", "completeness", "clarity"], "auto rubric, not the model's");
  assert.equal(snaps[0].phase, "study");
  assert.ok(snaps.some((l) => l.phase === "build" && l.cycle === 1));
  assert.ok(snaps.some((l) => l.phase === "grade"));
  const firstGrade = snaps.find((l) => l.scores.length === 1)!;
  assert.equal(firstGrade.weakest, "completeness");
  assert.deepEqual(firstGrade.categories, { correctness: 9, completeness: 6, clarity: 8 });
  const last = snaps.at(-1)!;
  assert.equal(last.done, true); assert.equal(last.phase, "cleared"); assert.equal(last.scores.length, 2);
  assert.ok(last.endedAt && last.endedAt >= last.startedAt);
  assert.equal(new Set(snaps.map((l) => l.id)).size, 1, "one loop id");
  assert.equal(last.id, hub.list().loops[0].id, "same id as the Live room's loop");
  assert.equal(last.likeness, undefined, "not a UI goal: no likeness line");
});

test("a stopped loop ends with done:true and its best score; a progress listener that throws never breaks it", async () => {
  const { spawn } = writeSpawn([{ correctness: 7, completeness: 7, clarity: 8 }]);
  const tool = createLoopTool({ spawn });
  const evs: LoopProgress[] = [];
  const r = await tool.run({ goal: "write a launch plan doc for the sales team", max_cycles: 2 }, { cwd: "/r", sessionId: "s2", progress: (e) => { evs.push(e.loop); if (evs.length === 2) throw new Error("listener bug"); } });
  assert.equal(r.ok, true);
  const last = evs.at(-1)!;
  assert.equal(last.done, true); assert.equal(last.phase, "stopped"); assert.equal(last.scores.length, 2);
  assert.equal(last.bar, 9, "default bar");
  assert.equal(last.craft, undefined);
});

test("likeness: measured with a capture (a rubric category, the % on the card, the grader told); without one the card says not measured", async () => {
  const shots: string[] = [];
  const capture: PageCapture = { available: () => true, async shot(url, width) { shots.push(`${url}@${width}`); return solid(width, 40, url.includes("localhost") ? [250, 250, 250] : [255, 255, 255]); } };
  const seen: HelperTask[] = [];
  let n = 0;
  const spawn: SpawnHelper = async (task) => { seen.push(task); if (task.kind === "grade") { n++; return { ok: true, text: grade({ correctness: 9.5, completeness: 9.5, "design polish": 9.5, likeness: 9.5 }), calls: [], costUsd: 0 }; } return { ok: true, text: "Done.\nPREVIEW: http://localhost:4000/", calls: [], costUsd: 0 }; };
  const evs: LoopProgress[] = [];
  const goal = "make the landing page look like https://example.com";
  const r = await createLoopTool({ spawn, likeness: capture }).run({ goal }, { cwd: "/r", sessionId: "s3", capabilities: ["craft"], progress: (e) => evs.push(e.loop) });
  assert.equal(r.ok, true, r.output);
  assert.ok(evs[0].rubric.includes("likeness"));
  const last = evs.at(-1)!;
  assert.equal(last.likeness?.measured, true);
  assert.ok(last.likeness!.similarity! > 90, String(last.likeness!.similarity));
  assert.deepEqual(last.likeness!.widths!.map((w) => w.width), [390, 768, 1280]);
  assert.deepEqual(shots.filter((s) => s.startsWith("https://example.com")).length, 3, "the reference is captured once per width");
  assert.match(seen.find((t) => t.kind === "grade")!.prompt, /Measured likeness to the original/);
  assert.match(seen[0].prompt, /PREVIEW: <http url/);
  // No capture here (hosted, a CLI): no likeness category and an honest note.
  const evs2: LoopProgress[] = [];
  const { spawn: s2 } = writeSpawn([{ correctness: 10, completeness: 10, "design polish": 10 }]);
  await createLoopTool({ spawn: s2 }).run({ goal }, { cwd: "/r", sessionId: "s4", capabilities: ["craft"], progress: (e) => evs2.push(e.loop) });
  assert.ok(!evs2[0].rubric.includes("likeness"));
  assert.match(evs2.at(-1)!.likeness!.note!, /not measured here/);
  assert.equal(evs2.at(-1)!.likeness!.measured, false);
  // A capture that fails is a note, never a stop.
  const broken: PageCapture = { available: () => true, async shot() { throw new Error("tab crashed"); } };
  const evs3: LoopProgress[] = [];
  const r3 = await createLoopTool({ spawn, likeness: broken }).run({ goal }, { cwd: "/r", sessionId: "s5", progress: (e) => evs3.push(e.loop) });
  assert.equal(r3.ok, true);
  assert.match(evs3.at(-1)!.likeness!.note!, /not measured: tab crashed/);
});

test("hosted loop: write only. Build is not offered and refused even with worktrees passed", async () => {
  let prepared = 0;
  const wt: WorktreeOps = { prepare: () => { prepared++; return { cwd: "/wt", branch: "daebot/x", base: "main", repo: "/r" } as any; }, finish: () => ({ changed: false, files: [], stat: "" }) };
  const { spawn, seen } = writeSpawn([{ correctness: 10 }]);
  const tool = createLoopTool({ spawn, worktrees: wt, hosted: true });
  assert.deepEqual((tool.spec.parameters as any).properties.mode.enum, ["write"]);
  assert.doesNotMatch(tool.spec.description, /mode build/);
  const r = await tool.run({ goal: "build the settings page for the app", mode: "build" }, { cwd: "/r", sessionId: "h1" });
  assert.equal(r.ok, false);
  assert.match(r.output, /only in the desktop app/);
  assert.equal(prepared, 0); assert.equal(seen.length, 0, "nothing ran");
  // the desktop still builds
  const desk = createLoopTool({ spawn, worktrees: wt });
  assert.deepEqual((desk.spec.parameters as any).properties.mode.enum, ["write", "build"]);
});

test("the transcript keeps one scorecard per loop: the newest snapshot, where the first stood", () => {
  const rec = new HistoryRecorder();
  const snap = (cycle: number, done = false): ToolProgressEvent => ({ type: "loop", loop: { id: "L1", goal: "g", bar: 9, cycle, cycles: 3, phase: done ? "cleared" : "build", scores: [], categories: {}, rubric: ["a"], startedAt: 1, done, mode: "write" } });
  rec.setRun("r1");
  rec.user("craft it");
  rec.push({ type: "toolStart", receiptId: "c1", tool: "loop", args: {} });
  rec.push(snap(1)); rec.push(snap(2)); rec.push({ type: "text", delta: "x" }); rec.push(snap(3, true));
  const ev = rec.events();
  const loops = ev.filter((e) => e.type === "loop") as any[];
  assert.equal(loops.length, 1);
  assert.equal(loops[0].loop.cycle, 3); assert.equal(loops[0].loop.done, true); assert.equal(loops[0].rid, "r1");
  assert.equal(ev.indexOf(loops[0]), 2, "stays where the first one was");
});

test("review fixes: a URL alone is not a match goal; build mode only for code work", () => {
  assert.ok(!isLikenessGoal("Summarize https://example.com/post into three bullet points"));
  assert.ok(isLikenessGoal("make my landing page look like https://stripe.com"));
  assert.ok(isLikenessGoal("clone https://example.com/pricing"));
  const mode = (t: string) => /mode "(\w+)"/.exec(expandCraftMessage(t, { canBuild: true }))![1];
  assert.equal(mode("write an essay about the app design process"), "write");
  assert.equal(mode("write a launch email for the new app"), "write");
  assert.equal(mode("fix the bug in the login component"), "build");
  assert.equal(mode("build a pricing page for the site"), "build");
  assert.equal(/mode "(\w+)"/.exec(expandCraftMessage("fix the bug in the login component", { canBuild: false }))![1], "write");
});

test("review fixes: the loop stops before a cycle when over budget; hosted runs at most 3 cycles", async () => {
  const many = Array.from({ length: 6 }, () => ({ correctness: 5, completeness: 5, clarity: 5 }));
  let spent = 0;
  const a = writeSpawn(many);
  const over = await createLoopTool({ spawn: a.spawn, overBudget: () => spent++ >= 1 }).run({ goal: "write a launch plan doc for the sales team", max_cycles: 6 }, { cwd: "/r", sessionId: "b1", capabilities: ["craft"] });
  assert.match(over.output, /daily cost cap/);
  const b = writeSpawn(many);
  const evs: ToolProgressEvent[] = [];
  await createLoopTool({ spawn: b.spawn, hosted: true }).run({ goal: "write a launch plan doc for the sales team", max_cycles: 6 }, { cwd: "/r", sessionId: "b2", capabilities: ["craft"], progress: (e) => evs.push(e) });
  assert.equal(evs.at(-1)!.loop.cycles, 3, "hosted cycles clamp to 3");
});
