// Actions roll like a rolodex: a run of tool rows shows the newest 4, with a "See all (N)" button for the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore the browser module is plain JS with no declaration file
import { FOLD_KEEP, planRun } from "../../web/toolroll.js";

const WEB = join(import.meta.dirname, "../../web");

test("a run of 4 or fewer shows everything and has no button", () => {
  for (const n of [0, 1, 3, 4]) assert.deepEqual(planRun(n, false), { hidden: 0, label: null });
  assert.equal(FOLD_KEEP, 4);
});

test("15 actions fold to the newest 4 with See all (15)", () => {
  assert.deepEqual(planRun(15, false), { hidden: 11, label: "See all (15)" });
});

test("a 5th action rolls the oldest out: the count updates and stays at 4 visible", () => {
  assert.deepEqual(planRun(5, false), { hidden: 1, label: "See all (5)" });
});

test("expanded shows all 15 and offers to fold back", () => {
  assert.deepEqual(planRun(15, true), { hidden: 0, label: "Show fewer" });
  assert.deepEqual(planRun(3, true), { hidden: 0, label: null }); // nothing to fold, no button even if flagged open
});

test("wiring: app.js starts it on the thread, css folds via data attributes, button is a real <button>, reduced motion is respected", () => {
  const app = readFileSync(join(WEB, "app.js"), "utf8");
  assert.match(app, /import \{ initToolRoll \} from "\/toolroll\.js"/);
  assert.match(app, /initToolRoll\(els\.thread\)/);
  const css = readFileSync(join(WEB, "style.css"), "utf8");
  assert.match(css, /\.tool\[data-fold="1"\] \{ display: none; \}/);
  assert.match(css, /@keyframes tool-roll-in/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \* \{ animation: none !important/);
  const js = readFileSync(join(WEB, "toolroll.js"), "utf8");
  assert.match(js, /createElement\("button"\)/);
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(js, /aria-expanded/);
  // state must not live in className: refreshTool() rewrites it on every tool result
  assert.doesNotMatch(js, /classList\.(add|toggle)\(["']tool-fold/);
});
