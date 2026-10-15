import { test } from "node:test";
import assert from "node:assert/strict";
import { UNVERIFIED_FOOTER } from "../../src/loop.ts";
import { detectTriggers, isMultiStepSuccess, looksLikeCorrection, turnWentBadly } from "../../src/learn/triggers.ts";
import type { CallRecord, Violation } from "../../src/types.ts";
import type { TurnSummary } from "../../src/learn/types.ts";

const rec = (tool: string, ok = true, out = "fine"): CallRecord => ({
  receiptId: "c1", call: { id: "1", name: tool, args: {} }, tool, class: "read", result: { ok, output: out }, at: 0,
});
const viol = (over: Partial<Violation> = {}): Violation => ({ at: 1, sessionId: "s", gate: "receipt", action: "block", reason: "needs a receipt", enforced: true, ...over });
const turn = (over: Partial<TurnSummary> = {}): TurnSummary => ({
  sessionId: "s", userMessage: "do the thing", finalText: "ok", userHistory: [], calls: [], violations: [], failed: false, ...over,
});

test("corrections: explicit no/wrong/stop, restated asks, anger, repeated instruction", () => {
  for (const m of ["No, that's not what I asked", "wrong. use grep first", "That is wrong", "I told you to keep it short", "you keep adding bullets",
    "why did you open the file first", "don't use markdown here", "stop adding preambles", "try again", "THAT IS NOT WHAT I WANTED", "this is useless!!"]) {
    assert.equal(looksLikeCorrection(m), true, m);
  }
});

test("corrections: ordinary messages are not corrections", () => {
  for (const m of ["What is the status of the deploy?", "Add a changelog entry", "thanks, looks good", "yes please", "now draft the email", "I know nothing about that", "notes from the call attached"]) {
    assert.equal(looksLikeCorrection(m), false, m);
  }
});

test("corrections: the same instruction repeated is a correction, a different one is not", () => {
  const h = ["Please summarize the meeting notes into three bullets"];
  assert.equal(looksLikeCorrection("Please summarize the meeting notes into three bullets", h), true);
  assert.equal(looksLikeCorrection("Draft the follow-up email for the client", h), false);
  assert.equal(looksLikeCorrection("short ask", ["short ask"]), false, "short messages are not judged on repetition");
});

test("triggers: kernel block, tool failure, correction, multi-step success", () => {
  assert.deepEqual(detectTriggers(turn({ violations: [viol()] })).map((t) => t.kind), ["kernel_block"]);
  assert.deepEqual(detectTriggers(turn({ violations: [viol({ enforced: false })] })).map((t) => t.kind), [], "shadow violations are not blocks");
  assert.deepEqual(detectTriggers(turn({ violations: [viol({ action: "needs-confirmation", gate: "danger" })] })).map((t) => t.kind), [], "a confirmation prompt is normal flow");
  assert.deepEqual(detectTriggers(turn({ finalText: `x\n${UNVERIFIED_FOOTER}` })).map((t) => t.kind), ["kernel_block"]);
  const fail = detectTriggers(turn({ calls: [rec("bash", false, "exit 2: no such file")] }));
  assert.equal(fail[0].kind, "tool_failure");
  assert.match(fail[0].detail, /bash: exit 2/);
  assert.deepEqual(detectTriggers(turn({ userMessage: "No, wrong." })).map((t) => t.kind), ["user_correction"]);
  assert.deepEqual(detectTriggers(turn({ calls: [rec("grep"), rec("read_file"), rec("write_file")] })).map((t) => t.kind), ["multi_step_success"]);
  assert.deepEqual(detectTriggers(turn()).map((t) => t.kind), [], "a plain turn triggers nothing");
});

test("multi-step success needs 3+ real calls, 2+ tools, no failure, no block, a real answer", () => {
  const three = [rec("grep"), rec("read_file"), rec("edit_file")];
  assert.equal(isMultiStepSuccess(turn({ calls: three })), true);
  assert.equal(isMultiStepSuccess(turn({ calls: [rec("grep"), rec("grep"), rec("grep")] })), false, "one tool only");
  assert.equal(isMultiStepSuccess(turn({ calls: [rec("mind_context"), rec("mind_sense"), rec("grep"), rec("read_file")] })), false, "boot calls do not count");
  assert.equal(isMultiStepSuccess(turn({ calls: [...three, rec("bash", false)] })), false);
  assert.equal(isMultiStepSuccess(turn({ calls: three, violations: [viol()] })), false);
  assert.equal(isMultiStepSuccess(turn({ calls: three, finalText: "" })), false);
  assert.equal(isMultiStepSuccess(turn({ calls: three, failed: true })), false);
});

test("turnWentBadly: failure, block, unverified footer or errored turn", () => {
  assert.equal(turnWentBadly(turn()), false);
  assert.equal(turnWentBadly(turn({ calls: [rec("bash", false)] })), true);
  assert.equal(turnWentBadly(turn({ violations: [viol()] })), true);
  assert.equal(turnWentBadly(turn({ failed: true })), true);
});
