import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { expressionFor, presetOf, lastRunText, nextRunText } from "../../web/routines.js";

test("presets build the 5-field expression and read it back", () => {
  assert.equal(expressionFor("minutes", { n: 2 }), "*/2 * * * *");
  assert.equal(expressionFor("hourly", { minute: 17 }), "17 * * * *");
  assert.equal(expressionFor("daily", { time: "07:30" }), "30 7 * * *");
  assert.equal(expressionFor("weekdays", { time: "09:00" }), "0 9 * * 1-5");
  assert.equal(expressionFor("custom", { expression: " 5 4 * * 1 " }), "5 4 * * 1");
  assert.deepEqual(presetOf("*/2 * * * *"), { preset: "minutes", n: 2 });
  assert.deepEqual(presetOf("17 * * * *"), { preset: "hourly", minute: 17 });
  assert.deepEqual(presetOf("30 7 * * *"), { preset: "daily", time: "07:30" });
  assert.deepEqual(presetOf("0 9 * * 1-5"), { preset: "weekdays", time: "09:00" });
  assert.equal(presetOf("0 9 1 * *").preset, "custom");
  for (const p of ["minutes", "hourly", "daily", "weekdays"]) assert.equal(presetOf(expressionFor(p, { n: 5, minute: 3, time: "06:45" })).preset, p);
});

test("last run and next run text", () => {
  const ago = () => "2 min ago";
  assert.equal(lastRunText({}, ago), "Has not run yet");
  assert.match(lastRunText({ lastRunAt: 1, lastStatus: "idle", lastResult: "nothing to do" }, ago), /no model call/);
  assert.match(lastRunText({ lastRunAt: 1, lastStatus: "error", lastResult: "boom" }, ago), /Failed 2 min ago: boom/);
  assert.equal(nextRunText({ enabled: false }, () => ""), "Off");
  assert.match(nextRunText({ enabled: true, nextRunAt: 5 }, () => "Wed 9:00 AM"), /Next run Wed 9:00 AM/);
});
