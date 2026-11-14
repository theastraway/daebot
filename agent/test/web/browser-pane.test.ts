import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain browser module, no types
import { CONTROL_AGENT, CONTROL_USER, GIVE_LABEL, PANE_MAX_W, PANE_MIN_W, TAKE_LABEL, activeTab, browserActionLabel, browserArgsForCard, clampPaneWidth, controlLabel, shouldShowChip } from "../../web/browser-pane.js";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");

test("browser pane labels who has control and does not show typed text", () => {
  assert.equal(controlLabel("user"), CONTROL_USER);
  assert.equal(CONTROL_USER, "You have control");
  assert.equal(GIVE_LABEL, "Give back to Daebot");
  assert.equal(TAKE_LABEL, "Take over");
  assert.equal(controlLabel("agent"), CONTROL_AGENT);
  assert.equal(browserActionLabel({ action: "click", ref: "e3" }), "Browser click e3");
  assert.equal(browserArgsForCard({ action: "type", ref: "e2", text: "s3cret" }).text, "[not shown]");
  assert.equal(shouldShowChip({ connected: true, tabs: [] }), true);
  assert.equal(shouldShowChip({ connected: false, tabs: [] }), false);
  assert.equal(activeTab({ tabs: [{ id: "t1", active: false }, { id: "t2", active: true }] }).id, "t2");
  assert.equal(PANE_MIN_W, 420);
  assert.equal(PANE_MAX_W, 760);
  assert.equal(clampPaneWidth(100), 420);
  assert.equal(clampPaneWidth(900), 760);
  assert.equal(clampPaneWidth(640), 640);
  assert.equal(clampPaneWidth(0), 0);
});

test("browser pane is built with textContent, and the page wires the chip, the bar, and the tool card", () => {
  const js = read("browser-pane.js");
  assert.match(js, /textContent/);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(js, /You have control/);
  assert.match(js, /Give back to Daebot/);
  assert.match(js, /\/browser\/stream/);
  const html = read("index.html");
  assert.match(html, /id="btn-browser"/);
  assert.match(html, /id="browser-pane"/);
  assert.match(html, /id="browser-view"/);
  assert.match(html, /Give back to Daebot/);
  const app = read("app.js");
  assert.match(app, /initBrowserPane/);
  assert.match(app, /browserActionLabel/);
  assert.match(app, /browserArgsForCard/);
  assert.match(app, /browserPane\.noteTool/);
  assert.match(app, /browserPane\.sync/);
  const css = read("style.css");
  assert.match(css, /\.browser-pane/);
  assert.match(css, /\.browser-notice/);
  assert.match(css, /html\.browser-open \.scroll, html\.browser-open \.composer-wrap \{ margin-right: var\(--browser-pane-w, clamp\(420px, 45vw, 760px\)\); \}/);
  assert.match(css, /\.browser-pane \{[^}]*width: clamp\(420px, 45vw, 760px\)/);
  assert.match(js, /browser-open/);
  assert.match(js, /daebot\.browserPaneWidth/);
  assert.match(html, /id="browser-resize"/);
});
