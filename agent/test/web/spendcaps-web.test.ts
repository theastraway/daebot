import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain browser module
import { bannerText, barFor, capFromForm, money, spendLine } from "../../web/spendcaps.js";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");
const view = (over: Record<string, unknown> = {}) => ({ cap: { usd: 10, period: "weekly", alertPct: 80 }, spentUsd: 2.5, remainingUsd: 7.5, pct: 25, reached: false, alert: false, resetsAt: "2026-11-16T05:00:00.000Z", ...over });

test("money: whole dollars bare, cents to two places, sub-cent amounts kept", () => {
  assert.equal(money(5), "$5"); assert.equal(money(0.01), "$0.01"); assert.equal(money(1.5), "$1.50"); assert.equal(money(0.0042), "$0.0042");
});

test("spend line and bar: spent vs cap with the reset day; no cap says so; tone follows alert and reached", () => {
  assert.equal(spendLine(view(), "en-US"), "Spent $2.50 of $10 weekly · resets Nov 16");
  assert.equal(spendLine(view({ cap: null }), "en-US"), "Spent $2.50 this month · no cap");
  assert.deepEqual(barFor(view()), { pct: 25, tone: "ok" });
  assert.deepEqual(barFor(view({ pct: 85, alert: true })), { pct: 85, tone: "low" });
  assert.deepEqual(barFor(view({ pct: 140, reached: true, alert: true })), { pct: 100, tone: "empty" });
  assert.equal(barFor(view({ cap: null })), null);
});

test("capFromForm: empty amount clears; bad amounts and percents are refused with a sentence", () => {
  assert.deepEqual(capFromForm({ usd: "", period: "daily", alertPct: "" }), { cap: null });
  assert.deepEqual(capFromForm({ usd: "$0.01", period: "daily", alertPct: "80%" }), { cap: { usd: 0.01, period: "daily", alertPct: 80 } });
  for (const bad of [{ usd: "abc", period: "daily" }, { usd: "-2", period: "daily" }, { usd: "5", period: "yearly" }, { usd: "5", period: "daily", alertPct: "150" }])
    assert.ok(capFromForm(bad as never).error);
});

test("banner: reached beats the alert threshold; nothing to say stays hidden", () => {
  assert.equal(bannerText(null), null);
  assert.equal(bannerText({ account: view(), bots: {} }), null);
  assert.match(bannerText({ account: view({ pct: 85, alert: true }), bots: {} }), /Your account has used 85% of its \$10 weekly cap/);
  assert.match(bannerText({ account: view(), bots: { b1: view({ reached: true, alert: true }) } }), /A bot reached its \$10 weekly cap/);
});

test("the page carries the account modal, the menu item, the banner and the bot drawer section", () => {
  const html = read("index.html");
  for (const id of ["caps-modal", "caps-body", "am-caps", "cap-banner", "bd-cap-sec", "bd-cap"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(read("app.js").includes("initSpendCaps"));
  assert.ok(read("bots.js").includes("mountBotCap"));
});
