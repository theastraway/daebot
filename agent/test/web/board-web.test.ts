import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { LIGHTS, filterRows, groupRows, light, projectsOf, rowKey, stoppedCount, submitsOnKey } from "../../web/board.js";

test("the lights are the client portal's: three statuses, red also means stopped with its own label", () => {
  assert.deepEqual([LIGHTS.not_started, LIGHTS.in_progress, LIGHTS.ready_to_test, LIGHTS.stopped], [
    { label: "Not started", cls: "red" }, { label: "In progress", cls: "yellow" }, { label: "Ready to test", cls: "green" }, { label: "Waiting on you", cls: "red" },
  ]);
  assert.equal(light("nonsense").label, "Not started");
});

test("rows group under their session; sessions waiting on the user come first; the red count counts stopped rows", () => {
  const rows = [
    { sessionId: "a", sessionTitle: "Alpha", id: "1", title: "x", status: "ready_to_test" },
    { sessionId: "b", sessionTitle: "Beta", id: "1", title: "y", status: "in_progress" },
    { sessionId: "b", sessionTitle: "Beta", id: "2", title: "z", status: "stopped", question: "q?" },
    { sessionId: 7, id: "bad" }, null,
  ];
  const g = groupRows(rows);
  assert.deepEqual(g.map((x: any) => [x.sessionId, x.title, x.rows.length]), [["b", "Beta", 2], ["a", "Alpha", 1]]);
  assert.equal(stoppedCount(rows), 1);
  assert.equal(stoppedCount(undefined), 0);
  assert.notEqual(rowKey(rows[0]), rowKey(rows[1]));
});

test("Enter submits the reply, Shift+Enter is a newline, and an IME composition never submits", () => {
  assert.equal(submitsOnKey({ key: "Enter", shiftKey: false, isComposing: false }), true);
  assert.equal(submitsOnKey({ key: "Enter", shiftKey: true, isComposing: false }), false);
  assert.equal(submitsOnKey({ key: "Enter", shiftKey: false, isComposing: true }), false);
  assert.equal(submitsOnKey({ key: "a", shiftKey: false, isComposing: false }), false);
});

test("filters: by scope and by project; the project list follows the chosen scope", () => {
  const rows = [
    { sessionId: "a", id: "1", title: "x", status: "in_progress", scope: "astra", project: { id: "p1", name: "Atlas Monitor" } },
    { sessionId: "a", id: "2", title: "y", status: "in_progress", scope: "mind", project: { id: "p2", name: "Daebot" } },
    { sessionId: "b", id: "3", title: "z", status: "cancelled", scope: "astra", project: { id: "p3", name: "Reframe" } },
    { sessionId: "b", id: "4", title: "no link", status: "in_progress" },
  ];
  assert.equal(filterRows(rows, { scope: "all", project: "all" }).length, 4);
  assert.deepEqual(filterRows(rows, { scope: "astra", project: "all" }).map((r: any) => r.id), ["1", "3"]);
  assert.deepEqual(filterRows(rows, { scope: "all", project: "p2" }).map((r: any) => r.id), ["2"]);
  assert.deepEqual(projectsOf(rows, "astra").map((p: any) => p.name), ["Atlas Monitor", "Reframe"]);
  assert.deepEqual(projectsOf(rows, "all").map((p: any) => p.name), ["Atlas Monitor", "Daebot", "Reframe"]);
  assert.equal(light("cancelled").label, "Cancelled");
  assert.equal(stoppedCount(rows), 0, "a cancelled task never counts as waiting on you");
});
