import { test } from "node:test";
import assert from "node:assert/strict";
import { createFactGate, factGateMode, factQuestions, factsGathered } from "../../src/kernel/fact.ts";
import { runFactEval, renderFactEval } from "../../src/eval/fact/run.ts";
import type { Tool, TurnState } from "../../src/types.ts";

const tool = (name: string): Tool => ({ spec: { name, description: "", parameters: {} }, class: "write", async run() { return { ok: true, output: "" }; } });
const state = (): TurnState => ({ sessionId: "s", booted: true, turnIndex: 1, userMessage: "", userMessageIndex: 1, calls: [], allCalls: [], confirmations: [], shadow: false });
const rec = (toolName: string, args: Record<string, unknown>) => ({ receiptId: "c1", call: { id: "1", name: toolName, args }, tool: toolName, class: "read" as const, result: { ok: true, output: "" }, at: 1 });

test("factQuestions: code gets importers/local callers/duplicate/tests; data gets shape and readers; config gets keys and secrets", () => {
  assert.ok(factQuestions("/p/src/dates.ts").some((q) => /imports this module/.test(q)));
  assert.ok(factQuestions("/p/data/orders.csv").some((q) => /separators/.test(q)));
  assert.ok(factQuestions("/p/config.yaml").some((q) => /secret store/.test(q)));
  assert.equal(factQuestions("/p/src/x.test.ts").length, 1);
});

test("factsGathered: a read, a grep for the stem, or a command naming the file counts; unrelated reads do not", () => {
  assert.equal(factsGathered([rec("read_file", { path: "/p/src/dates.ts" })], "/p/src/dates.ts"), true);
  assert.equal(factsGathered([rec("grep", { pattern: "parseDate", path: "." })], "/p/src/dates.ts"), false, "a grep for a symbol is not a grep for the file");
  assert.equal(factsGathered([rec("grep", { pattern: "dates" })], "/p/src/dates.ts"), true);
  assert.equal(factsGathered([rec("bash", { command: "cat src/dates.ts | head" })], "/p/src/dates.ts"), true);
  assert.equal(factsGathered([rec("read_file", { path: "/p/other.ts" })], "/p/src/dates.ts"), false);
});

test("the gate: refuses the first blind edit with the questions, lets the retry through, never gates a new file; placebo asks nothing", () => {
  const g = createFactGate({ mode: "enforce", exists: (p) => p.endsWith("dates.ts") });
  const s = state();
  const edit = { id: "1", name: "edit_file", args: { path: "/p/src/dates.ts", old_string: "a", new_string: "b" } };
  const v = g.preTool!(s, edit, tool("edit_file"));
  assert.equal(v?.action, "block");
  assert.match(v!.reason, /Who imports this module/);
  assert.equal(g.preTool!(s, edit, tool("edit_file")), undefined, "asked once per file per turn: the retry goes through");
  const s2 = state(); s2.turnIndex = 2; s2.calls.push(rec("read_file", { path: "/p/src/dates.ts" }));
  assert.equal(g.preTool!(s2, edit, tool("edit_file")), undefined, "facts gathered: no refusal");
  assert.equal(g.preTool!(state(), { id: "2", name: "write_file", args: { path: "/p/new.ts", content: "" } }, tool("write_file")), undefined, "a new file is never gated");
  const placebo = createFactGate({ mode: "enforce", exists: () => true, placebo: true });
  const pv = placebo.preTool!(state(), edit, tool("edit_file"));
  assert.equal(pv?.gate, "fact-placebo");
  assert.ok(!/imports/.test(pv!.reason));
  assert.equal(factGateMode({}), "off");
  assert.equal(factGateMode({ DAEBOT_FACT_GATE: "shadow" }), "shadow");
});

test("fact eval: the six traps on off, placebo and fact; the fact arm passes every trap, off passes none; the verdict is published", async () => {
  const r = await runFactEval();
  const by = Object.fromEntries(r.arms.map((a) => [a.arm, a]));
  assert.equal(by.off.passed, 0, "the naive model edits blind with no gate");
  assert.equal(by.fact.passed, 6, "every refusal was followed by the reads the questions named");
  assert.equal(by.fact.refusals, 6);
  assert.equal(by.placebo.passed, 6, "with a scripted model the placebo arm also recovers: the offline run measures compliance, not quality");
  assert.ok(["inconclusive", "ship", "do-not-ship"].includes(r.verdict));
  assert.match(renderFactEval(r), /fact\s+6\/6 passed/);
});
