import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { keepAwakeCommand, keepAwakeWanted, startKeepAwake } from "../src/keepawake.ts";

test("wanted: on by default, never hosted, off with DAEBOT_KEEP_AWAKE=off", () => {
  assert.equal(keepAwakeWanted({}), true);
  assert.equal(keepAwakeWanted({}, true), false);
  assert.equal(keepAwakeWanted({ DAEBOT_KEEP_AWAKE: "off" }), false);
  assert.equal(keepAwakeWanted({ DAEBOT_KEEP_AWAKE: "1" }), true);
});

test("command: caffeinate tied to the gateway pid on macOS, systemd-inhibit on Linux, nothing on Windows", () => {
  assert.deepEqual(keepAwakeCommand("darwin", 4242), { cmd: "caffeinate", args: ["-i", "-w", "4242"] });
  assert.equal(keepAwakeCommand("linux", 1)?.cmd, "systemd-inhibit");
  assert.equal(keepAwakeCommand("win32", 1), undefined);
});

test("start: spawns the helper with stdio ignored, stop kills it, a missing tool is not an error", () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const fake = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; return true; } });
  const spawnImpl = ((cmd: string, args: string[], opts: { stdio: string }) => { calls.push({ cmd, args }); assert.equal(opts.stdio, "ignore"); return fake; }) as never;
  const k = startKeepAwake({ platform: "darwin", pid: 7, env: {}, spawnImpl });
  assert.equal(k?.tool, "caffeinate");
  assert.deepEqual(calls, [{ cmd: "caffeinate", args: ["-i", "-w", "7"] }]);
  k!.stop();
  assert.equal(fake.killed, true);
  assert.equal(startKeepAwake({ platform: "darwin", env: { DAEBOT_KEEP_AWAKE: "off" }, spawnImpl }), undefined);
  assert.equal(startKeepAwake({ platform: "darwin", hosted: true, spawnImpl }), undefined);
  const throwing = (() => { throw new Error("ENOENT"); }) as never;
  assert.equal(startKeepAwake({ platform: "darwin", env: {}, spawnImpl: throwing }), undefined);
});
