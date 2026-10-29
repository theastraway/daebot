import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error plain browser module
import { clip, closesOnClick, historyOp, dividerLabel, involves, needsDivider, otherOf, titleOf, unreadList, safeColor } from "../../web/exchanges.js";
// @ts-expect-error plain browser module
import { generalSessions } from "../../web/bots.js";

test("timestamp dividers read like the chat: Today, Yesterday, weekday, date", () => {
  const now = new Date(2026, 9, 28, 20, 0).getTime();
  assert.match(dividerLabel(new Date(2026, 9, 28, 19, 30).getTime(), now), /^Today 7:30\s?PM$/);
  assert.match(dividerLabel(new Date(2026, 9, 27, 9, 5).getTime(), now), /^Yesterday 9:05\s?AM$/);
  assert.match(dividerLabel(new Date(2026, 9, 24, 16, 10).getTime(), now), /^Sat 4:10\s?PM$/);
  assert.match(dividerLabel(new Date(2026, 8, 3, 8, 0).getTime(), now), /^Sep 3, 8:00\s?AM$/);
});

test("a divider opens the transcript and again after an hour of silence", () => {
  assert.equal(needsDivider(undefined, 5), true);
  assert.equal(needsDivider(1000, 1000 + 59 * 60000), false);
  assert.equal(needsDivider(1000, 1000 + 60 * 60000), true);
});

test("exchange helpers: the other end, title, who is involved, unread only", () => {
  const ex = { id: "e", a: { id: "main", name: "Daebot" }, b: { id: "b_1", name: "LinkedIn Voice" }, unread: 2 };
  assert.equal(otherOf(ex, "main").name, "LinkedIn Voice");
  assert.equal(otherOf(ex, "b_1").name, "Daebot");
  assert.equal(titleOf(ex), "Daebot ↔ LinkedIn Voice");
  assert.equal(involves(ex, "b_1"), true);
  assert.equal(involves(ex, "b_9"), false);
  assert.deepEqual(unreadList([ex, { ...ex, id: "f", unread: 0 }]).map((x: any) => x.id), ["e"]);
  assert.equal(clip("a\n  b   c", 20), "a b c");
  assert.equal(clip("x".repeat(50), 10).length, 10);
  assert.equal(safeColor("javascript:alert(1)"), "#ffd25a");
});

test("agent-to-agent DM threads never appear in the plain Sessions list", () => {
  assert.deepEqual(generalSessions([{ id: "1" }, { id: "2", bot: "b" }, { id: "3", peer: "b" }]).map((s: any) => s.id), ["1"]);
});

// A fake element: closest(sel) is true when any selector in the list matches one of the tags/ids/classes the element "is".
function el(...is: string[]) {
  return { closest: (sel: string) => (sel.split(",").map((x) => x.trim()).some((x) => is.includes(x)) ? {} : null) };
}

test("clicking a session, tab, bot, New session or a navigating account item inside the sidebar leaves the exchange", () => {
  const sidebar = "#sidebar";
  assert.equal(closesOnClick(el(sidebar, "button")), true); // session row / Sessions tab / Bots tab / New session / bot row
  assert.equal(closesOnClick(el(sidebar, "[role='menuitem']")), true); // account menu item that navigates
  assert.equal(closesOnClick(el(sidebar, "a")), true);
});

test("clicks that do not navigate leave the exchange alone: outside the sidebar, another exchange row, in-place toggles", () => {
  assert.equal(closesOnClick(el("button")), false); // not in the sidebar
  assert.equal(closesOnClick(el("#sidebar", ".xs-row", "button")), false); // another exchange swaps the view itself
  assert.equal(closesOnClick(el("#sidebar", "#acct-btn", "button")), false);
  assert.equal(closesOnClick(el("#sidebar", "#am-switch", "button")), false);
  assert.equal(closesOnClick(el("#sidebar")), false); // blank sidebar space
  assert.equal(closesOnClick(null), false);
  assert.equal(closesOnClick({}), false);
});

test("history: opening pushes one entry, hopping exchange to exchange swaps it, Back/Esc pops it, navigating neutralises it, popstate does nothing", () => {
  assert.equal(historyOp({ pushed: false }, "open"), "push");
  assert.equal(historyOp({ pushed: true }, "open"), "replace");
  assert.equal(historyOp({ pushed: true }, "close-ui"), "back");
  assert.equal(historyOp({ pushed: false }, "close-ui"), "none");
  assert.equal(historyOp({ pushed: true }, "close-nav"), "neutralise");
  assert.equal(historyOp({ pushed: false }, "close-nav"), "none");
  assert.equal(historyOp({ pushed: true }, "close-pop"), "none");
});

test("the exchange view is wired to close on every way off the screen", () => {
  const src = readFileSync(new URL("../../web/exchanges.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../web/style.css", import.meta.url), "utf8");
  assert.match(src, /addEventListener\("popstate"/); // browser back
  assert.match(src, /e\.key === "Escape" && st\.openId/); // Esc anywhere
  assert.match(src, /xv-back-label", "Back"/); // a labelled Back button
  for (const fn of ["selectSession", "newSession", "newBotThread"]) assert.match(app, new RegExp(`function ${fn}\\([^)]*\\) \\{\\n  if \\(xchg\\) xchg\\.close\\("nav"\\)`));
  assert.match(css, /\.xv \{[^}]*z-index: 11/); // under the phone sidebar (z 20), so the sidebar can open over it
  assert.match(css, /\.xv-back \{[^}]*height: 40px/);
});
