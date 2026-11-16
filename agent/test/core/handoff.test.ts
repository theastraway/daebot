import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHandoff, compactMessages } from "../../src/compact.ts";
import type { Message, Provider, StreamEvent } from "../../src/types.ts";

const CARD = ["Objective: ship the routing endpoint", "Evidence:", "- gateway/index.ts has /board", "- tests pass", "What is left:", "- the /routing handler", "Next action: write the handler next to /board", "How to verify: node --test test/gateway/routing.test.ts"].join("\n");

test("parseHandoff: the five headings become a card; a free-form summary does not", () => {
  const c = parseHandoff(CARD, 5)!;
  assert.equal(c.objective, "ship the routing endpoint");
  assert.deepEqual(c.evidence, ["gateway/index.ts has /board", "tests pass"]);
  assert.deepEqual(c.left, ["the /routing handler"]);
  assert.equal(c.next, "write the handler next to /board");
  assert.equal(c.verify, "node --test test/gateway/routing.test.ts");
  assert.equal(c.at, 5);
  assert.equal(parseHandoff("The user asked for things and we did some of them."), undefined);
  assert.equal(parseHandoff("## Objective\nx"), undefined, "no next action: no card");
});

test("compactMessages: the summary in card shape is returned as a card and sits in the summary note", async () => {
  const provider: Provider = { name: "fake", async *stream(): AsyncIterable<StreamEvent> { yield { type: "text", delta: CARD }; yield { type: "done", usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 }, finishReason: "stop" }; } };
  const messages: Message[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 12; i++) { messages.push({ role: "user", content: `ask ${i}` }, { role: "assistant", content: `MIND✓ #c${i} did ${i}` }); }
  const r = (await compactMessages(messages, { provider, model: "m", keepTurns: 2 }))!;
  assert.ok(r.card);
  assert.equal(r.card!.objective, "ship the routing endpoint");
  assert.ok(r.messages[1].content.includes("Next action: write the handler"));
  assert.ok(r.messages[1].content.includes("MIND✓ #c0"), "receipts survive");
});
