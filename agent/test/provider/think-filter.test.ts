import { test } from "node:test";
import assert from "node:assert/strict";
import { ThinkFilter } from "../../src/provider/think-filter.ts";

const run = (chunks: string[]) => { const f = new ThinkFilter(); return chunks.map((c) => f.push(c)).join("") + f.flush(); };

test("think filter: drops an orphan closing tag (the 13:00 heartbeat leak)", () => {
  assert.equal(run(["</mm:think>Heartbeat — reads done."]), "Heartbeat — reads done.");
});
test("think filter: drops a whole think block, both tag styles", () => {
  assert.equal(run(["<think>plan the answer</think>Hello"]), "Hello");
  assert.equal(run(["A <mm:think>hidden</mm:think>B"]), "A B");
});
test("think filter: tags split across chunks", () => {
  assert.equal(run(["Hi <mm:th", "ink>secret</mm:", "think> there"]), "Hi  there");
  assert.equal(run(["</mm", ":think>Answer"]), "Answer");
});
test("think filter: ordinary text and lone '<' pass through", () => {
  assert.equal(run(["a < b and ", "x<y", " done"]), "a < b and x<y done");
  assert.equal(run(["ends with <"]), "ends with <");
});
