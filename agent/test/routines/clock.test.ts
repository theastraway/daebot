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
