import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_COUNTERS, StudioError, StudioStore, pipelineSummary } from "../../src/studio/store.ts";
import { createStudioTools } from "../../src/tools/studio.ts";
import { contractOf } from "../../src/tools/contract.ts";
import { assembleStudio } from "../../src/studio/index.ts";

const mk = () => { let t = 1000; const dir = mkdtempSync(join(tmpdir(), "studio-")); return { dir, store: new StudioStore({ dir, owner: "o/1", now: () => (t += 10) }) }; };

test("counters: at most three per bot, a name reuse updates, null removes, bad input is refused, the file is 0600 and survives a reload", () => {
  const { dir, store } = mk();
  store.setCounter("b_1", "  applications ", "389");
  store.setCounter("b_1", "docs live", 8.456, "from the docs index");
  store.setCounter("b_1", "calls", 12);
  assert.throws(() => store.setCounter("b_1", "fourth", 1), (e: unknown) => e instanceof StudioError && e.code === "too_many");
  assert.deepEqual(store.counters("b_1").map((c) => [c.name, c.value, c.note]), [["applications", 389, undefined], ["docs live", 8.46, "from the docs index"], ["calls", 12, undefined]]);
  store.setCounter("b_1", "Applications", 390);
  assert.equal(store.counters("b_1")[0].value, 390);
  store.setCounter("b_1", "calls", null);
  assert.equal(store.counters("b_1").length, MAX_COUNTERS - 1);
  assert.throws(() => store.setCounter("b_1", "", 1), (e: unknown) => e instanceof StudioError && e.code === "bad_name");
  assert.throws(() => store.setCounter("b_1", "x", "lots"), (e: unknown) => e instanceof StudioError && e.code === "bad_value");
  const file = join(dir, "o_1.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, "utf8").includes("\n"), "one line of JSON");
  const again = new StudioStore({ dir, owner: "o/1" });
  assert.equal(again.counters("b_1").length, 2);
  assert.deepEqual(again.counters("b_zzz"), []);
});

test("pipelines: define resets stages, advance by name or number logs who moved it, the summary names the current stage, remove drops it", () => {
  const { store } = mk();
  const p = store.define("Design Studio", [{ name: "style", skill: "Taste-Skill" }, "design", { name: "build", bot: "max" }], "Dae");
  assert.equal(p.department, "design-studio");
  assert.deepEqual(p.stages.map((s) => [s.name, s.skill, s.bot, s.status]), [["style", "taste-skill", undefined, "todo"], ["design", undefined, undefined, "todo"], ["build", undefined, "max", "todo"]]);
  assert.equal(p.log.length, 1);
  assert.throws(() => store.define("x", [{ name: "a" }, { name: "A" }], "Dae"), (e: unknown) => e instanceof StudioError && e.code === "bad_stages");
  assert.throws(() => store.define("x", [], "Dae"), (e: unknown) => e instanceof StudioError && e.code === "bad_stages");
  assert.throws(() => store.advance("nope", "style", "done", "Dae"), (e: unknown) => e instanceof StudioError && e.code === "no_pipeline");
  store.advance("design studio", "style", "done", "Olivia", "palette picked");
  const q = store.advance("design-studio", "2", "running", "Leo");
  assert.deepEqual(pipelineSummary(q), { stage: 2, of: 3, done: 1, current: "design", status: "running", marks: ["done", "running", "todo"] });
  assert.deepEqual(q.log.slice(1).map((l) => [l.stage, l.status, l.by, l.skill, l.note]), [["style", "done", "Olivia", "taste-skill", "palette picked"], ["design", "running", "Leo", undefined, undefined]]);
  assert.throws(() => store.advance("design-studio", "9", "done", "Dae"), (e: unknown) => e instanceof StudioError && e.code === "no_stage");
  assert.throws(() => store.advance("design-studio", "build", "shipped", "Dae"), (e: unknown) => e instanceof StudioError && e.code === "bad_status");
  store.advance("design-studio", "design", "done", "Leo"); store.advance("design-studio", "build", "done", "Max");
  assert.deepEqual(pipelineSummary(store.pipeline("design-studio")!), { stage: 3, of: 3, done: 3, status: "done", marks: ["done", "done", "done"] });
  assert.equal(store.remove("design-studio"), true);
  assert.equal(store.remove("design-studio"), false);
});

test("the tools: a session writes its own bot's counters (never another's), the pipeline tool reports stage k of n, failures follow the result contract", async () => {
  const { store } = mk();
  const [counter, pipeline] = createStudioTools({ store, botOf: (sid) => (sid === "s-olivia" ? "b_1" : "main"), nameOf: (id) => (id === "b_1" ? "Olivia" : "Dae") });
  assert.equal(counter.spec.name, "studio_counter"); assert.equal(pipeline.spec.name, "studio_pipeline");
  assert.equal(counter.class, "write");
  const r1 = await counter.run({ name: "applications", value: 389 }, { cwd: "/", sessionId: "s-olivia" } as any);
  assert.equal(r1.ok, true); assert.match(r1.output, /Olivia's counters: applications 389/);
  assert.deepEqual(store.counters("b_1").map((c) => c.name), ["applications"]);
  assert.deepEqual(store.counters("main"), []);
  for (const n of ["b", "c"]) await counter.run({ name: n, value: 1 }, { cwd: "/", sessionId: "s-olivia" } as any);
  const full = await counter.run({ name: "d", value: 1 }, { cwd: "/", sessionId: "s-olivia" } as any);
  assert.equal(full.ok, false); assert.equal(contractOf(full)?.status, "failed"); assert.match(contractOf(full)?.stop ?? "", /island is full/);
  const d = await pipeline.run({ action: "define", department: "Design", stages: [{ name: "style" }, { name: "review", bot: "reviewer" }] }, { cwd: "/", sessionId: "main-1" } as any);
  assert.equal(d.ok, true); assert.match(d.output, /pipeline for design: 1 style, 2 review → reviewer/);
  const a = await pipeline.run({ action: "advance", department: "design", stage: "style", status: "done", note: "ok" }, { cwd: "/", sessionId: "s-olivia" } as any);
  assert.match(a.output, /design: stage 2 of 2 \(review, todo\); 1 done/);
  assert.equal(store.pipeline("design")!.log.at(-1)!.by, "Olivia");
  const s = await pipeline.run({ action: "status", department: "design" }, { cwd: "/", sessionId: "x" } as any);
  assert.match(s.output, /1\. style: done – ok/);
  const missing = await pipeline.run({ action: "status", department: "nope" }, { cwd: "/", sessionId: "x" } as any);
  assert.equal(missing.ok, false); assert.match(contractOf(missing)?.next ?? "", /define/);
  assert.equal((await pipeline.run({ action: "dance", department: "design" }, { cwd: "/", sessionId: "x" } as any)).ok, false);
});

test("the floor shows counters and the pipeline on the island", () => {
  const { store } = mk();
  store.setCounter("b_1", "applications", 389); store.setCounter("b_2", "docs live", 8); store.setCounter("b_2", "x", 1); store.setCounter("b_2", "y", 2);
  store.define("Talent marketing", ["style", "design", "build"], "Dae"); store.advance("talent-marketing", "style", "done", "Dae");
  const v = assembleStudio({
    main: { name: "Dae" }, bots: [{ id: "b_1", slug: "o", name: "Olivia", department: "Talent marketing" }, { id: "b_2", slug: "l", name: "Leo", department: "Talent marketing" }],
    sessions: [], rows: [], pending: [], exchanges: [], chip: { mode: "off", model: "m" }, now: 5000, counters: store.allCounters(), pipelines: store.pipelines(),
  });
  const tm = v.departments.find((d) => d.slug === "talent-marketing")!;
  assert.equal(tm.counters.length, 3, "the newest three across the island's bots");
  assert.deepEqual(tm.pipeline, { stage: 2, of: 3, done: 1, current: "design", status: "todo", marks: ["done", "todo", "todo"] });
  assert.equal(v.pipelines.length, 1);
  assert.equal(v.pipelines[0].department, "talent-marketing");
  assert.deepEqual(v.bots.find((b) => b.id === "b_1")!.counters!.map((c) => [c.name, c.value]), [["applications", 389]]);
});
