import { test } from "node:test";
import assert from "node:assert/strict";
import { DAE_DEFINITIONS, DAE_STOCK, LATEST_DAE_VERSION, daeBase } from "../../src/bots/dae.ts";
import { promptInjectionProblem } from "../../src/learn/guard.ts";

test("the stock Dae definition: director role, sizes work, delegates, verifies, records; passes its own guard", () => {
  const b = daeBase();
  assert.equal(b, DAE_DEFINITIONS[LATEST_DAE_VERSION].base);
  assert.equal(daeBase(999), b);
  for (const must of ["Director of Engineering and Automations", "trivial, small, standard or large", "bot_talk", "handoff card", "receipt", "MIND", "secure documents", "Never:"]) assert.ok(b.includes(must), must);
  assert.equal(promptInjectionProblem(b), null);
  assert.ok(b.length < 4000, "short enough to sit in every main prompt");
  assert.equal(DAE_STOCK.name, "Dae");
});
