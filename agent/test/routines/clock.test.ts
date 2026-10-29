import { test } from "node:test";
import assert from "node:assert/strict";
import { TimingError, describeTiming, nextRun, nextRuns, parseTiming } from "../../src/routines/clock.ts";

const iso = (n: number | undefined) => (n === undefined ? "none" : new Date(n).toISOString());

test("every 2 minutes", () => {
  const t0 = Date.parse("2026-10-28T12:00:30Z");
  assert.deepEqual(nextRuns("*/2 * * * *", "UTC", t0, 3).map(iso), ["2026-10-28T12:02:00.000Z", "2026-10-28T12:04:00.000Z", "2026-10-28T12:06:00.000Z"]);
});

test("weekdays 9 AM in New York, across the clock change", () => {
  // Fri 2026-10-30 -> Mon 2026-11-02 (DST ended 11-01: 09:00 EDT = 13:00Z, then 09:00 EST = 14:00Z)
  const r = nextRuns("0 9 * * 1-5", "America/New_York", Date.parse("2026-10-30T14:00:00Z"), 2).map(iso);
  assert.deepEqual(r, ["2026-11-02T14:00:00.000Z", "2026-11-03T14:00:00.000Z"]);
  assert.equal(iso(nextRun("0 9 * * 1-5", "America/New_York", Date.parse("2026-10-28T12:00:00Z"))), "2026-10-28T13:00:00.000Z");
});

test("a time that happens twice runs once (fall back)", () => {
  const r = nextRuns("30 1 * * *", "America/New_York", Date.parse("2026-10-30T12:00:00Z"), 3).map(iso);
  assert.deepEqual(r, ["2026-10-31T05:30:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
});

test("day-of-month and day-of-week are OR when both are set; impossible dates give none", () => {
  const r = nextRuns("0 0 13 * 5", "UTC", Date.parse("2026-10-28T00:00:00Z"), 2).map(iso);
  assert.deepEqual(r, ["2026-10-30T00:00:00.000Z", "2026-11-06T00:00:00.000Z"]);
  assert.equal(nextRun("0 0 30 2 *", "UTC", Date.parse("2026-10-28T00:00:00Z")), undefined);
});

test("names, 7 as Sunday, ranges and steps", () => {
  assert.deepEqual(parseTiming("0 9 * * 7").dow, [0]);
  assert.deepEqual(parseTiming("0 9 * * mon-fri").dow, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseTiming("*/20 * * * *").min, [0, 20, 40]);
  assert.deepEqual(parseTiming("@hourly").min, [0]);
});

test("bad expressions are refused in plain words", () => {
  for (const bad of ["* * *", "61 * * * *", "* 25 * * *", "5-1 * * * *", "*/0 * * * *", "a b c d e", "", "* * * * * *"]) assert.throws(() => parseTiming(bad), TimingError, bad);
});

test("plain-words description", () => {
  assert.equal(describeTiming("0 9 * * 1-5", "America/New_York"), "every weekday at 9:00 AM New York");
  assert.equal(describeTiming("*/2 * * * *", "UTC"), "every 2 minutes");
  assert.equal(describeTiming("17 * * * *", "UTC"), "every hour at :17");
  assert.equal(describeTiming("30 8 * * 1,3", "UTC"), "every Monday and Wednesday at 8:30 AM UTC");
  assert.equal(describeTiming("5 4 * * *", "Europe/London"), "every day at 4:05 AM London");
});

// ---------------------------------------------------------------- weekdays only + active hours (the universal filter)
import { TimingError as TE, checkFilter, filterWords, instantPasses, summarizeTiming, windowWords } from "../../src/routines/clock.ts";

const NY = "America/New_York";
const WH = { weekdays: true, from: "09:00", to: "17:00" };

test("every hour, weekdays only, 9 to 5: both ends included, the weekend skipped, DST change handled", () => {
  // Wed 2026-10-28 08:00 EDT -> 9,10,...,17 EDT, then Thu 9 EDT
  const day = nextRuns("0 * * * *", NY, Date.parse("2026-10-28T12:00:00Z"), 10, WH).map(iso);
  assert.deepEqual(day, ["13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00"].map((h) => `2026-10-28T${h}:00.000Z`).concat(["2026-10-29T13:00:00.000Z"]));
  // Fri 16:30 EDT -> 17:00 EDT (5 PM included) -> the weekend is skipped -> Mon 9:00 EST (the clocks went back on Sunday: 14:00Z)
  assert.deepEqual(nextRuns("0 * * * *", NY, Date.parse("2026-10-30T20:30:00Z"), 3, WH).map(iso), ["2026-10-30T21:00:00.000Z", "2026-11-02T14:00:00.000Z", "2026-11-02T15:00:00.000Z"]);
});

test("weekdays only applies to any timing: every 15 minutes, daily, weekly", () => {
  // Fri 23:50Z-ish: every 15 minutes, weekdays only, no hours window: Fri evening, then Monday 00:00 New York
  const fri = Date.parse("2026-10-31T03:50:00Z");      // Fri 23:50 EDT
  assert.deepEqual(nextRuns("*/15 * * * *", NY, fri, 2, { weekdays: true }).map(iso), ["2026-11-02T05:00:00.000Z", "2026-11-02T05:15:00.000Z"]); // Mon 00:00 EST, 00:15 EST
  // daily at 9 with weekdays only = Mon-Fri
  assert.deepEqual(nextRuns("0 9 * * *", NY, Date.parse("2026-10-30T14:00:00Z"), 2, { weekdays: true }).map(iso), ["2026-11-02T14:00:00.000Z", "2026-11-03T14:00:00.000Z"]);
  // weekly Sat+Mon with weekdays only = Mon only
  assert.deepEqual(nextRuns("0 9 * * 6,1", "UTC", Date.parse("2026-10-28T00:00:00Z"), 2, { weekdays: true }).map(iso), ["2026-11-02T09:00:00.000Z", "2026-11-09T09:00:00.000Z"]);
});

test("active hours across the spring-forward gap (02:00 does not exist) and the fall-back repeat (01:00 happens twice)", () => {
  const w = { from: "00:00", to: "04:00" };
  // Sun 2026-03-08, New York: 00:00 EST, 01:00 EST, (no 02:00), 03:00 EDT, 04:00 EDT
  assert.deepEqual(nextRuns("0 * * * *", NY, Date.parse("2026-03-08T04:00:00Z"), 4, w).map(iso), ["2026-03-08T05:00:00.000Z", "2026-03-08T06:00:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-08T08:00:00.000Z"]);
  // Sun 2026-11-01: 00:00 EDT, 01:00 EDT (once, not twice), 02:00 EST, 03:00 EST
  assert.deepEqual(nextRuns("0 * * * *", NY, Date.parse("2026-11-01T03:00:00Z"), 4, { from: "00:00", to: "03:00" }).map(iso), ["2026-11-01T04:00:00.000Z", "2026-11-01T05:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-01T08:00:00.000Z"]);
});

test("weekdays are the weekdays of the routine's own time zone (Auckland is already on Monday while UTC is still Sunday)", () => {
  // after Sat 2026-10-31 12:00Z: daily 09:00 Auckland (NZDT +13), weekdays only -> Mon 2026-11-02 09:00 NZDT = Sun 2026-11-01 20:00Z
  assert.equal(iso(nextRun("0 9 * * *", "Pacific/Auckland", Date.parse("2026-10-31T12:00:00Z"), { weekdays: true })), "2026-11-01T20:00:00.000Z");
  // Tokyo, Fri 17:30 JST -> next hourly 9-17 slot is Monday 09:00 JST = 00:00Z
  assert.equal(iso(nextRun("0 * * * *", "Asia/Tokyo", Date.parse("2026-10-30T08:30:00Z"), WH)), "2026-11-02T00:00:00.000Z");
  // Los Angeles, the same moment is still Thursday 4:30 PM: 5 PM PDT is included, then Friday 9 AM
  assert.deepEqual(nextRuns("0 * * * *", "America/Los_Angeles", Date.parse("2026-10-29T23:30:00Z"), 2, WH).map(iso), ["2026-10-30T00:00:00.000Z", "2026-10-30T16:00:00.000Z"]);
});

test("an active-hours window may wrap past midnight", () => {
  assert.deepEqual(nextRuns("0 * * * *", "UTC", Date.parse("2026-10-28T12:00:00Z"), 7, { from: "22:00", to: "02:00" }).map(iso),
    ["2026-10-28T22:00:00.000Z", "2026-10-28T23:00:00.000Z", "2026-10-29T00:00:00.000Z", "2026-10-29T01:00:00.000Z", "2026-10-29T02:00:00.000Z", "2026-10-29T22:00:00.000Z", "2026-10-29T23:00:00.000Z"]);
});

test("several times a day: parts joined by ';' run in time order", () => {
  assert.deepEqual(nextRuns("30 13 * * *;0 9 * * *", "UTC", Date.parse("2026-10-28T10:00:00Z"), 3).map(iso), ["2026-10-28T13:30:00.000Z", "2026-10-29T09:00:00.000Z", "2026-10-29T13:30:00.000Z"]);
  assert.equal(summarizeTiming("0 9 * * *;30 13 * * *"), "Daily at 9:00 AM and 1:30 PM");
  assert.equal(describeTiming("0 9 * * *;30 13 * * *", NY), "every day at 9:00 AM and 1:30 PM New York");
  assert.throws(() => parseTiming(Array.from({ length: 13 }, () => "0 9 * * *").join(";")), TE);
  assert.throws(() => parseTiming("0 9 * * *;nope"), TE);
});

test("the filter is checked: both ends or neither, real times, never the same minute", () => {
  assert.equal(checkFilter(undefined), undefined);
  assert.equal(checkFilter({ weekdays: false }), undefined);
  assert.deepEqual(checkFilter({ weekdays: true, from: "9:00", to: "17:00" }), { weekdays: true, from: "09:00", to: "17:00" });
  for (const bad of [{ from: "09:00" }, { from: "25:00", to: "17:00" }, { from: "09:00", to: "09:00" }, { weekdays: "yes" }, "weekdays"]) assert.throws(() => checkFilter(bad), TE, JSON.stringify(bad));
});

test("the short summary reads like words", () => {
  assert.equal(summarizeTiming("0 * * * *", WH), "Every hour · Weekdays · 9 AM–5 PM");
  assert.equal(summarizeTiming("*/15 * * * *"), "Every 15 minutes");
  assert.equal(summarizeTiming("*/30 * * * *", { weekdays: true }), "Every 30 minutes · Weekdays");
  assert.equal(summarizeTiming("15 * * * *"), "Every hour at :15");
  assert.equal(summarizeTiming("0 */4 * * *"), "Every 4 hours");
  assert.equal(summarizeTiming("30 7 * * *"), "Daily at 7:30 AM");
  assert.equal(summarizeTiming("0 9 * * 1-5", { weekdays: true }), "Weekdays at 9:00 AM");
  assert.equal(summarizeTiming("30 8 * * 1,3"), "Weekly on Mon, Wed at 8:30 AM");
  assert.equal(summarizeTiming("0 9 1 * *"), "Monthly on the 1st at 9:00 AM");
  assert.equal(summarizeTiming("0 9 1,15 * *"), "Monthly on the 1st and 15th at 9:00 AM");
  assert.equal(summarizeTiming("5 4 1,15 * 1"), "Custom: 5 4 1,15 * 1");
  assert.equal(windowWords({ from: "09:30", to: "17:00" }), "9:30 AM–5 PM");
  assert.equal(filterWords(WH), ", weekdays only, between 9 AM and 5 PM");
  assert.equal(describeTiming("0 * * * *", NY) + filterWords(WH), "every hour, on the hour, weekdays only, between 9 AM and 5 PM");
});

test("instantPasses: the same check triggers use", () => {
  assert.equal(instantPasses(WH, NY, Date.parse("2026-10-28T14:00:00Z")), true);    // Wed 10:00 EDT
  assert.equal(instantPasses(WH, NY, Date.parse("2026-10-28T12:00:00Z")), false);   // Wed 08:00 EDT
  assert.equal(instantPasses(WH, NY, Date.parse("2026-10-31T16:00:00Z")), false);   // Sat noon
  assert.equal(instantPasses(undefined, NY, Date.parse("2026-10-31T16:00:00Z")), true);
});
