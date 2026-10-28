import { test } from "node:test";
import assert from "node:assert/strict";
import { toolClass } from "../../src/mcpconnect/service.ts";

test("read-only labels count on official, listed and the user's own (URL + token) servers, never on unknown ones", () => {
  const ro = { name: "search_workflows", readOnly: true, destructive: false };
  assert.equal(toolClass({ publisher: "self", allow: [] }, ro), "read");
  assert.equal(toolClass({ publisher: "official", allow: [] }, ro), "read");
  assert.equal(toolClass({ publisher: "unknown", allow: [] }, ro), "outward");
  assert.equal(toolClass({ publisher: "self", allow: [] }, { name: "execute_workflow", readOnly: false, destructive: false }), "outward");
  assert.equal(toolClass({ publisher: "self", allow: [] }, { name: "x", readOnly: true, destructive: true }), "outward");
});
