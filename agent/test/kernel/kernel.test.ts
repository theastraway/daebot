import { test } from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../../src/kernel/index.ts";
import type { Violation } from "../../src/types.ts";
import { call, state, tool } from "./helpers.ts";

test("kernel disabled: allows everything", () => {
  const k = createKernel({ shadow: false, enabled: false });
  const s = state({ booted: false });
  const all = [tool("bash"), tool("feed_post", "public")];
  assert.equal(k.allowedTools(s, all).length, 2);
  assert.deepEqual(k.preTool(s, call("bash"), tool("bash")), []);
  assert.deepEqual(k.preAnswer(s, "It is done and costs $5."), []);
  assert.equal(k.violations().length, 0);
});
test("kernel enforced: records enforced violation and returns block", () => {
  const seen: Violation[] = [];
  const k = createKernel({ shadow: false, enabled: true, onViolation: (v) => seen.push(v) });
  const out = k.preTool(state({ booted: false }), call("bash"), tool("bash"));
  assert.equal(out[0].action, "block");
  assert.equal(k.violations()[0].enforced, true);
  assert.equal(seen.length, 1);
});
test("kernel shadow: logs enforced:false and returns allow", () => {
  const k = createKernel({ shadow: true, enabled: true });
  const out = k.preAnswer(state(), "The page is done.");
  assert.equal(out.length, 1);
  assert.equal(out[0].action, "allow");
  const v = k.violations();
  assert.equal(v.length, 1);
  assert.equal(v[0].enforced, false);
  assert.equal(v[0].action, "block");
  assert.equal(v[0].gate, "receipt");
});
test("kernel shadow: allowedTools returns all", () => {
  const k = createKernel({ shadow: true, enabled: true });
  assert.equal(k.allowedTools(state({ booted: false }), [tool("bash"), tool("x", "public")]).length, 2);
});
test("kernel: gate order boot, feed, owner, danger", () => {
  const k = createKernel({ shadow: false, enabled: true });
  const t = tool("mind_remember", "public");
  const out = k.preTool(state({ booted: false, userMessage: "hi" }), call("mind_remember", {}), t);
  assert.deepEqual(out.map((v) => v.gate), ["boot", "feed", "owner"]);
});
test("kernel: allow path returns empty list", () => {
  const k = createKernel({ shadow: false, enabled: true });
  assert.deepEqual(k.preTool(state(), call("mind_query"), tool("mind_query")), []);
  assert.deepEqual(k.preAnswer(state(), "Happy to help."), []);
});
test("kernel: violation log capped at 1000", () => {
  const k = createKernel({ shadow: false, enabled: true });
  for (let i = 0; i < 1100; i++) k.preAnswer(state(), "It is done.");
  assert.equal(k.violations().length, 1000);
});
test("kernel: state.shadow also downgrades", () => {
  const k = createKernel({ shadow: false, enabled: true });
  const out = k.preAnswer(state({ shadow: true }), "It is done.");
  assert.equal(out[0].action, "allow");
  assert.equal(k.violations()[0].enforced, false);
});
