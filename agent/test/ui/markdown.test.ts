import { test } from "node:test";
import assert from "node:assert/strict";
import { MdStream, renderInline, renderMarkdown } from "../../src/ui/markdown.ts";
import { createStyler, stripAnsi, visibleWidth, wrapLine, truncate, colorEnabled } from "../../src/ui/ansi.ts";

const plain = { width: 40, color: false };
const color = { width: 40, color: true };

test("inline: code, bold, italic, links in plain mode keep readable text", () => {
  const st = createStyler(false);
  assert.equal(renderInline("use `npm test` now", st), "use `npm test` now");
  assert.equal(renderInline("a **bold** and *it* word", st), "a bold and it word");
  assert.equal(renderInline("see [docs](https://x.io/a) ok", st), "see docs (https://x.io/a) ok");
  assert.equal(renderInline("snake_case_name stays", st), "snake_case_name stays");
  assert.equal(renderInline("2 * 3 * 4", st), "2 * 3 * 4");
});

test("inline: colour mode emits SGR for bold/code/link", () => {
  const st = createStyler(true);
  const out = renderInline("**b** `c` [l](http://u)", st);
  assert.match(out, /\x1b\[1mb\x1b\[22m/);
  assert.match(out, /\x1b\[33mc\x1b\[39m/);
  assert.match(out, /\x1b\[4m/);
  assert.equal(stripAnsi(out), "b c l (http://u)");
});

test("code fence renders with a left rule and does not interpret markdown inside", () => {
  const lines = renderMarkdown("before\n```ts\nconst a = **x**;\n```\nafter", plain);
  assert.deepEqual(lines, ["before", "╭─ ts", "│ const a = **x**;", "╰─", "after"]);
});

test("unterminated fence is closed at the end", () => {
  const lines = renderMarkdown("```\ncode", plain);
  assert.equal(lines[lines.length - 1], "╰─");
});

test("long code lines hard-wrap and keep the rule on every row", () => {
  const lines = renderMarkdown("```\n" + "x".repeat(70) + "\n```", { width: 30, color: false });
  const body = lines.slice(1, -1);
  assert.ok(body.length >= 3);
  for (const l of body) { assert.ok(l.startsWith("│ ")); assert.ok(visibleWidth(l) <= 30); }
});

test("headings, bullets (with hanging indent), numbered lists, quotes, rules", () => {
  const md = "# Title\n\n- one two three four five six seven eight nine ten eleven twelve\n1. first\n> quoted\n---";
  const lines = renderMarkdown(md, { width: 30, color: false });
  assert.equal(lines[0], "Title");
  assert.equal(lines[2], "• one two three four five six");
  assert.ok(lines[3].startsWith("  seven"), `hanging indent, got ${JSON.stringify(lines[3])}`);
  assert.ok(lines.includes("1 first".replace(" ", ". ").replace(". ", " ")) || lines.some((l) => l.startsWith("1. first")));
  assert.ok(lines.some((l) => l === "▎ quoted"));
  assert.ok(lines.some((l) => /^─+$/.test(l)));
});

test("ascii option swaps box drawing for ascii", () => {
  const lines = renderMarkdown("```\nx\n```\n- a", { width: 30, color: false, ascii: true });
  assert.deepEqual(lines, ["+-", "| x", "+-", "* a"]);
});

test("wrapping never exceeds width and preserves styles across breaks", () => {
  const st = createStyler(true);
  const text = st.bold("alpha beta gamma delta epsilon zeta eta theta") + " tail";
  const lines = wrapLine(text, 16);
  assert.ok(lines.length >= 3);
  for (const l of lines) assert.ok(visibleWidth(l) <= 16, l);
  // every wrapped line of the bold span re-opens bold and closes it
  assert.match(lines[1], /^\x1b\[1m/);
  assert.match(lines[0], /\x1b\[0m$/);
  assert.equal(stripAnsi(lines.join(" ")), "alpha beta gamma delta epsilon zeta eta theta tail");
});

test("a word longer than the line is hard-broken", () => {
  const lines = wrapLine("a " + "z".repeat(25) + " b", 10);
  for (const l of lines) assert.ok(visibleWidth(l) <= 10, l);
  assert.equal(lines.join("").replace(/ /g, ""), "a" + "z".repeat(25) + "b");
});

test("truncate keeps ANSI balanced and adds an ellipsis", () => {
  const st = createStyler(true);
  const out = truncate(st.red("abcdefghijklmnop"), 8);
  assert.ok(visibleWidth(out) <= 8);
  assert.ok(stripAnsi(out).endsWith("…"));
  assert.match(out, /\x1b\[0m/);
});

test("visibleWidth counts wide characters as two cells", () => {
  assert.equal(visibleWidth("漢字"), 4);
  assert.equal(visibleWidth("\x1b[31mab\x1b[0m"), 2);
});

test("NO_COLOR and non-TTY disable colour", () => {
  assert.equal(colorEnabled({}, true), true);
  assert.equal(colorEnabled({ NO_COLOR: "1" }, true), false);
  assert.equal(colorEnabled({}, false), false);
  assert.equal(colorEnabled({ TERM: "dumb" }, true), false);
  assert.equal(createStyler(false).bold("x"), "x");
});

test("MdStream: streams complete lines only, tail is pending, split fences work across deltas", () => {
  const s = new MdStream(plain);
  assert.deepEqual(s.push("Hello **wor"), []);
  assert.deepEqual(s.pending(), ["Hello **wor"]);
  assert.deepEqual(s.push("ld**\n``"), ["Hello world"]);
  assert.deepEqual(s.push("`js\nlet a;\n"), ["╭─ js", "│ let a;"]);
  assert.deepEqual(s.push("```\ndone"), ["╰─"]);
  assert.deepEqual(s.flush(), ["done"]);
  assert.equal(s.hasPending(), false);
});

test("MdStream result equals one-shot renderMarkdown regardless of chunking", () => {
  const doc = "# H\n\ntext with `code` and **bold**\n\n```py\nprint(1)\n```\n\n- a\n- b\n";
  const whole = renderMarkdown(doc, color);
  const s = new MdStream(color);
  const out: string[] = [];
  for (const ch of doc) out.push(...s.push(ch));
  out.push(...s.flush());
  while (out.length && out[out.length - 1] === "") out.pop();
  assert.deepEqual(out, whole);
});
