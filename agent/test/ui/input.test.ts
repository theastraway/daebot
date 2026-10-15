import { test } from "node:test";
import assert from "node:assert/strict";
import { applyKey, editorText, insertText, newEditor, parseKeys, setEditorText } from "../../src/ui/input.ts";
import type { EditorState, Key } from "../../src/ui/input.ts";

function type(s: EditorState, text: string): EditorState { return applyKey(s, { name: "char", text }).state; }
function press(s: EditorState, ...keys: Key[]): { state: EditorState; actions: string[] } {
  const actions: string[] = [];
  for (const k of keys) { const r = applyKey(s, k); s = r.state; if (r.action) actions.push(r.action.type + (r.action.type === "submit" ? ":" + r.action.text : "")); }
  return { state: s, actions };
}
const k = (name: string, extra: Partial<Key> = {}): Key => ({ name, ...extra });

test("typing inserts at the cursor and moves it", () => {
  let s = type(newEditor(), "hello");
  s = press(s, k("left"), k("left")).state;
  s = type(s, "XY");
  assert.equal(editorText(s), "helXYlo");
  assert.equal(s.col, 5);
});

test("Enter submits and resets; Shift+Enter and Alt+Enter insert a newline", () => {
  let s = type(newEditor(), "a");
  s = press(s, k("enter", { shift: true })).state;
  s = type(s, "b");
  s = press(s, k("newline", { alt: true })).state;
  s = type(s, "c");
  assert.deepEqual(s.lines, ["a", "b", "c"]);
  const r = press(s, k("enter"));
  assert.deepEqual(r.actions, ["submit:a\nb\nc"]);
  assert.equal(editorText(r.state), "");
  assert.deepEqual(r.state.history, ["a\nb\nc"]);
});

test("trailing backslash then Enter continues on a new line", () => {
  let s = type(newEditor(), "line one\\");
  const r = press(s, k("enter"));
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.state.lines, ["line one", ""]);
});

test("pasted multi-line text is inserted verbatim without submitting", () => {
  const r = press(newEditor(), k("paste", { text: "one\r\ntwo\nthree" }));
  assert.deepEqual(r.state.lines, ["one", "two", "three"]);
  assert.deepEqual(r.actions, []);
  assert.equal(r.state.row, 2);
  assert.equal(r.state.col, 5);
});

test("cursor movement: Home/End, Ctrl+A/E, arrows across lines", () => {
  let s = setEditorText(newEditor(), "abc\ndefg");
  s = press(s, k("home")).state; assert.equal(s.col, 0);
  s = press(s, k("e", { ctrl: true })).state; assert.equal(s.col, 4);
  s = press(s, k("a", { ctrl: true })).state; assert.equal(s.col, 0);
  s = press(s, k("left")).state; assert.deepEqual([s.row, s.col], [0, 3]); // wraps to end of previous line
  s = press(s, k("right")).state; assert.deepEqual([s.row, s.col], [1, 0]);
  s = press(s, k("up")).state; assert.equal(s.row, 0);
  s = press(s, k("end")).state; assert.equal(s.col, 3);
  s = press(s, k("down")).state; assert.deepEqual([s.row, s.col], [1, 3]);
});

test("Ctrl+K kills to end of line, Ctrl+U to start, Ctrl+W a word, Ctrl+Y yanks", () => {
  let s = setEditorText(newEditor(), "one two three");
  s = press(s, k("b", { alt: true })).state; // before "three"
  s = press(s, k("k", { ctrl: true })).state;
  assert.equal(editorText(s), "one two ");
  assert.equal(s.killBuf, "three");
  s = press(s, k("end")).state; // a non-kill key ends the kill run
  s = press(s, k("w", { ctrl: true })).state;
  assert.equal(editorText(s), "one ");
  assert.equal(s.killBuf, "two ");
  s = press(s, k("end")).state;
  s = press(s, k("u", { ctrl: true })).state;
  assert.equal(editorText(s), "");
  assert.equal(s.killBuf, "one ");
  s = press(s, k("y", { ctrl: true })).state;
  assert.equal(editorText(s), "one ");
});

test("consecutive kills accumulate in the kill buffer", () => {
  let s = setEditorText(newEditor(), "a b c");
  s = press(s, k("w", { ctrl: true }), k("w", { ctrl: true })).state;
  assert.equal(s.killBuf, "b c");
  assert.equal(editorText(s), "a ");
});

test("Ctrl+K at end of line joins the next line", () => {
  let s = setEditorText(newEditor(), "ab\ncd");
  s = { ...s, row: 0, col: 2 };
  s = press(s, k("k", { ctrl: true })).state;
  assert.deepEqual(s.lines, ["abcd"]);
});

test("Backspace at column 0 joins lines; Delete removes forward", () => {
  let s = setEditorText(newEditor(), "ab\ncd");
  s = { ...s, row: 1, col: 0 };
  s = press(s, k("backspace")).state;
  assert.deepEqual([s.lines, s.row, s.col], [["abcd"], 0, 2]);
  s = press(s, k("delete")).state;
  assert.equal(editorText(s), "abd");
});

test("surrogate pairs move and delete as one character", () => {
  let s = type(newEditor(), "a😀b");
  s = press(s, k("left"), k("left")).state;
  assert.equal(s.col, 1);
  s = press(s, k("right")).state;
  s = press(s, k("backspace")).state;
  assert.equal(editorText(s), "ab");
});

test("history: Up recalls newest first, Down returns to the draft, edits leave browse mode", () => {
  let s = newEditor(["first", "second"]);
  s = type(s, "draft");
  s = press(s, k("up")).state;
  assert.equal(editorText(s), "second");
  s = press(s, k("up")).state;
  assert.equal(editorText(s), "first");
  s = press(s, k("up")).state;
  assert.equal(editorText(s), "first");
  s = press(s, k("down")).state;
  assert.equal(editorText(s), "second");
  s = press(s, k("down")).state;
  assert.equal(editorText(s), "draft");
  s = press(s, k("up")).state;
  s = type(s, "!");
  assert.equal(s.histIdx, -1);
});

test("history: Up inside a multi-line buffer moves the cursor first", () => {
  let s = newEditor(["old"]);
  s = setEditorText(s, "l1\nl2");
  s = press(s, k("up")).state;
  assert.equal(editorText(s), "l1\nl2");
  assert.equal(s.row, 0);
  s = press(s, k("up")).state;
  assert.equal(editorText(s), "old");
});

test("submitting a duplicate of the last entry does not grow history; blanks are not recorded", () => {
  let s = newEditor(["x"]);
  s = press(s, k("enter")).state; // empty submit
  assert.deepEqual(s.history, ["x"]);
  s = type(s, "x");
  s = press(s, k("enter")).state;
  assert.deepEqual(s.history, ["x"]);
});

test("Ctrl+D on empty input is EOF, with text it deletes forward; Ctrl+C interrupts; Ctrl+L clears", () => {
  assert.deepEqual(press(newEditor(), k("d", { ctrl: true })).actions, ["eof"]);
  let s = setEditorText(newEditor(), "ab");
  s = { ...s, col: 0 };
  const r = press(s, k("d", { ctrl: true }));
  assert.deepEqual(r.actions, []);
  assert.equal(editorText(r.state), "b");
  assert.deepEqual(press(newEditor(), k("c", { ctrl: true })).actions, ["interrupt"]);
  assert.deepEqual(press(newEditor(), k("l", { ctrl: true })).actions, ["clear-screen"]);
});

test("parseKeys: plain text, enter, ctrl keys, arrows, home/end, delete", () => {
  const { keys, rest } = parseKeys("hi\r\x01\x1b[A\x1b[D\x1b[H\x1b[F\x1b[3~\x1bOC");
  assert.equal(rest, "");
  assert.deepEqual(keys.map((x) => x.name + (x.ctrl ? "^" : "")), ["char", "enter", "a^", "up", "left", "home", "end", "delete", "right"]);
  assert.equal(keys[0].text, "hi");
});

test("parseKeys: shift/alt enter variants", () => {
  assert.equal(parseKeys("\x1b[13;2u").keys[0].name, "newline");
  assert.equal(parseKeys("\x1b[27;2;13~").keys[0].name, "newline");
  const alt = parseKeys("\x1b\r").keys[0];
  assert.deepEqual([alt.name, alt.alt], ["newline", true]);
  assert.equal(parseKeys("\n").keys[0].name, "newline");
});

test("parseKeys: ctrl+arrow and alt+letter, alt+backspace", () => {
  const a = parseKeys("\x1b[1;5C").keys[0];
  assert.deepEqual([a.name, a.ctrl], ["right", true]);
  const b = parseKeys("\x1bb").keys[0];
  assert.deepEqual([b.name, b.alt], ["b", true]);
  const c = parseKeys("\x1b\x7f").keys[0];
  assert.deepEqual([c.name, c.alt], ["backspace", true]);
});

test("parseKeys: bracketed paste, including split across chunks", () => {
  const one = parseKeys("\x1b[200~a\nb\x1b[201~x");
  assert.equal(one.keys[0].name, "paste");
  assert.equal(one.keys[0].text, "a\nb");
  assert.equal(one.keys[1].text, "x");
  const part = parseKeys("\x1b[200~a\nb");
  assert.deepEqual(part.keys, []);
  const whole = parseKeys(part.rest + "c\x1b[201~");
  assert.equal(whole.keys[0].text, "a\nbc");
});

test("parseKeys: incomplete escape is held until flush, then becomes Escape", () => {
  const r = parseKeys("\x1b");
  assert.deepEqual(r, { keys: [], rest: "\x1b" });
  assert.equal(parseKeys("\x1b", { flush: true }).keys[0].name, "escape");
  const split = parseKeys("\x1b[");
  assert.equal(split.rest, "\x1b[");
  assert.equal(parseKeys(split.rest + "A").keys[0].name, "up");
});

test("insertText strips control characters", () => {
  const s = insertText(newEditor(), "a\x07b\tc");
  assert.equal(editorText(s), "ab  c");
});
