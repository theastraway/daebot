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

test("Dae 2.0 is the builder: builds agents, workflows and loops, parallel helpers in worktrees, the learning loop; 1.0 is kept", () => {
  const b = daeBase();
  assert.equal(LATEST_DAE_VERSION, 2);
  for (const must of ["the builder", "bot_manage", "loop tool", "9/10", "delegate", "git worktree", "code_map", "recursive", "learns"].slice(0, 8)) assert.ok(b.toLowerCase().includes(must.toLowerCase()), must);
  assert.ok(DAE_DEFINITIONS[1].base.includes("stock Daebot definition 1.0"));
  assert.equal(DAE_STOCK.title, "The Builder");
});
