import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, runScenario } from "../../src/eval/runner.ts";
import { ALL_SCENARIOS, bad, legit } from "../../src/eval/scenarios/index.ts";
import { MODES } from "../../src/eval/types.ts";

const get = (id: string) => {
  const s = ALL_SCENARIOS.find((x) => x.id === id);
  assert.ok(s, id);
  return s;
};

test("smoke: B01 boot skipped is caught when enforced and the model recovers by booting", async () => {
  const sc = get("B01-boot-skipped");
  const off = classify(sc, "off", await runScenario(sc, "off"));
  const enf = classify(sc, "enforced", await runScenario(sc, "enforced"));
  assert.equal(off.outcome, "MISSED");
  assert.equal(enf.outcome, "CAUGHT");
  assert.equal(enf.recovered, true);
});

test("smoke: B10 approving the goal never sends; L04 explicit 'send it' does", async () => {
  const b = get("B10-goal-approval-is-not-action");
  const rb = await runScenario(b, "enforced");
  assert.equal(rb.exec.some((e) => e.tool === "send_email"), false);
  assert.equal(classify(b, "enforced", rb).outcome, "CAUGHT");
  const l = get("L04-confirmed-send");
  const rl = await runScenario(l, "enforced");
  assert.equal(rl.exec.some((e) => e.tool === "send_email" && e.turn === 1), true);
  assert.equal(classify(l, "enforced", rl).outcome, "OK");
});

test("smoke: B07 MIND prefix on a surface call is rejected, SURFACE citation ships", async () => {
  const sc = get("B07-mind-prefix-on-surface-call");
  const r = await runScenario(sc, "enforced");
  assert.match(r.finalTexts[0], /SURFACE✓ #c1/);
  assert.equal(classify(sc, "enforced", r).outcome, "CAUGHT");
  assert.equal(classify(sc, "enforced", r).recovered, true);
});

test("harness validity: scenario ids are unique and the required mix exists", () => {
  assert.equal(new Set(ALL_SCENARIOS.map((s) => s.id)).size, ALL_SCENARIOS.length);
  assert.ok(bad.length >= 14, `bad=${bad.length}`);
  assert.ok(legit.length >= 15, `legit=${legit.length}`);
  for (const s of [...bad, ...ALL_SCENARIOS.filter((x) => x.kind === "probe")]) {
    assert.ok(s.bad && s.expectGate, `${s.id} needs bad() and expectGate`);
    assert.ok(s.cites.length > 20, `${s.id} must cite the historical failure`);
  }
});

test("harness validity: with the kernel off every bad outcome happens and every legit script meets its own expectation", async () => {
  for (const s of ALL_SCENARIOS) {
    const r = await runScenario(s, "off");
    assert.equal(r.error, undefined, `${s.id}: ${r.error}`);
    const c = classify(s, "off", r);
    if (s.kind === "legit") assert.equal(c.outcome, "OK", `${s.id}: ${c.note}`);
    else assert.equal(c.badHappened, true, `${s.id}: bad outcome did not happen with the kernel off (script bug)`);
  }
});

test("harness validity: no BROKEN runs in any mode", async () => {
  for (const s of ALL_SCENARIOS) for (const m of MODES) {
    const c = classify(s, m, await runScenario(s, m));
    assert.notEqual(c.outcome, "BROKEN", `${s.id} ${m}: ${c.note}`);
  }
});
