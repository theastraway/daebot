import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain browser module, no types
import { PANE_LABEL, EMPTY_TEXT, POLL_MS, nearBottom, exitLabel, shouldPoll, shouldFollow, droppedNote, applyOutput } from "../../web/terminal-pane.js";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");

test("terminal pane helpers: follow the bottom, label an exit, poll only while a shell exists", () => {
  assert.equal(PANE_LABEL, "Daebot's terminal — read-only");
  assert.equal(POLL_MS, 2000);
  assert.equal(nearBottom(100, 200, 80), true);
  assert.equal(nearBottom(0, 500, 40), false);
  assert.equal(nearBottom(0, 100, 60, 10), false);
  assert.equal(exitLabel(null), "");
  assert.equal(exitLabel({ status: "running", exitCode: null }), "");
  assert.equal(exitLabel({ status: "closed" }), "Closed");
  assert.equal(exitLabel({ status: "exited", exitCode: 7 }), "Exited (status 7)");
  assert.equal(exitLabel({ status: "exited", exitCode: null }), "Exited (status ?)");
  assert.equal(shouldPoll(0), false);
  assert.equal(shouldPoll(2), true);
  assert.equal(shouldFollow(true, false, false), true);
  assert.equal(shouldFollow(true, true, false), false, "an open stream is not opened twice");
  assert.equal(shouldFollow(true, false, true), false, "an exited shell does not reconnect every poll");
  assert.equal(shouldFollow(false, false, false), false);
  assert.equal(droppedNote(0), "");
  assert.equal(droppedNote(1), "[1 earlier character not shown]\n");
  assert.equal(droppedNote(2400), "[2400 earlier characters not shown]\n");
  assert.equal(EMPTY_TEXT, "No output yet.");
});

test("terminal output stays text: markup is kept as characters, and a gap is marked in front of it", () => {
  const hostile = "<script>alert(1)</script><img src=x onerror=alert(1)>";
  assert.equal(applyOutput("", "snapshot", { text: hostile, dropped: 12 }), `[12 earlier characters not shown]\n${hostile}`);
  assert.equal(applyOutput("hello\n", "data", { text: hostile, dropped: 0 }), `hello\n${hostile}`);
  assert.equal(applyOutput("hello\n", "data", { text: "more", dropped: 4 }), "hello\n[4 earlier characters not shown]\nmore");
  assert.equal(applyOutput("keep", "status", { status: "exited" }), "keep", "a status event does not rewrite the scrollback");
  assert.equal(applyOutput("x", "snapshot", { text: 12, dropped: "nope" }), "", "a non-string payload becomes empty text, not HTML");
  assert.equal(applyOutput("", "snapshot", { text: 12 }), "");
});

test("terminal pane is built with textContent, and the page wires the chip, the stream, and the phone sheet", () => {
  const js = read("terminal-pane.js");
  assert.match(js, /textContent/);
  assert.match(js, /out\.textContent = shown/);
  assert.match(js, /if \(painting\) return/);
  assert.match(js, /shouldFollow/);
  assert.match(js, /applyOutput/);
  assert.match(js, /classList\.toggle\("term-open"/);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(js, /info\.id/);
  assert.match(js, /info\.shell/);
  assert.match(js, /info\.cwd/);
  assert.match(js, /info\.status/);
  assert.match(js, /\/stream/);
  assert.match(js, /shouldPoll/);
  const html = read("index.html");
  assert.match(html, /id="btn-terminal"/);
  assert.match(html, /id="term-pane"/);
  assert.match(html, /id="term-out"/);
  assert.match(html, /id="term-empty"/);
  assert.match(html, /Daebot's terminal — read-only/);
  const app = read("app.js");
  assert.match(app, /initTerminalPane/);
  assert.match(app, /from "\/terminal-pane\.js"/);
  assert.match(app, /ev\.tool === "terminal"/);
  assert.match(app, /termPane\.sync\(\)/);
  assert.match(app, /emptyEl: \$\("term-empty"\)/);
  const css = read("style.css");
  assert.match(css, /\.term-pane \{/);
  assert.match(css, /\.term-pane \{[^}]*top: calc\(56px \+ env\(safe-area-inset-top\)\)/);
  assert.match(css, /\.term-out \{[^}]*var\(--mono\)/);
  assert.match(css, /html\.term-open \.scroll, html\.term-open \.composer-wrap \{ margin-right: min\(440px, 42vw\); \}/);
  assert.match(css, /\.term-pane \{ top: auto; left: 0; width: auto; height: min\(52dvh, 440px\)/);
  assert.match(css, /html\.term-open \.scroll, html\.term-open \.composer-wrap \{ margin-right: 0; \}/);
  assert.match(css, /\.win-overlay \.term-pane, \.mac-inset \.term-pane \{ -webkit-app-region: no-drag; \}/);
});
