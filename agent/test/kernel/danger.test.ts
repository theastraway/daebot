import { test } from "node:test";
import assert from "node:assert/strict";
import { dangerGate, grantIfAffirmed } from "../../src/kernel/danger.ts";
import { callSignature } from "../../src/kernel/util.ts";
import { call, state, tool } from "./helpers.ts";

const send = tool("send_email", "outward");
const args = { to: "a@b.co", body: "hi" };

test("danger: outward tool needs confirmation and registers pending", () => {
  const s = state();
  const v = dangerGate.preTool!(s, call("send_email", args), send);
  assert.equal(v?.action, "needs-confirmation");
  assert.equal(s.confirmations.length, 1);
  assert.equal(s.confirmations[0].forCallSignature, callSignature("send_email", args));
});
test("danger: read and write tools pass", () => {
  assert.equal(dangerGate.preTool!(state(), call("x"), tool("x", "read")), undefined);
  assert.equal(dangerGate.preTool!(state(), call("x"), tool("x", "write")), undefined);
});
test("danger: signature is stable across key order", () => {
  assert.equal(callSignature("t", { a: 1, b: { c: 2, d: 3 } }), callSignature("t", { b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(callSignature("t", { a: 1 }), callSignature("t", { a: 2 }));
});
test("danger: 'send it' on a LATER message grants and the call proceeds", () => {
  const s = state({ userMessageIndex: 1 });
  dangerGate.preTool!(s, call("send_email", args), send);
  s.userMessageIndex = 2; s.userMessage = "send it";
  assert.equal(grantIfAffirmed(s, "send it").length, 1);
  assert.equal(dangerGate.preTool!(s, call("send_email", args), send), undefined);
});
test("danger: goal approval does not grant an action", () => {
  const s = state({ userMessageIndex: 1 });
  dangerGate.preTool!(s, call("send_email", args), send);
  s.userMessageIndex = 2;
  assert.equal(grantIfAffirmed(s, "yes make it his account").length, 0);
  assert.equal(dangerGate.preTool!(s, call("send_email", args), send)?.action, "needs-confirmation");
});
test("danger: 'send it' BEFORE the proposal does not grant", () => {
  const s = state({ userMessageIndex: 1, userMessage: "send it" });
  assert.equal(grantIfAffirmed(s, "send it").length, 0);   // nothing pending yet
  assert.equal(dangerGate.preTool!(s, call("send_email", args), send)?.action, "needs-confirmation");
  // same message index cannot grant what was proposed on it
  assert.equal(grantIfAffirmed(s, "send it").length, 0);
});
test("danger: confirmation for different args does not apply", () => {
  const s = state({ userMessageIndex: 1 });
  dangerGate.preTool!(s, call("send_email", args), send);
  s.userMessageIndex = 2;
  grantIfAffirmed(s, "do it");
  assert.equal(dangerGate.preTool!(s, call("send_email", { to: "other@x.co" }), send)?.action, "needs-confirmation");
});
test("danger: forged confirmation with grantedAt <= proposedAt does not count", () => {
  const s = state({ userMessageIndex: 3 });
  s.confirmations.push({ forCallSignature: callSignature("send_email", args), proposedAtUserMsg: 3, grantedAtUserMsg: 3 });
  assert.equal(dangerGate.preTool!(s, call("send_email", args), send)?.action, "needs-confirmation");
});
test("danger: action phrases", () => {
  for (const m of ["do it now", "go ahead", "yes, run it", "yes send that", "run it now", "approved: send", "confirmed"]) {
    const s = state({ userMessageIndex: 1 });
    dangerGate.preTool!(s, call("send_email", args), send);
    s.userMessageIndex = 2;
    assert.equal(grantIfAffirmed(s, m).length, 1, m);
  }
  for (const m of ["sounds good", "yes", "ok cool", "give him access"]) {
    const s = state({ userMessageIndex: 1 });
    dangerGate.preTool!(s, call("send_email", args), send);
    s.userMessageIndex = 2;
    assert.equal(grantIfAffirmed(s, m).length, 0, m);
  }
});
test("danger: irreversible class also gated", () => {
  assert.equal(dangerGate.preTool!(state(), call("rm_db"), tool("rm_db", "irreversible"))?.action, "needs-confirmation");
});
