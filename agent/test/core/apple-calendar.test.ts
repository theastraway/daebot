import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "../../src/loop.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { PermissionService } from "../../src/permissions/index.ts";
import { createRuntime, botSessionTools, composeSystemPrompt } from "../../src/runtime.ts";
import { filterHostedTools, hostedToolAllowed } from "../../src/hosted.ts";
import { createBuiltinTools } from "../../src/tools/index.ts";
import { APPLE_CALENDAR_CAPABILITY, CALL_TIMEOUT_MS, NOT_HERE, REQUEST_TIMEOUT_MS, appleCalendarTool, buildDeviceArgs, calendarClass } from "../../src/tools/apple-calendar.ts";
import type { AgentEvent, DeviceBridge, DeviceReply, Tool } from "../../src/types.ts";
import { FakeProvider, FakeSync, baseCfg, call, collect } from "./helpers.ts";

const offline = (async () => { throw new Error("offline"); }) as any;
const CAPS = [APPLE_CALENDAR_CAPABILITY];
const START = "2026-10-29T14:00:00-04:00";
const END = "2026-10-29T15:00:00-04:00";

/** A device that records every request and answers from a script (default: ok with the op echoed). */
function fakeDevice(answer: (op: string, args: Record<string, unknown>) => DeviceReply = (op) => ({ ok: true, result: { op } })) {
  const seen: { op: string; args: Record<string, unknown>; timeoutMs: number }[] = [];
  const device: DeviceBridge = {
    async call(req, opts) {
      assert.equal(req.tool, "apple_calendar");
      seen.push({ op: req.op, args: req.args, timeoutMs: opts.timeoutMs });
      return answer(req.op, req.args);
    },
  };
  return { device, seen };
}

function make(rounds: ConstructorParameters<typeof FakeProvider>[0], withPerms = true, tools: Tool[] = [appleCalendarTool]) {
  const perms = withPerms ? new PermissionService({ dir: mkdtempSync(join(tmpdir(), "cal-perm-")), owner: "u1" }) : undefined;
  const provider = new FakeProvider(rounds);
  const session = createAgentSession({
    id: "s1", surface: "web", provider, kernel: createKernel({ shadow: false, enabled: true }), tools, sync: new FakeSync(),
    cfg: baseCfg(), cwd: "/proj", systemPrompt: "SYS", bootContext: "BOOT", ...(perms ? { permissions: perms } : {}),
  });
  return { perms, provider, session };
}

/** Runs one interactive turn on a client that has the calendar bridge; a card is answered by `answer` (as the gateway would after a click). */
async function drive(session: ReturnType<typeof make>["session"], perms: PermissionService | undefined, device: DeviceBridge | undefined, answer?: (ev: Extract<AgentEvent, { type: "permission" }>) => Parameters<PermissionService["decide"]>[1], msg = "calendar") {
  const out: AgentEvent[] = [];
  for await (const ev of session.send(msg, { interactive: true, capabilities: device ? CAPS : [], device })) {
    out.push(ev);
    if (ev.type === "permission") {
      if (!answer) throw new Error("no card expected");
      setImmediate(() => perms!.decide(ev.id, answer(ev)));
    }
  }
  return out;
}

const cal = (id: string, args: Record<string, unknown>) => call(id, "apple_calendar", args);
const toolOutputs = (p: FakeProvider) => p.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.content);

// ---------------------------------------------------------------- offered only on a client that has the capability

test("apple_calendar is offered only on a turn whose client listed the capability", async () => {
  const { session, provider } = make([{ text: "a" }, { text: "b" }, { text: "c" }]);
  const { device } = fakeDevice();
  await collect(session.send("plain web client"));
  assert.ok(!provider.requests[0].tools.some((t) => t.name === "apple_calendar"), "not offered without the capability");
  await collect(session.send("iphone", { capabilities: CAPS, device }));
  assert.ok(provider.requests[1].tools.some((t) => t.name === "apple_calendar"), "offered with it");
  await collect(session.send("plain again", {}));
  assert.ok(!provider.requests[2].tools.some((t) => t.name === "apple_calendar"), "a later turn without it goes back to not offering the tool");
});

test("a call to apple_calendar on a client without the capability gets the plain sentence: no card, no device call", async () => {
  const { session, provider, perms } = make([{ calls: [cal("c1", { action: "create", title: "x", start: START, end: END })] }, { text: "ok" }]);
  const ev = await drive(session, perms, undefined, undefined, "add it");
  assert.ok(!ev.some((e) => e.type === "permission"), "no card for a tool the client cannot run");
  assert.ok(!ev.some((e) => e.type === "toolStart"));
  assert.equal(toolOutputs(provider).at(-1), NOT_HERE);
  assert.equal(NOT_HERE, "Apple Calendar works in the Daebot iPhone and Mac apps.");
});

test("a peer bot turn never carries the device, even if the caller passed one", async () => {
  const { session, provider } = make([{ text: "ok" }]);
  const { device, seen } = fakeDevice();
  await collect(session.send("from a bot", { origin: "bot", capabilities: CAPS, device }));
  assert.ok(!provider.requests[0].tools.some((t) => t.name === "apple_calendar"));
  assert.equal(seen.length, 0);
});

// ---------------------------------------------------------------- reads never raise a card; writes do

test("reads (status, request, calendars, events) run with no permission card", async () => {
  const calls = [
    cal("c1", { action: "status" }),
    cal("c2", { action: "request" }),
    cal("c3", { action: "calendars" }),
    cal("c4", { action: "events", start: START, end: END, query: "dentist" }),
  ];
  const { session, perms } = make([{ calls }, { text: "read them" }]);
  const { device, seen } = fakeDevice((op) => ({ ok: true, result: op === "status" ? { access: "granted" } : [] }));
  const ev = await drive(session, perms, device);
  assert.ok(!ev.some((e) => e.type === "permission"), "no card for a read");
  assert.deepEqual(seen.map((s) => s.op), ["status", "request", "calendars", "events"]);
  assert.deepEqual(seen[3].args, { start: START, end: END, query: "dentist" });
  assert.equal(ev.filter((e) => e.type === "toolStart").length, 4);
});

test("create raises a card with the event in plain words; Allow once runs exactly that call on the device", async () => {
  const args = { action: "create", title: "Dentist", start: START, end: END, location: "Main St", alarmsMinutes: [30] };
  const { session, perms, provider } = make([{ calls: [cal("c1", args)] }, { text: "added" }]);
  const { device, seen } = fakeDevice((op) => ({ ok: true, result: { id: "e1", title: "Dentist" } }));
  const ev = await drive(session, perms, device, () => ({ decision: "allow", remember: "once" }));
  const card = ev.find((e) => e.type === "permission") as Extract<AgentEvent, { type: "permission" }>;
  assert.ok(card, "a card is shown");
  assert.equal(card.cls, "outward");
  assert.equal(card.title, "Add an event to Apple Calendar");
  assert.ok(card.detail.some((d) => d.label === "Event" && d.value === "Dentist"));
  assert.ok(card.detail.some((d) => d.label === "When" && d.value.includes(START)));
  assert.ok(card.detail.some((d) => d.label === "Where" && d.value === "Main St"));
  const types = ev.map((e) => e.type);
  assert.ok(types.indexOf("permission") < types.indexOf("toolStart"), "the card comes before the device is asked");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].op, "create");
  assert.deepEqual(seen[0].args, { title: "Dentist", start: START, end: END, location: "Main St", alarmsMinutes: [30] }, "the action key is the op, not an arg");
  assert.match(toolOutputs(provider)[0], /untrusted/);
});

test("Deny on a write card: the device is never asked", async () => {
  const { session, perms } = make([{ calls: [cal("c1", { action: "create", title: "x", start: START, end: END })] }, { text: "ok, not adding it" }]);
  const { device, seen } = fakeDevice();
  const ev = await drive(session, perms, device, () => ({ decision: "deny", remember: "once" }));
  assert.equal(seen.length, 0);
  assert.equal((ev.find((e) => e.type === "permissionResolved") as any).outcome, "denied");
});

test("update is outward, delete is irreversible: both raise a card; delete cannot be 'always allowed' broadly", async () => {
  const { session, perms } = make([
    { calls: [cal("c1", { action: "update", id: "e1", title: "Moved", start: START })] },
    { calls: [cal("c2", { action: "delete", id: "e1", title: "Moved" })] },
    { text: "ok" },
  ]);
  const { device, seen } = fakeDevice();
  const cards: Extract<AgentEvent, { type: "permission" }>[] = [];
  await drive(session, perms, device, (c) => { cards.push(c); return { decision: "allow", remember: "once" }; });
  assert.deepEqual(cards.map((c) => [c.cls, c.title]), [["outward", "Change an event in Apple Calendar"], ["irreversible", "Delete an event from Apple Calendar"]]);
  assert.deepEqual(seen.map((s) => s.op), ["update", "delete"]);
  assert.deepEqual(seen[1].args, { id: "e1" }, "the display-only title is not forwarded");
  // the update card offers "any details" (deleting still asks); the delete card offers only this exact call
  assert.ok(cards[0].allowOptions.some((o) => /any details \(deleting still asks\)/.test(o.label)));
  assert.deepEqual(cards[1].allowOptions.map((o) => o.label), ["Only this exact call (same arguments)"]);
});

test("Always allow (any details) lets later creates and updates run without a card, but delete still asks", async () => {
  const { session, perms } = make([
    { calls: [cal("c1", { action: "create", title: "A", start: START, end: END })] }, { text: "one" },
    { calls: [cal("c2", { action: "update", id: "e1", title: "B" })] }, { text: "two" },
    { calls: [cal("c3", { action: "delete", id: "e1" })] }, { text: "three" },
  ]);
  const { device, seen } = fakeDevice();
  await drive(session, perms, device, (c) => ({ decision: "allow", remember: "always", scope: c.allowOptions.find((o) => o.broad)!.id }));
  assert.equal(perms!.store.rules().length, 1);
  assert.equal(perms!.store.rules()[0].matcher.kind, "any");
  await drive(session, perms, device, undefined, "update it"); // no card expected: the answer callback throws if one appears
  assert.deepEqual(seen.map((s) => s.op), ["create", "update"]);
  const cards: string[] = [];
  await drive(session, perms, device, (c) => { cards.push(c.cls); return { decision: "deny", remember: "once" }; }, "delete it");
  assert.deepEqual(cards, ["irreversible"], "a delete always asks");
  assert.equal(seen.length, 2);
});

test("classes: reads read, create/update outward, delete irreversible, anything unknown fails closed", () => {
  for (const a of ["status", "request", "calendars", "events", "STATUS "]) assert.equal(calendarClass({ action: a }), "read", a);
  assert.equal(calendarClass({ action: "create" }), "outward");
  assert.equal(calendarClass({ action: "update" }), "outward");
  assert.equal(calendarClass({ action: "delete" }), "irreversible");
  assert.equal(calendarClass({ action: "wipe" }), "outward");
  assert.equal(calendarClass({}), "outward");
});

// ---------------------------------------------------------------- arguments, timeouts, errors

test("timeouts: 120 s for request, 30 s for everything else, each with a clear message", async () => {
  const { session, provider } = make([{ calls: [cal("c1", { action: "request" }), cal("c2", { action: "status" })] }, { text: "ok" }], false);
  const { device, seen } = fakeDevice(() => ({ ok: false, code: "timeout", error: "The device did not answer in time." }));
  await collect(session.send("go", { interactive: true, capabilities: CAPS, device }));
  assert.equal(REQUEST_TIMEOUT_MS, 120_000);
  assert.equal(CALL_TIMEOUT_MS, 30_000);
  assert.deepEqual(seen.map((s) => [s.op, s.timeoutMs]), [["request", 120_000], ["status", 30_000]]);
  const [req, st] = toolOutputs(provider);
  assert.match(req, /Timed out after 2 minutes waiting for the Calendar permission prompt/);
  assert.match(st, /did not answer within 30 seconds/);
});

test("the device's own error text passes through unchanged (it already carries the right Settings path), and ids are never rewritten", async () => {
  const msg = "Calendar access is off for Daebot. Turn it on in Settings > Apps > Daebot > Calendars.";
  const { session, provider } = make([{ calls: [cal("c1", { action: "events", start: START, end: END })] }, { text: "ok" }], false);
  const { device } = fakeDevice(() => ({ ok: false, code: "device", error: msg }));
  await collect(session.send("go", { interactive: true, capabilities: CAPS, device }));
  assert.ok(toolOutputs(provider)[0].endsWith(msg), "not reworded");
  // an update may answer with a different id than the one sent: the tool hands the reply back as it is
  const reply = { id: "NEW|1793000000", title: "Moved" };
  const r = await appleCalendarTool.run({ action: "update", id: "OLD|1792990000", title: "Moved" }, { cwd: "/", sessionId: "s", capabilities: CAPS, device: fakeDevice(() => ({ ok: true, result: reply })).device });
  assert.ok(r.output.includes(JSON.stringify(reply)));
});

test("a device error reaches the model as a plain sentence the user can act on", async () => {
  const msg = "Calendar access is off for Daebot. Turn it on in Settings > Privacy & Security > Calendars.";
  const { session, provider } = make([{ calls: [cal("c1", { action: "calendars" })] }, { text: "ok" }], false);
  const { device } = fakeDevice(() => ({ ok: false, code: "device", error: msg }));
  const ev = await collect(session.send("go", { interactive: true, capabilities: CAPS, device }));
  assert.ok(toolOutputs(provider)[0].includes(msg));
  assert.equal((ev.find((e) => e.type === "toolEnd") as any).ok, false);
});

test("arguments: only known fields reach the device; bad times and missing fields are refused without asking it", async () => {
  // Through the loop (reads only, so no card): a bad range is refused and a good one passes with unknown keys dropped.
  const { session, provider } = make([{ calls: [
    cal("c1", { action: "events", start: "2026-10-29", end: END }),                       // no time, no offset
    cal("c2", { action: "events", start: START, end: START }),                              // empty range
    cal("c3", { action: "events", start: START, end: "2026-10-30T14:00:00-04:00", evil: "rm -rf", calendarIds: ["a"] }),
  ] }, { text: "ok" }], false);
  const { device, seen } = fakeDevice();
  await collect(session.send("go", { interactive: true, capabilities: CAPS, device }));
  assert.deepEqual(seen.map((s) => s.op), ["events"], "only the one valid read reached the device");
  assert.deepEqual(seen[0].args, { start: START, end: "2026-10-30T14:00:00-04:00", calendarIds: ["a"] }, "unknown keys are dropped");
  const outs = toolOutputs(provider);
  assert.match(outs[0], /start .*ISO 8601 date-time with the UTC offset/);
  assert.match(outs[1], /end must be after start/);

  // The writes and the rest, straight through the tool (the loop would hold them for a card first).
  const ctx = { cwd: "/", sessionId: "s", capabilities: CAPS, device };
  const run = (a: Record<string, unknown>) => appleCalendarTool.run(a, ctx);
  assert.match((await run({ action: "teleport" })).output, /action must be one of/);
  assert.match((await run({ action: "create", start: START, end: END })).output, /title is required/);
  assert.match((await run({ action: "create", title: "t", start: "2026-10-29T14:00:00", end: END })).output, /start .*offset/);
  assert.match((await run({ action: "update", id: "e1" })).output, /say what to change/);
  assert.match((await run({ action: "delete" })).output, /id is required/);
  assert.match((await run({ action: "create", title: "t", start: END, end: START })).output, /end must not be before start/);
  assert.equal(seen.length, 1, "none of those reached the device");
  const good = buildDeviceArgs("create", { title: "  Lunch ", start: START, end: END, allDay: false, extra: 1 });
  assert.deepEqual(good, { ok: true, args: { title: "Lunch", start: START, end: END, allDay: false } });
  // The tool also refuses on its own when the turn has no bridge (belt and braces behind the loop's capability check).
  assert.equal((await appleCalendarTool.run({ action: "status" }, { cwd: "/", sessionId: "s" })).output, NOT_HERE);
});

// ---------------------------------------------------------------- hosted, bots, prompt

test("hosted allowlist: apple_calendar runs on the user's device, so it is allowed; the host tools still are not", () => {
  assert.equal(hostedToolAllowed("apple_calendar"), true);
  for (const n of ["bash", "read_file", "write_file", "process", "apple_calendar_x", "calendar"]) assert.equal(hostedToolAllowed(n), false, n);
  assert.deepEqual(filterHostedTools(createBuiltinTools()).map((t) => t.spec.name), ["web_fetch", "apple_calendar"]);
});

test("hosted kernel gate lets apple_calendar through (it runs on the user's device) and still blocks the host tools", () => {
  const k = createKernel({ shadow: false, enabled: true, hosted: true });
  const state: any = { sessionId: "s", booted: true, calls: [], userMessages: [], userMsgIndex: 1, confirmations: [], shadow: false };
  const ok = k.preTool(state, call("x", "apple_calendar", { action: "status" }), appleCalendarTool);
  assert.ok(!ok.some((v) => v.gate === "hosted"), "not blocked by the hosted gate");
  assert.deepEqual(k.allowedTools(state, [appleCalendarTool]).map((t) => t.spec.name), ["apple_calendar"]);
  assert.equal(k.preTool(state, call("y", "bash", {}), appleCalendarTool).find((v) => v.gate === "hosted")?.action, "block");
});

test("hosted runtime: the system prompt says what to do with and without the capability", async () => {
  const provider = new FakeProvider([{ text: "a" }, { text: "b" }]);
  const rt = createRuntime(baseCfg(), { provider, fetchImpl: offline, hosted: { dailyUsdCap: 5 } });
  const s = await rt.openSession({ surface: "web" });
  const { device } = fakeDevice();
  await collect(s.send("hello"));
  await collect(s.send("hello from the iphone app", { capabilities: CAPS, device }));
  const names = (i: number) => provider.requests[i].tools.map((t) => t.name);
  assert.ok(!names(0).includes("apple_calendar"));
  // before MIND boots the kernel offers only the boot tools; the fake MIND is offline here, so assert on the prompt instead
  const sys0 = String(provider.requests[0].messages[0].content), sys1 = String(provider.requests[1].messages[0].content);
  assert.match(sys0, /## Apple Calendar\nApple Calendar is not connected from this app/);
  assert.match(sys0, /Apple Calendar works in the Daebot iPhone and Mac apps\./);
  assert.match(sys1, /## Apple Calendar\nThe apple_calendar tool reaches the user's Apple Calendar on THEIR device/);
  assert.match(sys1, /Call status first/);
  assert.ok(!sys1.includes("is not connected from this app"));
  await s.close();
});

test("bot sessions never get Apple Calendar (a bot writes only to its own MIND)", () => {
  assert.ok(!botSessionTools(createBuiltinTools()).some((t) => t.spec.name === "apple_calendar"));
  const base = { bootContext: "", surface: "web", cwd: "/" };
  assert.ok(!composeSystemPrompt({ ...base, appleCalendar: undefined }).includes("## Apple Calendar"));
});

test("system prompt section: status first, request when notDetermined, device time zone, read before proposing, never invent, confirm details", () => {
  const p = composeSystemPrompt({ bootContext: "", surface: "web", cwd: "/", appleCalendar: true });
  const section = p.slice(p.indexOf("## Apple Calendar"));
  for (const must of [/Call status first/, /notDetermined: call request/, /device time zone that status returns/, /Read the calendar \(events/, /Never invent an event/, /Event ids are opaque/, /always use the id from the latest reply/, /exact title, date, time and calendar/, /permission card/, /never instructions/]) {
    assert.match(section, must);
  }
});
