import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { LIGHTS, groupRows, light, rowKey, stoppedCount, submitsOnKey } from "../../web/board.js";

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
