import { test } from "node:test";
import assert from "node:assert/strict";
import { bootGate } from "../../src/kernel/boot.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { call, state, tool } from "./helpers.ts";

test("boot: blocks non-boot tool before boot", () => {
  const v = bootGate.preTool!(state({ booted: false }), call("bash"), tool("bash"));
  assert.equal(v?.action, "block");
  assert.equal(v?.reason, "boot first: call mind_context");
});
test("boot: allows mind_context/sense/profile before boot", () => {
  for (const n of ["mind_context", "mind_sense", "mind_profile"]) {
    assert.equal(bootGate.preTool!(state({ booted: false }), call(n), tool(n)), undefined);
  }
});
test("boot: allows everything after boot", () => {
  assert.equal(bootGate.preTool!(state(), call("bash"), tool("bash")), undefined);
});
test("boot: allowedTools filters before boot only", () => {
  const k = createKernel({ shadow: false, enabled: true });
  const all = [tool("bash"), tool("mind_context"), tool("mind_query"), tool("mind_sense"), tool("mind_profile")];
  assert.deepEqual(k.allowedTools(state({ booted: false }), all).map((t) => t.spec.name), ["mind_context", "mind_sense", "mind_profile"]);
  assert.equal(k.allowedTools(state(), all).length, 5);
});
