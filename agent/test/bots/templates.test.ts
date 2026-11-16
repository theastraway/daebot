import { test } from "node:test";
import assert from "node:assert/strict";
import { BOT_TEMPLATES, listTemplates, templateOf } from "../../src/bots/templates.ts";
import { promptInjectionProblem } from "../../src/learn/guard.ts";
import { parseCard } from "../../src/bots/talk-tool.ts";
import { renderHandoffCard } from "../../src/bots/bus.ts";

test("the reviewer template: short, clean, on the reasoner tier, in the house shape", () => {
  const t = templateOf("Reviewer")!;
  assert.equal(t.slug, "reviewer");
  assert.equal(t.tier, "reasoner");
  for (const h of ["# Role", "# How you work", "# Never"]) assert.ok(t.instructions.includes(h), h);
  assert.ok(t.instructions.includes("review skill"));
  assert.ok(Buffer.byteLength(t.instructions, "utf8") < 8 * 1024);
  assert.equal(promptInjectionProblem(t.instructions), null);
  assert.deepEqual(listTemplates().map((x) => x.id), Object.keys(BOT_TEMPLATES));
  assert.equal(templateOf("nope"), undefined);
});

test("handoff card: parsed from the model's object, rendered as five labelled lines with the tier, bad shapes refused", () => {
  const c = parseCard({ objective: "add the /routing endpoint", evidence: ["gateway/index.ts has /board", 7], left: ["route", "test"], next: "write the handler", verify: "node --test test/gateway", tier: "coder" })!;
  assert.equal(c.tier, "coder");
  assert.deepEqual(c.evidence, ["gateway/index.ts has /board"]);
  const text = renderHandoffCard(c);
  assert.match(text, /^\[Handoff card \(run this on the coder tier\)\]/);
  for (const h of ["Objective:", "Evidence so far:", "What is left:", "Next action:", "How to verify:"]) assert.ok(text.includes(h), h);
  assert.ok(text.includes("  - route"));
  assert.equal(parseCard({ objective: "x" }), undefined, "next is required");
  assert.equal(parseCard("nope"), undefined);
  assert.equal(parseCard({ objective: "x", next: "y", tier: "god" })!.tier, undefined, "an unknown tier is dropped, not guessed");
});
