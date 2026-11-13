import { test } from "node:test";
import assert from "node:assert/strict";
import { argSummary, oneLine, ARG_MAX, BREAK_MARK } from "../../web/toolargs.js";

// A real one from the transcript: two lines, joined by the shell.
const MULTILINE = `export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"\ncd ~/code/ContentsCounter && npm test`;

test("a newline in a value is shown as a break, never hidden as a space", () => {
  assert.equal(oneLine("a\nb"), `a${BREAK_MARK}b`);
  assert.ok(oneLine("a\nb").includes("⏎"), "the break marker is visible");
  assert.notEqual(oneLine("a\nb"), "a b", "a bare space would read as one command");
});

test("the real two-line bash command keeps both lines readable", () => {
  const s = oneLine(MULTILINE);
  assert.ok(s.startsWith("export PATH="), "first line intact");
  assert.ok(s.includes("⏎"), "the break is marked");
  assert.ok(s.includes("cd ~/code/ContentsCounter && npm test"), "second line intact and joined by &&");
});

test("CRLF and lone CR count as one break each", () => {
  assert.equal(oneLine("a\r\nb"), `a${BREAK_MARK}b`);
  assert.equal(oneLine("a\rb"), `a${BREAK_MARK}b`);
});

test("runs of spaces and tabs collapse, newlines do not", () => {
  assert.equal(oneLine("a   \t b"), "a b");
  assert.equal(oneLine("a \n  b"), `a${BREAK_MARK}b`, "one space either side of a break is absorbed");
  assert.equal(oneLine("a\n\nb"), `a${BREAK_MARK}${BREAK_MARK}b`, "a blank line is two breaks");
});

test("non-strings still render, and objects survive", () => {
  assert.equal(oneLine(12), "12");
  assert.equal(oneLine(true), "true");
  assert.equal(oneLine({ a: 1 }), '{"a":1}');
  assert.equal(oneLine([]), "[]");
  assert.equal(oneLine(null), "null");
  assert.equal(oneLine({ toJSON() { throw new Error("boom"); } }), "[object Object]", "a throwing value degrades, never throws");
});

test("argSummary keeps the key=value shape and joins with two spaces", () => {
  assert.equal(argSummary({ cwd: "/x", mode: "r" }), "cwd=/x  mode=r");
  assert.equal(argSummary({ command: "a\nb" }), `command=a${BREAK_MARK}b`);
  assert.equal(argSummary({}), "");
  assert.equal(argSummary(), "");
  assert.equal(argSummary(null), "");
});

test("argSummary caps a long single value and a growing list", () => {
  const long = "x".repeat(400);
  const one = argSummary({ command: long });
  assert.ok(one.length <= ARG_MAX + 12, `one value stays near the cap, got ${one.length}`);
  assert.ok(one.endsWith("…"), "the cut is marked");
  assert.ok(!one.includes("  "), "a single value is not split");

  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v".repeat(20)]));
  const capped = argSummary(many);
  assert.ok(capped.length <= 130, `the whole summary is bounded, got ${capped.length}`);
  assert.ok(capped.startsWith("k0="), "and it keeps the first keys");
});

test("a value that fits its room is not truncated", () => {
  const room = ARG_MAX - "k".length - 1;      // the room argSummary gives a 1-char key
  assert.equal(argSummary({ k: "y".repeat(room) }), `k=${"y".repeat(room)}`, "exactly at the room is left alone");
  assert.equal(argSummary({ k: "y".repeat(room + 1) }).endsWith("…"), true, "one over is cut");
  assert.equal(oneLine("z".repeat(10)), "z".repeat(10), "oneLine itself has no cap");
});

test("no newline survives into the summary", () => {
  const s = argSummary({ command: "a\nb\nc" });
  assert.ok(!/[\n\r]/.test(s), "the row is genuinely one line");
});
