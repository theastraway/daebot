import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, completeCommand, parseSlash, routeInput } from "../../src/ui/commands.ts";

test("every documented command routes to its action", () => {
  assert.deepEqual(routeInput("/help"), { type: "help" });
  assert.deepEqual(routeInput("/sessions"), { type: "sessions" });
  assert.deepEqual(routeInput("/new"), { type: "new" });
  assert.deepEqual(routeInput("/resume abc123"), { type: "resume", id: "abc123" });
  assert.deepEqual(routeInput("/model"), { type: "model" });
  assert.deepEqual(routeInput("/shadow"), { type: "shadow" });
  assert.deepEqual(routeInput("/violations"), { type: "violations" });
  assert.deepEqual(routeInput("/cost"), { type: "cost" });
  assert.deepEqual(routeInput("/expand"), { type: "expand", arg: "" });
  assert.deepEqual(routeInput("/expand c3"), { type: "expand", arg: "c3" });
  assert.deepEqual(routeInput("/clear"), { type: "clear" });
  assert.deepEqual(routeInput("/quit"), { type: "quit" });
  assert.equal(COMMANDS.length, 11);
});

test("aliases, case, whitespace", () => {
  assert.deepEqual(routeInput("  /EXIT "), { type: "quit" });
  assert.deepEqual(routeInput("/ls"), { type: "sessions" });
  assert.deepEqual(routeInput("/?"), { type: "help" });
});

test("/resume without an id is a usage error", () => {
  const a = routeInput("/resume");
  assert.equal(a.type, "error");
});

test("unique prefix completes, ambiguous and unknown are errors", () => {
  assert.deepEqual(routeInput("/viol"), { type: "violations" });
  assert.deepEqual(routeInput("/qu"), { type: "quit" });
  const amb = routeInput("/s");
  assert.equal(amb.type, "error");
  assert.match((amb as { message: string }).message, /sessions|shadow/);
  const unk = routeInput("/frobnicate");
  assert.equal(unk.type, "error");
  assert.match((unk as { message: string }).message, /unknown command/);
});

test("ordinary text, absolute paths and // escapes are sent as messages", () => {
  assert.deepEqual(routeInput("hello there"), { type: "send", text: "hello there" });
  assert.deepEqual(routeInput("/Users/me/file.txt what is this?"), { type: "send", text: "/Users/me/file.txt what is this?" });
  assert.deepEqual(routeInput("//help is a literal"), { type: "send", text: "/help is a literal" });
  assert.deepEqual(routeInput("   "), { type: "noop" });
  assert.deepEqual(routeInput("multi\n/quit"), { type: "send", text: "multi\n/quit" });
});

test("parseSlash and completeCommand", () => {
  assert.deepEqual(parseSlash("/expand last"), { name: "expand", args: "last" });
  assert.equal(parseSlash("not a command"), null);
  assert.deepEqual(completeCommand("/c"), ["cost", "clear"]);
  assert.deepEqual(completeCommand("zzz"), []);
});
