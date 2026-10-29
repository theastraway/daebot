import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { expressionFor, presetOf, lastRunText, nextRunText, pollText, filterOf, filterText, PRESETS } from "../../web/routines.js";

test("presets build the 5-field expression and read it back", () => {
  assert.equal(expressionFor("m15"), "*/15 * * * *");
  assert.equal(expressionFor("m30"), "*/30 * * * *");
  assert.equal(expressionFor("minutes", { n: 2 }), "*/2 * * * *");
  assert.equal(expressionFor("hourly", { minute: 17 }), "17 * * * *");
  assert.equal(expressionFor("nhours", { hours: 4, minute: 5 }), "5 */4 * * *");
  assert.equal(expressionFor("nhours", { hours: 5 }), "0 */2 * * *", "only steps that divide the day are offered");
  assert.equal(expressionFor("daily", { time: "07:30" }), "30 7 * * *");
  assert.equal(expressionFor("multi", { times: ["13:30", "09:00", "09:00"] }), "0 9 * * *;30 13 * * *");
  assert.equal(expressionFor("weekly", { time: "08:15", days: [3, 1] }), "15 8 * * 1,3");
  assert.equal(expressionFor("weekly", { time: "08:15", days: [] }), "", "a week with no day picked is not a timing");
  assert.equal(expressionFor("monthly", { time: "09:00", dom: 15 }), "0 9 15 * *");
  assert.equal(expressionFor("custom", { expression: " 5 4 * * 1 " }), "5 4 * * 1");
  assert.deepEqual(presetOf("*/15 * * * *"), { preset: "m15" });
  assert.deepEqual(presetOf("*/30 * * * *"), { preset: "m30" });
  assert.deepEqual(presetOf("*/2 * * * *"), { preset: "minutes", n: 2 });
  assert.deepEqual(presetOf("17 * * * *"), { preset: "hourly", minute: 17 });
  assert.deepEqual(presetOf("5 */4 * * *"), { preset: "nhours", minute: 5, hours: 4 });
  assert.deepEqual(presetOf("30 7 * * *"), { preset: "daily", time: "07:30" });
  assert.deepEqual(presetOf("0 9 * * *;30 13 * * *"), { preset: "multi", times: ["09:00", "13:30"] });
  assert.deepEqual(presetOf("0 9 * * 1-5"), { preset: "weekly", time: "09:00", days: [1, 2, 3, 4, 5] });
  assert.deepEqual(presetOf("15 8 * * 1,3"), { preset: "weekly", time: "08:15", days: [1, 3] });
  assert.deepEqual(presetOf("0 9 15 * *"), { preset: "monthly", time: "09:00", dom: 15 });
  assert.equal(presetOf("5 4 1,15 * 1").preset, "custom");
  const fields = { n: 5, hours: 3, minute: 3, time: "06:45", times: ["06:45", "18:00"], days: [1, 4], dom: 9, expression: "1 2 3 4 5" };
  for (const p of PRESETS.map((x: any) => x.id)) assert.equal(presetOf(expressionFor(p, fields)).preset, p, p);
  assert.ok(PRESETS.some((p: any) => p.id === "hourly" && /Every hour/.test(p.label)));
});

test("the limit: one weekdays switch and optional active hours make one filter", () => {
  assert.equal(filterOf({ weekdays: false, windowOn: false, from: "09:00", to: "17:00" }), null);
  assert.deepEqual(filterOf({ weekdays: true, windowOn: false, from: "09:00", to: "17:00" }), { weekdays: true });
  assert.deepEqual(filterOf({ weekdays: true, windowOn: true, from: "09:00", to: "17:00" }), { weekdays: true, from: "09:00", to: "17:00" });
  assert.deepEqual(filterOf({ weekdays: false, windowOn: true, from: "22:00", to: "02:00" }), { from: "22:00", to: "02:00" });
  assert.equal(filterText({ weekdays: true, from: "09:00", to: "17:00" }), "Weekdays · 9 AM–5 PM");
  assert.equal(filterText({ from: "09:30", to: "17:00" }), "9:30 AM–5 PM");
  assert.equal(filterText(null), "");
});

test("last run, next run and polling status text", () => {
  const ago = () => "2 min ago";
  assert.equal(lastRunText({}, ago), "Has not run yet");
  assert.match(lastRunText({ lastRunAt: 1, lastStatus: "idle", lastResult: "nothing to do" }, ago), /no model call/);
  assert.match(lastRunText({ lastRunAt: 1, lastStatus: "error", lastResult: "boom" }, ago), /Failed 2 min ago: boom/);
  assert.equal(nextRunText({ enabled: false }, () => ""), "Off");
  assert.match(nextRunText({ enabled: true, nextRunAt: 5 }, () => "Wed 9:00 AM"), /Next run Wed 9:00 AM/);
  assert.equal(pollText({ enabled: true, trigger: { type: "webhook" } }, ago), "");
  assert.equal(pollText({ enabled: true, trigger: { type: "mail_new", every: 15 }, poll: { lastPollAt: 1 } }, ago), "Looks every 15 minutes. Last look 2 min ago.");
  assert.match(pollText({ enabled: true, trigger: { type: "mind_task", every: 60 }, poll: { error: "no key" } }, ago), /every hour\. Last look failed: no key/);
  assert.match(pollText({ enabled: true, trigger: { type: "mind_task", every: 5 } }, ago), /First look is coming up/);
});
