import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error plain browser module
import { ALWAYS_ROOMS, KIND_LABEL, LIVE_EXAMPLES, LIVE_MS, PHASE_LABEL, elapsedText, liveSummary, loopRail } from "../../web/studio.js";

test("Live room helpers: summary counts, the loop rail, elapsed text", () => {
  assert.deepEqual(liveSummary(undefined), { working: 0, loops: 0, branches: 0, done: 0, failed: 0 });
  const live = {
    helpers: [
      { status: "running" }, { status: "running", branch: "daebot/helper-a" }, { status: "done", branch: "daebot/helper-a" }, { status: "failed" },
    ],
    loops: [{ endedAt: 0 }, { endedAt: 5, branch: "daebot/helper-loop" }],
  };
  assert.deepEqual(liveSummary(live), { working: 2, loops: 1, branches: 2, done: 1, failed: 1 });
  assert.deepEqual(loopRail({ maxCycles: 4, bar: 9, scores: [6, 9.2], cycle: 3 }).map((m: any) => m.kind), ["score", "pass", "now", "todo"]);
  assert.deepEqual(loopRail({ maxCycles: 2, bar: 9, scores: [9.5], cycle: 1, endedAt: 9 }).map((m: any) => m.kind), ["pass", "todo"]);
  assert.equal(elapsedText(42_000), "42s");
  assert.equal(elapsedText(185_000), "3m 05s");
  assert.equal(elapsedText(3_720_000), "1h 02m");
  assert.equal(elapsedText(-5), "0s");
  assert.equal(LIVE_MS, 2000);
  assert.deepEqual(ALWAYS_ROOMS, ["overview", "live"]);
  assert.equal(KIND_LABEL.build, "Build");
  assert.equal(PHASE_LABEL.cleared, "Cleared");
  assert.ok(LIVE_EXAMPLES.some(([, text]: string[]) => text.startsWith("/loop ")));
});

test("Live room: DOM-only (no innerHTML), reads /studio/live, theme tokens only in its CSS, reduced motion respected", () => {
  const js = readFileSync(new URL("../../web/studio.js", import.meta.url), "utf8");
  assert.ok(!/innerHTML\s*=/.test(js), "no innerHTML");
  assert.ok(js.includes('json("/studio/live")'));
  const css = readFileSync(new URL("../../web/style.css", import.meta.url), "utf8");
  const live = css.slice(css.indexOf("Daebot Studio 6"));
  assert.ok(live.length > 1000);
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(live), "no hard-coded colours in the Live room CSS");
  assert.match(live, /prefers-reduced-motion: reduce/);
  assert.match(live, /max-width: 860px/);
});
