import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICE_CAPABILITIES, parseCapabilities } from "../../src/gateway/device-relay.ts";
import { SPOKEN_TURN_PROMPT } from "../../src/runtime.ts";

test("spoken is a client capability that needs no device relay, and its prompt asks for a short, fast, spoken answer", () => {
  assert.deepEqual(parseCapabilities(["spoken", "apple_calendar", "spoken", "root"]), ["spoken", "apple_calendar"]);
  assert.equal(DEVICE_CAPABILITIES.has("spoken"), false);
  assert.equal(DEVICE_CAPABILITIES.has("apple_calendar"), true);
  assert.match(SPOKEN_TURN_PROMPT, /one to three short spoken sentences/);
  assert.match(SPOKEN_TURN_PROMPT, /never several mind_query searches/);
  assert.match(SPOKEN_TURN_PROMPT, /Jaybot/);
});
