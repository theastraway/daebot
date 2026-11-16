import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { proofChips } from "../../web/board.js";

test("proof chips: verified or unverified (yellow), counts, model with the router's reason as tooltip", () => {
  const ok = proofChips({ at: 1, calls: 3, failed: 0, blocked: 0, unverified: false, verified: true, model: "x/m", effort: "high", route: "shadow: coder (small fix)" });
  assert.deepEqual(ok.map((c: any) => [c.cls, c.text]), [["ok", "Verified"], ["", "3 calls"], ["model", "x/m · high"]]);
  assert.match(ok[2].title, /Router: shadow: coder/);
  const bad = proofChips({ at: 1, calls: 1, failed: 1, blocked: 2, unverified: true, verified: false });
  assert.deepEqual(bad.map((c: any) => [c.cls, c.text]), [["warn", "Unverified answer"], ["", "1 call"], ["warn", "1 failed"], ["warn", "2 blocked"]]);
  assert.deepEqual(proofChips(undefined), []);
  assert.equal(proofChips({ calls: 0, verified: false, unverified: false })[0].text, "No final answer");
});
