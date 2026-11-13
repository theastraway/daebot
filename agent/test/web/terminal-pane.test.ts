import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain browser module, no types
import { PANE_LABEL, POLL_MS, nearBottom, exitLabel, shouldPoll } from "../../web/terminal-pane.js";

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
});

test("terminal pane is built with textContent, and the page wires the chip, the stream, and the phone sheet", () => {
  const js = read("terminal-pane.js");
  assert.match(js, /textContent/);
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
  assert.match(html, /Daebot's terminal — read-only/);
  const app = read("app.js");
  assert.match(app, /initTerminalPane/);
  assert.match(app, /from "\/terminal-pane\.js"/);
  assert.match(app, /ev\.tool === "terminal"/);
  assert.match(app, /termPane\.sync\(\)/);
  const css = read("style.css");
  assert.match(css, /\.term-pane \{/);
  assert.match(css, /\.term-out \{[^}]*var\(--mono\)/);
  assert.match(css, /\.term-pane \{ top: auto; left: 0; width: auto; height: min\(52dvh, 440px\)/);
  assert.match(css, /\.win-overlay \.term-pane, \.mac-inset \.term-pane \{ -webkit-app-region: no-drag; \}/);
});
