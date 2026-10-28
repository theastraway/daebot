import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALENDAR_CHANNEL, CALENDAR_OPS, CALL_TIMEOUT_MS, NOT_BUNDLED, NOT_OUR_WINDOW, REQUEST_TIMEOUT_MS,
  createCalendarBridge, createCalendarHandler, findCalendarHelper, frameRequest, parseReply,
} from "../src/lib/calendar.mjs";
import { ARCHS, HELPER_NAME, MIN_MACOS, buildCalendarHelper, calendarHelperPlan } from "../scripts/build-calendar-helper.mjs";
import { targetsFor } from "../scripts/stage-bin.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const HELPER = "/Applications/Daebot.app/Contents/Resources/bin/daebot-calendar";

/** A stub of child_process.spawn: records the request line written to stdin and answers (or not) like the Swift helper. */
function stubSpawn(behave) {
  const spawned = [];
  const spawn = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    const rec = { file, args, opts, stdin: "", child };
    spawned.push(rec);
    child.stdin.end = (line) => { rec.stdin = line; behave(child, rec); };
    return child;
  };
  return { spawn, spawned };
}
const answer = (obj, code = 0) => (child) => setImmediate(() => { child.stdout.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`)); child.emit("close", code, null); });

// ---------------------------------------------------------------- framing: one JSON request in, one JSON reply out

test("one request line on stdin: { op, args } as JSON, newline terminated; the op must be one of the seven", () => {
  assert.deepEqual([...CALENDAR_OPS], ["status", "request", "calendars", "events", "create", "update", "delete"]);
  assert.equal(frameRequest("status", undefined).line, '{"op":"status","args":{}}\n');
  assert.equal(frameRequest("events", { start: "a", end: "b" }).line, '{"op":"events","args":{"start":"a","end":"b"}}\n');
  assert.equal(frameRequest("delete", ["not", "an", "object"]).line, '{"op":"delete","args":{}}\n');
  for (const op of ["eval", "", "STATUS", undefined, null, 7, "status; rm -rf /"]) assert.match(frameRequest(op, {}).error, /not supported/, String(op));
  assert.match(frameRequest("create", { notes: "x".repeat(300_000) }).error, /too large/);
  const circular = {}; circular.self = circular;
  assert.match(frameRequest("create", circular).error, /could not be read/);
});

test("the reply is the last JSON line on stdout; ok/result and ok:false/error are the only shapes", () => {
  assert.deepEqual(parseReply('{"ok":true,"result":{"access":"granted"}}\n'), { ok: true, result: { access: "granted" } });
  assert.deepEqual(parseReply('{"ok":true}\n'), { ok: true, result: null });
  assert.deepEqual(parseReply('warning: noise\n{"ok":false,"error":"Calendar access is off for Daebot."}\n'), { ok: false, error: "Calendar access is off for Daebot." });
  assert.deepEqual(parseReply('{"ok":false}\n'), { ok: false, error: "Calendar could not do that." });
  assert.equal(parseReply("").ok, false);
  assert.match(parseReply("").error, /did not answer/);
  assert.match(parseReply("not json").error, /could not read/);
  assert.deepEqual(parseReply("[1,2]"), { ok: false, error: "Calendar could not do that." });
  assert.equal(parseReply(`{"ok":false,"error":"${"x".repeat(900)}"}`).error.length, 500);
});

// ---------------------------------------------------------------- the bridge (spawn is stubbed: nothing runs, nothing prompts)

test("bridge: spawns the helper once per call, writes the request to stdin, returns its reply", async () => {
  const { spawn, spawned } = stubSpawn(answer({ ok: true, result: { access: "granted" } }));
  const bridge = createCalendarBridge({ helperPath: HELPER, spawn });
  assert.deepEqual(await bridge.call("status", {}), { ok: true, result: { access: "granted" } });
  assert.deepEqual(await bridge.call("status", {}), { ok: true, result: { access: "granted" } });
  assert.equal(spawned.length, 2, "a fresh process per call");
  assert.equal(spawned[0].file, HELPER);
  assert.deepEqual(spawned[0].args, []);
  assert.deepEqual(spawned[0].opts.stdio, ["pipe", "pipe", "ignore"]);
  assert.equal(spawned[0].stdin, '{"op":"status","args":{}}\n');
});

test("bridge: a bad op or a missing helper never spawns anything", async () => {
  const { spawn, spawned } = stubSpawn(answer({ ok: true, result: 1 }));
  const bridge = createCalendarBridge({ helperPath: HELPER, spawn });
  assert.match((await bridge.call("rm", {})).error, /not supported/);
  const none = createCalendarBridge({ helperPath: null, spawn });
  assert.deepEqual(await none.call("status", {}), { ok: false, error: NOT_BUNDLED });
  assert.equal(spawned.length, 0);
});

test("bridge: helper errors, a crash with no answer, a failed start and oversized output all come back as sentences", async () => {
  const off = "Calendar access is off for Daebot. Turn it on in System Settings > Privacy & Security > Calendars.";
  assert.deepEqual(await createCalendarBridge({ helperPath: HELPER, spawn: stubSpawn(answer({ ok: false, error: off })).spawn }).call("events", { start: "a", end: "b" }), { ok: false, error: off });
  const killed = stubSpawn((child) => setImmediate(() => child.emit("close", null, "SIGKILL"))).spawn;
  assert.match((await createCalendarBridge({ helperPath: HELPER, spawn: killed }).call("status", {})).error, /stopped by macOS/);
  const silent = stubSpawn((child) => setImmediate(() => child.emit("close", 0, null))).spawn;
  assert.match((await createCalendarBridge({ helperPath: HELPER, spawn: silent }).call("status", {})).error, /did not answer/);
  const noStart = stubSpawn((child) => setImmediate(() => child.emit("error", new Error("ENOENT")))).spawn;
  assert.match((await createCalendarBridge({ helperPath: HELPER, spawn: noStart }).call("status", {})).error, /could not start Calendar/);
  const throws = () => { throw new Error("EACCES"); };
  assert.match((await createCalendarBridge({ helperPath: HELPER, spawn: throws }).call("status", {})).error, /could not start Calendar/);
  const flood = stubSpawn((child) => setImmediate(() => child.stdout.emit("data", Buffer.alloc(4_100_000, 97)))).spawn;
  assert.match((await createCalendarBridge({ helperPath: HELPER, spawn: flood }).call("events", { start: "a", end: "b" })).error, /too much at once/);
});

test("bridge timeouts: 130 s for request (a person reads a prompt), 35 s otherwise; the helper is killed and the reply says so", async () => {
  assert.equal(REQUEST_TIMEOUT_MS, 130_000);
  assert.equal(CALL_TIMEOUT_MS, 35_000);
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; };
  const clearTimer = () => {};
  const never = stubSpawn(() => {});
  const bridge = createCalendarBridge({ helperPath: HELPER, spawn: never.spawn, setTimer, clearTimer });
  const req = bridge.call("request", {});
  const st = bridge.call("status", {});
  assert.deepEqual(timers.map((t) => t.ms), [130_000, 35_000]);
  timers[0].fn(); timers[1].fn();
  const [r, s] = await Promise.all([req, st]);
  assert.match(r.error, /permission prompt was not answered in time/);
  assert.match(s.error, /did not answer in time/);
  assert.deepEqual(never.spawned.map((x) => x.child.killed), [true, true]);
});

// ---------------------------------------------------------------- the IPC guard

test("IPC guard: only our own window reaches the helper; any other sender is refused before the bridge is touched", async () => {
  const calls = [];
  const bridge = { call: async (op, args) => { calls.push([op, args]); return { ok: true, result: op }; } };
  const ours = (e) => e.senderFrame?.url?.startsWith("http://127.0.0.1:48123/");
  const handler = createCalendarHandler({ bridge, isOurUi: ours });
  assert.deepEqual(await handler({ senderFrame: { url: "http://127.0.0.1:48123/" } }, "status", {}), { ok: true, result: "status" });
  for (const e of [{ senderFrame: { url: "https://evil.example/" } }, { senderFrame: { url: "http://127.0.0.1:9999/" } }, { senderFrame: { url: "file:///etc/passwd" } }, { senderFrame: null }, {}, null]) {
    assert.deepEqual(await handler(e, "events", { start: "a", end: "b" }), { ok: false, error: NOT_OUR_WINDOW });
  }
  assert.equal(calls.length, 1, "nothing but our own window got through");
  const broken = createCalendarHandler({ bridge, isOurUi: () => { throw new Error("boom"); } });
  assert.deepEqual(await broken({}, "status", {}), { ok: false, error: NOT_OUR_WINDOW });
  const truthyButNotTrue = createCalendarHandler({ bridge, isOurUi: () => "yes" });
  assert.deepEqual(await truthyButNotTrue({}, "status", {}), { ok: false, error: NOT_OUR_WINDOW });
});

test("main.mjs registers the channel on a Mac only, behind the same fromOurUi check as the other IPC, and never handles the helper elsewhere", () => {
  const main = read("src/main.mjs");
  assert.equal(CALENDAR_CHANNEL, "desktop:calendar");
  assert.match(main, /import \{ CALENDAR_CHANNEL, createCalendarBridge, createCalendarHandler, findCalendarHelper \} from "\.\/lib\/calendar\.mjs";/);
  assert.match(main, /if \(process\.platform === "darwin"\) \{[\s\S]*?ipcMain\.handle\(CALENDAR_CHANNEL, createCalendarHandler\(\{ bridge: createCalendarBridge\(\{ helperPath, spawn \}\), isOurUi: fromOurUi \}\)\);[\s\S]*?\}/);
  assert.match(main, /const fromOurUi = \(e\) => classifyUrl\(e\.senderFrame\?\.url \?\? "", gatewayInfo\?\.origin\) === "internal";/);
  assert.equal((main.match(/CALENDAR_CHANNEL/g) ?? []).length, 2, "imported once, registered once");
});

test("preload: calendar.call exists on a Mac only and sends nothing but the seven ops", () => {
  const pre = read("src/preload.cjs");
  assert.match(pre, /\.\.\.\(process\.platform === "darwin" \? \{\s*calendar: Object\.freeze\(\{/);
  assert.match(pre, /ipcRenderer\.invoke\("desktop:calendar"/);
  assert.match(pre, /CALENDAR_OPS = \["status", "request", "calendars", "events", "create", "update", "delete"\]/);
});

// ---------------------------------------------------------------- where the helper lives

test("helper lookup: <resources>/bin when packaged, desktop/build/bin in development, never off a Mac", () => {
  const has = new Set(["/R/bin/daebot-calendar"]);
  const exists = (p) => has.has(p);
  assert.equal(findCalendarHelper({ resourcesPath: "/R", platform: "darwin", exists }), "/R/bin/daebot-calendar");
  assert.equal(findCalendarHelper({ resourcesPath: "/other", devDir: "/R/bin", platform: "darwin", exists }), "/R/bin/daebot-calendar");
  assert.equal(findCalendarHelper({ resourcesPath: "/nope", platform: "darwin", exists }), null);
  assert.equal(findCalendarHelper({ resourcesPath: "/R", platform: "win32", exists }), null);
  assert.equal(findCalendarHelper({ resourcesPath: "/R", platform: "linux", exists }), null);
  assert.equal(findCalendarHelper({}), null);
});

// ---------------------------------------------------------------- the build

test("build plan: both slices (arm64 + x86_64) from main.swift, the usage strings embedded, joined with lipo into one universal binary", () => {
  assert.deepEqual(ARCHS, ["arm64", "x86_64"]);
  const plan = calendarHelperPlan({ outDir: "/out", tmpDir: "/tmp/x" });
  assert.deepEqual(plan.compile.map((c) => c.arch), ["arm64", "x86_64"]);
  for (const c of plan.compile) {
    assert.deepEqual(c.args.slice(0, 5), ["swiftc", "-O", "-target", `${c.arch}-apple-macos${MIN_MACOS}`, "-o"]);
    assert.ok(c.args.some((a) => a.endsWith("native/calendar/main.swift")));
    assert.ok(c.args.join(" ").includes("-sectcreate -Xlinker __TEXT -Xlinker __info_plist"));
    assert.ok(c.args.some((a) => a.endsWith("native/calendar/Info.plist")));
  }
  assert.deepEqual(plan.lipo.args, ["lipo", "-create", plan.compile[0].out, plan.compile[1].out, "-output", `/out/${HELPER_NAME}`]);
  assert.equal(plan.out, "/out/daebot-calendar");
  assert.equal(HELPER_NAME, "daebot-calendar");
});

test("build: off a Mac it refuses when required and skips quietly when not; a failing compile fails a required build", () => {
  assert.throws(() => buildCalendarHelper({ platform: "linux", required: true }), /only be built on a Mac/);
  assert.equal(buildCalendarHelper({ platform: "win32", required: false }), null);
  const fail = () => ({ status: 1 });
  assert.throws(() => buildCalendarHelper({ platform: "darwin", run: fail, required: true, outDir: mkdtempSync(join(tmpdir(), "daebot-cal-test-")) }), /swiftc failed/);
  const logs = [];
  assert.equal(buildCalendarHelper({ platform: "darwin", run: fail, required: false, log: (m) => logs.push(m), outDir: mkdtempSync(join(tmpdir(), "daebot-cal-test-")) }), null);
  assert.match(logs.join(" "), /not built/);
});

test("the mac build compiles the helper (a mac release without it fails) and ships it; the host build only warns", () => {
  const stage = read("scripts/stage-bin.mjs");
  assert.match(stage, /buildCalendarHelper\(\{ outDir: outdir, required: platform === "mac" \}\)/);
  assert.match(stage, /platform === "mac" \|\| \(platform === "host" && process\.platform === "darwin"\)/);
  assert.deepEqual(targetsFor("mac"), ["bun-darwin-arm64", "bun-darwin-x64"]);
  const cfg = read("electron-builder.config.mjs");
  assert.match(cfg, /filter: \["daebot-darwin-\*", "daebot-calendar"\]/);
  assert.ok(!/win: \{[\s\S]*?daebot-calendar/.test(cfg), "Windows ships no Mac helper");
  assert.ok(!/linux: \{[\s\S]*?daebot-calendar/.test(cfg), "Linux ships no Mac helper");
});

test("entitlement and usage strings: the calendars entitlement, NSCalendarsUsageDescription and NSCalendarsFullAccessUsageDescription, microphone kept", () => {
  const plist = read("build-resources/entitlements.mac.plist");
  assert.match(plist, /<key>com\.apple\.security\.personal-information\.calendars<\/key>\s*<true\/>/);
  assert.match(plist, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/, "microphone entitlement is still there");
  const cfg = read("electron-builder.config.mjs");
  assert.match(cfg, /NSMicrophoneUsageDescription: "Daebot uses the microphone/);
  assert.match(cfg, /NSCalendarsUsageDescription: "[^"]+Apple Calendar[^"]*"/);
  assert.match(cfg, /NSCalendarsFullAccessUsageDescription: "[^"]+Apple Calendar[^"]*"/);
  const info = read("native/calendar/Info.plist");
  assert.match(info, /NSCalendarsUsageDescription/);
  assert.match(info, /NSCalendarsFullAccessUsageDescription/);
});

test("the Swift helper speaks the contract: every op, EventKit full access on macOS 14+ with the older call as fallback, JSON in and out", () => {
  const swift = read("native/calendar/main.swift");
  for (const op of ["status", "request", "calendars", "events", "create", "update", "delete"]) assert.match(swift, new RegExp(`case "${op}"`), op);
  assert.match(swift, /requestFullAccessToEvents/);
  assert.match(swift, /requestAccess\(to: \.event/);
  assert.match(swift, /#available\(macOS 14\.0, \*\)/);
  for (const access of ["granted", "denied", "notDetermined", "restricted", "writeOnly"]) assert.match(swift, new RegExp(`"${access}"`), access);
  assert.match(swift, /standardInput\.readDataToEndOfFile/);
  assert.match(swift, /let maxEvents = 500/);
  assert.match(swift, /allowsModify/);
  assert.match(swift, /calendarTitle/);
});
