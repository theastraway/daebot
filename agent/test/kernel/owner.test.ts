import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerGate } from "../../src/kernel/owner.ts";
import { call, state, tool } from "./helpers.ts";

const run = (name: string, args: Record<string, unknown>) => ownerGate.preTool!(state(), call(name, args), tool(name, "write"));

test("owner: write without owner_check blocks", () => {
  const v = run("mind_remember", { title: "x" });
  assert.equal(v?.action, "block");
  assert.match(v!.reason, /^owner check failed/);
});
test("owner: matching entities pass", () => {
  assert.equal(run("mind_remember", { owner_check: "SOP doc belongs to Atlas; Anthony asked about Atlas; Atlas == Atlas" }), undefined);
});
test("owner: normalization ignores case and punctuation", () => {
  assert.equal(run("mind_folders", { action: "create", owner_check: "x belongs to Astra AI; Anthony asked about astra-ai; Astra AI == astra-ai" }), undefined);
});
test("owner: mismatched entities block", () => {
  const v = run("mind_remember", { owner_check: "claims SOP belongs to Atlas; Anthony asked about Astra AI; Atlas == Astra AI" });
  assert.equal(v?.action, "block");
});
test("owner: simple A == B form", () => {
  assert.equal(run("mind_crm", { action: "create", owner_check: "Atlas == Atlas" }), undefined);
  assert.equal(run("mind_crm", { action: "create", owner_check: "Atlas == Mike" })?.action, "block");
});
test("owner: empty side blocks", () => {
  assert.equal(run("mind_life", { action: "create", owner_check: "Atlas ==" })?.action, "block");
  assert.equal(run("mind_life", { action: "create", owner_check: "== Atlas" })?.action, "block");
  assert.equal(run("mind_life", { action: "create", owner_check: "no equals sign" })?.action, "block");
});
test("owner: non-string owner_check blocks", () => {
  assert.equal(run("mind_checklists", { action: "create", owner_check: 5 })?.action, "block");
});
test("owner: read-only actions skip the check", () => {
  for (const a of ["list", "get", "search"]) assert.equal(run("mind_folders", { action: a }), undefined, a);
});
test("owner: other tools skipped", () => {
  assert.equal(run("mind_query", {}), undefined);
});
