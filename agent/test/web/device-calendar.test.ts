import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain browser module
import { CALENDAR_OPS, calendarCapabilities, createDeviceCalls, deviceCalendar, fitResult } from "../../web/device-calendar.js";

const web = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", f), "utf8");

/** A fake window with the iPhone bridge: postMessage returns the { ok, result | error } promise WKScriptMessageHandlerWithReply gives. */
function iphone(reply: (m: { op: string; args: unknown }) => unknown) {
  const sent: { op: string; args: unknown }[] = [];
  return { sent, win: { webkit: { messageHandlers: { daebotCalendar: { postMessage: async (m: { op: string; args: unknown }) => { sent.push(m); return reply(m); } } } } } };
}
/** A fake window with the Mac bridge (window.mindclawDesktop.calendar.call). */
function mac(reply: (op: string, args: unknown) => unknown) {
  const sent: { op: string; args: unknown }[] = [];
  return { sent, win: { mindclawDesktop: { platform: "darwin", calendar: { call: async (op: string, args: unknown) => { sent.push({ op, args }); return reply(op, args); } } } } };
}

test("no bridge, no calendar: a plain browser, Windows and Linux desktops, Android all get null and offer no capability", () => {
  for (const win of [{}, { webkit: {} }, { webkit: { messageHandlers: {} } }, { mindclawDesktop: { platform: "win32" } }, { mindclawDesktop: { platform: "linux", notify() {} } }, undefined, null]) {
    assert.equal(deviceCalendar(win as any), null);
    assert.deepEqual(calendarCapabilities(win as any), []);
  }
  assert.equal(deviceCalendar({ webkit: { messageHandlers: { daebotCalendar: {} } } } as any), null, "a handler that cannot post is no bridge");
});

test("iPhone: detected by webkit.messageHandlers.daebotCalendar; call posts { op, args } and unwraps { ok, result }", async () => {
  const { win, sent } = iphone(() => ({ ok: true, result: [{ id: "c1", title: "Home" }] }));
  const cal = deviceCalendar(win as any);
  assert.ok(cal);
  assert.deepEqual(calendarCapabilities(win as any), ["apple_calendar"]);
  assert.deepEqual(await cal.call("calendars", {}), [{ id: "c1", title: "Home" }]);
  await cal.call("events", { start: "a", end: "b" });
  assert.deepEqual(sent, [{ op: "calendars", args: {} }, { op: "events", args: { start: "a", end: "b" } }]);
});

test("Mac: detected by window.mindclawDesktop.calendar; same shape", async () => {
  const { win, sent } = mac(() => ({ ok: true, result: { deleted: true } }));
  const cal = deviceCalendar(win as any);
  assert.ok(cal);
  assert.deepEqual(await cal.call("delete", { id: "e1" }), { deleted: true });
  assert.deepEqual(sent, [{ op: "delete", args: { id: "e1" } }]);
});

test("an error from native code becomes a rejection carrying the sentence the user can act on", async () => {
  const msg = "Calendar access is off for Daebot. Turn it on in Settings > Privacy & Security > Calendars.";
  const cal = deviceCalendar(iphone(() => ({ ok: false, error: msg })).win as any);
  await assert.rejects(cal.call("events", {}), (e: Error) => e.message === msg);
  await assert.rejects(deviceCalendar(iphone(() => ({ ok: false })).win as any).call("status"), /could not do that/);
  await assert.rejects(deviceCalendar(iphone(() => "garbage").win as any).call("status"), /could not read/);
  const throwing = { webkit: { messageHandlers: { daebotCalendar: { postMessage: async () => { throw new Error("bridge down"); } } } } };
  await assert.rejects(deviceCalendar(throwing as any).call("status"), /bridge down/);
});

test("only the seven ops go to native code", async () => {
  const { win, sent } = iphone(() => ({ ok: true, result: null }));
  const cal = deviceCalendar(win as any);
  assert.deepEqual([...CALENDAR_OPS], ["status", "request", "calendars", "events", "create", "update", "delete"]);
  for (const op of ["eval", "exportAll", "", "STATUS", undefined]) await assert.rejects(cal.call(op as any, {}), /not supported/);
  assert.equal(sent.length, 0);
});

test("status also carries the device time zone (the agent writes every time in the user's own zone)", async () => {
  const cal = deviceCalendar(iphone(() => ({ ok: true, result: { access: "granted" } })).win as any);
  const st = await cal.call("status");
  assert.equal(st.access, "granted");
  assert.equal(st.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const own = deviceCalendar(iphone(() => ({ ok: true, result: { access: "granted", timeZone: "Europe/Rome" } })).win as any);
  assert.equal((await own.call("status")).timeZone, "Europe/Rome", "a zone the device reports itself is kept");
});

// ---------------------------------------------------------------- the dispatcher

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}
const callEv = (id: string, op = "status", args: Record<string, unknown> = {}) => ({ type: "device_call", id, tool: "apple_calendar", op, args });

test("dispatcher: runs the call on the device and POSTs { id, ok, result } to the right session", async () => {
  const { win, sent } = iphone(() => ({ ok: true, result: { access: "granted" } }));
  const posts: [string, any][] = [];
  const dc = createDeviceCalls({ post: async (sid: string, body: any) => void posts.push([sid, body]), getCalendar: () => deviceCalendar(win as any), storage: memStore() });
  assert.equal(await dc.handle("sess-1", callEv("d1", "events", { start: "a", end: "b" })), true);
  assert.deepEqual(sent, [{ op: "events", args: { start: "a", end: "b" } }]);
  assert.deepEqual(posts.map(([s, b]) => [s, b.id, b.ok]), [["sess-1", "d1", true]]);
  assert.deepEqual(posts[0][1].result, { access: "granted" });
});

test("dispatcher: a native error is posted as { ok: false, error }, never swallowed", async () => {
  const { win } = iphone(() => ({ ok: false, error: "Calendar access is off for Daebot." }));
  const posts: any[] = [];
  const dc = createDeviceCalls({ post: async (_s: string, b: any) => void posts.push(b), getCalendar: () => deviceCalendar(win as any), storage: memStore() });
  await dc.handle("s", callEv("d1", "events"));
  assert.deepEqual(posts, [{ id: "d1", ok: false, error: "Calendar access is off for Daebot." }]);
});

test("dispatcher: a device with no bridge answers plainly instead of leaving the turn to time out", async () => {
  const posts: any[] = [];
  const dc = createDeviceCalls({ post: async (_s: string, b: any) => void posts.push(b), getCalendar: () => null, storage: memStore() });
  await dc.handle("s", callEv("d1"));
  assert.deepEqual(posts, [{ id: "d1", ok: false, error: "Apple Calendar works in the Daebot iPhone and Mac apps." }]);
});

test("dispatcher: ignores events that are not Apple Calendar device calls, and calls for another session", async () => {
  const { win, sent } = iphone(() => ({ ok: true, result: null }));
  const posts: any[] = [];
  const dc = createDeviceCalls({ post: async (_s: string, b: any) => void posts.push(b), getCalendar: () => deviceCalendar(win as any), storage: memStore() });
  for (const ev of [{ type: "text", delta: "x" }, { type: "device_call", id: "d1", tool: "camera", op: "snap", args: {} }, { type: "device_call", tool: "apple_calendar", op: "status" }, { type: "device_call", id: "", tool: "apple_calendar", op: "status" }, null, undefined]) {
    assert.equal(await dc.handle("s", ev as any), false);
  }
  assert.equal(await dc.handle("sess-A", { ...callEv("d2"), sessionId: "sess-B" } as any), false, "another session's call is not ours to answer");
  assert.equal(sent.length + posts.length, 0);
});

test("dispatcher: a call is never run twice, not even by a re-attached stream or after a reload", async () => {
  const { win, sent } = iphone(() => ({ ok: true, result: { deleted: true } }));
  const store = memStore();
  const posts: any[] = [];
  const make = () => createDeviceCalls({ post: async (_s: string, b: any) => void posts.push(b), getCalendar: () => deviceCalendar(win as any), storage: store });
  await make().handle("s", callEv("d1", "delete", { id: "e1" }));
  await make().handle("s", callEv("d1", "delete", { id: "e1" })); // a new page load: same session storage
  const dc = make();
  assert.equal(await dc.handle("s", callEv("d1", "delete", { id: "e1" })), true, "recognised as a device call");
  assert.equal(sent.length, 1, "the delete ran once");
  assert.equal(posts.length, 1);
});

test("dispatcher: works while the turn streams: handle() returns at once with the answer in flight, and a failing POST does not throw", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { win } = iphone(async () => { await gate; return { ok: true, result: [] }; });
  let posted = 0;
  const dc = createDeviceCalls({ post: async () => { posted++; throw new Error("offline"); }, getCalendar: () => deviceCalendar(win as any), storage: memStore() });
  const p = dc.handle("s", callEv("d1", "calendars"));
  let settled = false;
  void p.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, "waiting on the OS prompt");
  release();
  assert.equal(await p, true);
  assert.equal(posted, 1);
});

test("fitResult: an oversized answer drops notes first, then the tail, so it fits the gateway's body limit", () => {
  const small = [{ id: "1", notes: "hi" }];
  assert.equal(fitResult(small), small);
  const huge = Array.from({ length: 500 }, (_, i) => ({ id: String(i), title: "t".repeat(100), notes: "n".repeat(5000) }));
  const fit = fitResult(huge);
  assert.ok(JSON.stringify(fit).length <= 800_000);
  assert.equal(fit[0].notes, "");
  assert.equal(fit[0].id, "0");
});

// ---------------------------------------------------------------- wiring in the page

test("app.js: sends the capability only when the device has the bridge, and hands device_call events to the dispatcher on both stream paths", () => {
  const app = web("app.js");
  assert.match(app, /import \{ calendarCapabilities, createDeviceCalls \} from "\/device-calendar\.js";/);
  assert.match(app, /device-result/);
  assert.match(app, /const capabilities = calendarCapabilities\(\)/);
  assert.match(app, /\.\.\.\(capabilities\.length \? \{ capabilities \} : \{\}\)/);
  const handlers = app.match(/ev\.type === "device_call"\) \{ void deviceCalls\.handle\(id, ev\); return; \}/g) ?? [];
  assert.equal(handlers.length, 2, "the live send stream and the re-attached stream");
  assert.ok(!/\binnerHTML\b/.test(web("device-calendar.js")));
});
