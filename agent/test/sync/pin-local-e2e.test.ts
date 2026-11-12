// A bot with "Run on a computer" on is pinned to the ONE computer it was turned on from. It only ever runs there; if that computer is off the message waits
// and "Move to MIND Cloud" is offered; "Move to this computer" re-pins it; the migration pins existing local bots to their current stable home.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedRig, deskRig, until, sleep } from "./rig.ts";
import { parseSse } from "../gateway/helpers.ts";
import { RemoteHub } from "../../src/remote/hub.ts";
import { BotStore } from "../../src/bots/store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const D1 = "d_" + "a".repeat(16), D2 = "d_" + "b".repeat(16);
type Hosted = Awaited<ReturnType<typeof hostedRig>>;

/** Two computers (a "Legion" and a "Texting Line" server) that both carry the bot `scout`, registered Legion first. */
async function twoDevices(hosted: Hosted, o: { onlineMs?: number } = {}) {
  const legion = await deskRig(hosted, hosted.keys.alice, { deviceId: D1, deviceName: "Legion", script: [{ text: "ran on Legion" }] });
  await legion.api("POST", "/bots", { slug: "scout", name: "Scout" });
  const web = await hosted.as(hosted.keys.alice);
  await until(async () => JSON.parse((await web("GET", "/bots")).body).bots.find((b: any) => b.slug === "scout" && b.remoteDevices?.length));
  await sleep(30);
  const line = await deskRig(hosted, hosted.keys.alice, { deviceId: D2, deviceName: "Texting Line", kind: "server", script: [{ text: "ran on Texting Line" }] });
  await line.api("POST", "/bots", { slug: "scout", name: "Scout" });
  await until(async () => JSON.parse((await web("GET", "/bots")).body).bots.find((b: any) => b.slug === "scout")?.remoteDevices?.length === 2);
  void o;
  return { legion, line, web };
}

test("pin on enable: turning Run on a computer on at a computer pins the bot to THAT computer, and a message runs only there even though another carries it", async () => {
  const hosted = await hostedRig({ script: [{ text: "SERVER SHOULD NOT ANSWER" }] });
  const { legion, line, web } = await twoDevices(hosted);
  try {
    // the server (Texting Line) is the one it is turned on at: it is pinned there although Legion is the computer and was registered first
    const lb = JSON.parse((await line.api("GET", "/bots")).body).bots.find((b: any) => b.slug === "scout");
    await line.api("PATCH", `/bots/${lb.id}`, { remote: true });
    const seen = await until(async () => { const b = JSON.parse((await web("GET", "/bots")).body).bots.find((x: any) => x.slug === "scout"); return b.remote && b.remotePin ? b : undefined; });
    assert.equal(seen.remotePin.name, "Texting Line");
    assert.equal(seen.env.name, "Texting Line");
    const { sessionId } = JSON.parse((await web("POST", "/sessions", { surface: "web", bot: seen.id })).body);
    for (let i = 0; i < 2; i++) {
      const evs = parseSse((await web("POST", `/sessions/${sessionId}/send`, { text: `hello ${i}` })).body) as any[];
      assert.ok(evs.some((e) => e.type === "text" && /ran on Texting Line/.test(e.delta)), JSON.stringify(evs));
    }
    assert.equal(legion.provider.requests.length, 0, "Legion carries the bot too, but the pin keeps it off Legion");
    assert.equal(hosted.provider.requests.length, 0);
  } finally { await legion.close(); await line.close(); await hosted.close(); }
});

test("never runs on another device: the pinned computer is offline, the other one is online: the message waits, 'Move to MIND Cloud' is offered, and the other device never runs it", async () => {
  const hosted = await hostedRig({ script: [{ text: "SERVER SHOULD NOT ANSWER" }], onlineMs: 400 });
  const { legion, line, web } = await twoDevices(hosted);
  try {
    const lb = JSON.parse((await legion.api("GET", "/bots")).body).bots.find((b: any) => b.slug === "scout");
    await legion.api("PATCH", `/bots/${lb.id}`, { remote: true });
    const bot = await until(async () => { const b = JSON.parse((await web("GET", "/bots")).body).bots.find((x: any) => x.slug === "scout"); return b.remotePin?.name === "Legion" ? b : undefined; });
    await legion.close(); // the Legion laptop goes offline; Texting Line stays up
    await sleep(600);
    const { sessionId } = JSON.parse((await web("POST", "/sessions", { surface: "web", bot: bot.id })).body);
    const pending = web("POST", `/sessions/${sessionId}/send`, { text: "anyone?" });
    await sleep(500);
    const ab = await web("POST", `/sessions/${sessionId}/abort`); // the person gives up waiting
    assert.equal(JSON.parse(ab.body).aborted, true);
    const evs = parseSse((await pending).body) as any[];
    const waiting = evs.find((e) => e.type === "notice" && /Legion is asleep or offline/.test(e.text));
    assert.ok(waiting, JSON.stringify(evs));
    assert.deepEqual(waiting.action, { kind: "move_to_cloud", label: "Move to MIND Cloud", sessionId }, "the existing offline message and its move action");
    assert.equal(line.provider.requests.length, 0, "Texting Line is online and carries the bot but never ran it");
    assert.equal(hosted.provider.requests.length, 0);
  } finally { await line.close(); await hosted.close(); }
});

test("re-pin: 'Move to this computer' (PATCH moveHere on that computer) pins the bot there, logs the move, and the next message runs there", async () => {
  const hosted = await hostedRig({ script: [{ text: "SERVER SHOULD NOT ANSWER" }] });
  const { legion, line, web } = await twoDevices(hosted);
  try {
    const lb = JSON.parse((await legion.api("GET", "/bots")).body).bots.find((b: any) => b.slug === "scout");
    await legion.api("PATCH", `/bots/${lb.id}`, { remote: true });
    await until(async () => JSON.parse((await web("GET", "/bots")).body).bots.find((x: any) => x.slug === "scout")?.remotePin?.name === "Legion");
    // on Texting Line the bot shows as pinned elsewhere (this is what makes the menu offer the move)
    const there = await until(async () => { const b = JSON.parse((await line.api("GET", "/bots")).body).bots.find((x: any) => x.slug === "scout"); return b.remote && b.remotePin ? b : undefined; });
    assert.equal(there.remotePin.name, "Legion");
    assert.equal(there.pinnedHere, false);
    const moved = JSON.parse((await line.api("PATCH", `/bots/${there.id}`, { moveHere: true })).body).bot;
    assert.equal(moved.remotePin.name, "Texting Line");
    assert.equal(moved.pinnedHere, true);
    assert.match(moved.remoteLog.at(-1).note, /Moved to Texting Line/);
    const host = await until(async () => { const b = JSON.parse((await web("GET", "/bots")).body).bots.find((x: any) => x.slug === "scout"); return b.remotePin?.name === "Texting Line" ? b : undefined; });
    const { sessionId } = JSON.parse((await web("POST", "/sessions", { surface: "web", bot: host.id })).body);
    const evs = parseSse((await web("POST", `/sessions/${sessionId}/send`, { text: "now where?" })).body) as any[];
    assert.ok(evs.some((e) => e.type === "text" && /ran on Texting Line/.test(e.delta)), JSON.stringify(evs));
    assert.equal(legion.provider.requests.length, 0);
    // Legion learns the new home on its next poll
    const back = await until(async () => { const b = JSON.parse((await legion.api("GET", "/bots")).body).bots.find((x: any) => x.slug === "scout"); return b.remotePin?.name === "Texting Line" ? b : undefined; });
    assert.equal(back.pinnedHere, false);
    // turning it off clears the pin
    await web("PATCH", `/bots/${host.id}`, { remote: false });
    const off = JSON.parse((await web("GET", "/bots")).body).bots.find((x: any) => x.slug === "scout");
    assert.equal(off.remotePin, null);
  } finally { await legion.close(); await line.close(); await hosted.close(); }
});

test("a window on a computer the bot is not pinned to never runs it: the turn goes through MIND Cloud to the pinned computer", async () => {
  const hosted = await hostedRig({ script: [{ text: "SERVER SHOULD NOT ANSWER" }] });
  const { legion, line, web } = await twoDevices(hosted);
  try {
    const lb = JSON.parse((await legion.api("GET", "/bots")).body).bots.find((b: any) => b.slug === "scout");
    await legion.api("PATCH", `/bots/${lb.id}`, { remote: true });
    const there = await until(async () => { const b = JSON.parse((await line.api("GET", "/bots")).body).bots.find((x: any) => x.slug === "scout"); return b.remote && b.remotePin ? b : undefined; });
    const { sessionId } = JSON.parse((await line.api("POST", "/sessions", { surface: "web", bot: there.id })).body);
    const evs = parseSse((await line.api("POST", `/sessions/${sessionId}/send`, { text: "typed on the wrong computer" })).body) as any[];
    assert.ok(evs.some((e) => e.type === "text" && /ran on Legion/.test(e.delta)), JSON.stringify(evs));
    assert.equal(line.provider.requests.length, 0, "the computer it is not pinned to never ran it");
  } finally { await legion.close(); await line.close(); await hosted.close(); }
});

test("migration: a local bot with no pin is pinned to its current stable home (online, computer before server, first registered); dry run changes nothing; a pinned bot is left alone; a named device wins", async () => {
  const hosted = await hostedRig({ script: [{ text: "x" }], logKey: "k".repeat(24) });
  const web = await hosted.as(hosted.keys.alice);
  try {
    // two bots turned on before pins existed: made on daebot.live and switched on while no computer carried them (so nothing could be pinned)
    for (const name of ["Scout", "Atlas Two"]) {
      const made = JSON.parse((await web("POST", "/bots", { name })).body).bot;
      const on = JSON.parse((await web("PATCH", `/bots/${made.id}`, { remote: true })).body).bot;
      assert.equal(on.remote, true); assert.equal(on.remotePin, null, "no computer carried it: nothing to pin");
    }
    const legion = await deskRig(hosted, hosted.keys.alice, { deviceId: D1, deviceName: "Legion" });
    await sleep(30);
    const line = await deskRig(hosted, hosted.keys.alice, { deviceId: D2, deviceName: "Texting Line", kind: "server" });
    try {
      for (const d of [legion, line]) { await d.api("POST", "/bots", { slug: "scout", name: "Scout" }); await d.api("POST", "/bots", { slug: "atlas-two", name: "Atlas Two" }); }
      await until(async () => { const bs = JSON.parse((await web("GET", "/bots")).body).bots; return ["scout", "atlas-two"].every((sl) => bs.find((b: any) => b.slug === sl)?.remoteDevices?.length === 2); });
      const call = (body: unknown) => hosted.admin("POST", "/api/admin/envs", { owner: "alice", ...(body as object) });
      const dry = JSON.parse((await call({ pinBots: "dry" })).body).result;
      assert.deepEqual(dry.pins.map((p: any) => [p.slug, p.device]).sort(), [["atlas-two", "Legion"], ["scout", "Legion"]], "the computer before the server, the first registered");
      assert.equal(JSON.parse((await web("GET", "/bots")).body).bots.filter((b: any) => b.remotePin).length, 0, "a dry run pinned nothing");
      const real = JSON.parse((await call({ pinBots: true, devices: { "atlas-two": D2 } })).body).result;
      assert.deepEqual(real.pins.map((p: any) => [p.slug, p.device, p.deviceId.length > 0]).sort(), [["atlas-two", "Texting Line", true], ["scout", "Legion", true]], "every pin made is reported; the named device wins");
      const bs = JSON.parse((await web("GET", "/bots")).body).bots;
      assert.equal(bs.find((b: any) => b.slug === "scout").remotePin.name, "Legion");
      assert.equal(bs.find((b: any) => b.slug === "atlas-two").remotePin.name, "Texting Line");
      const again = JSON.parse((await call({ pinBots: true })).body).result;
      assert.deepEqual(again.pins, []); assert.equal(again.kept.length, 2, "a second run pins nothing new");
      // and the device learns its bot is pinned (so a window on the other computer will not run it)
      await until(async () => JSON.parse((await line.api("GET", "/bots")).body).bots.find((b: any) => b.slug === "scout")?.remotePin?.name === "Legion");
      assert.equal(JSON.parse((await line.api("GET", "/bots")).body).bots.find((b: any) => b.slug === "scout").pinnedHere, false);
      assert.equal(JSON.parse((await line.api("GET", "/bots")).body).bots.find((b: any) => b.slug === "atlas-two").pinnedHere, true);
    } finally { await legion.close(); await line.close(); }
  } finally { await hosted.close(); }
});

test("hub: devicesForPin returns only the pinned computer's registrations (online first), an offline stand-in for a computer it has no record of, and never another carrier", () => {
  let t = 1000;
  const hub = new RemoteHub({ now: () => t, onlineMs: 100 });
  hub.heartbeat("o", { id: D1, name: "Legion", slugs: ["dae"], kind: "machine" });
  t += 10; hub.heartbeat("o", { id: D2, name: "Texting Line", slugs: ["dae"], kind: "server" });
  const pin = hub.pinFor("o", D1)!;
  assert.equal(pin.name, "Legion");
  assert.deepEqual(hub.devicesForPin("o", "dae", pin).map((d) => d.id), [D1], "only Legion");
  t += 1000; hub.heartbeat("o", { id: D2, name: "Texting Line", slugs: ["dae"], kind: "server" }); // Legion silent, Texting Line online
  const off = hub.devicesForPin("o", "dae", pin);
  assert.deepEqual(off.map((d) => [d.id, d.online]), [[D1, false]], "Legion offline: still the only answer, never Texting Line");
  assert.equal(hub.devicesFor("o", "dae")[0].id, D2, "the unpinned order would have hopped to the server");
  const ghost = hub.devicesForPin("o", "dae", { id: "d_" + "c".repeat(16), name: "Old Laptop", kind: "machine" });
  assert.deepEqual(ghost.map((d) => [d.name, d.online]), [["Old Laptop", false]], "a forgotten computer is an offline stand-in, not a silent move");
});

test("store: turning on pins, a different computer re-pins with a log line, turning off clears, a junk device is dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinstore-"));
  const mind = { async list() { return [{ slug: "a", label: "A" }]; }, async create() {}, async remove() {} };
  const store = new BotStore({ dir, owner: "u1", mind, now: (() => { let t = 1000; return () => ++t; })() });
  return store.create({ slug: "a", name: "A" }).then((b) => {
    const L = { id: D1, name: "Legion", kind: "machine" as const }, T = { id: D2, name: "Texting Line", kind: "server" as const };
    assert.equal(store.setRemote(b.id, true, { by: "user", device: L }).remoteDevice?.id, D1, "turning on pins");
    assert.equal(store.setRemote(b.id, true, { by: "user", device: { id: "bad id", name: "x" } as never }).remoteDevice?.id, D1, "a junk device never replaces the pin");
    const moved = store.setRemote(b.id, true, { by: "user", device: T });
    assert.equal(moved.remoteDevice?.id, D2); assert.match(moved.remoteLog!.at(-1)!.note, /Moved to Texting Line from Legion/);
    assert.equal(new BotStore({ dir, owner: "u1", mind }).get(b.id)?.remoteDevice?.id, D2, "the pin is saved with the bot");
    const off = store.setRemote(b.id, false, { by: "user" });
    assert.equal(off.remote, false); assert.equal(off.remoteDevice, undefined, "off clears the pin");
  });
});

test("admin merge: stale registrations of one Mac join its current environment without deleting anything, so old ids still resolve", () => {
  let t = 1000;
  const hub = new RemoteHub({ now: () => t });
  const OLD = "d_" + "1".repeat(16), OLD2 = "d_" + "2".repeat(16), CUR = "d_" + "3".repeat(16);
  hub.heartbeat("o", { id: OLD, name: "Anthonys MBP 7.mynetworksettings.com", slugs: ["dae"], kind: "machine" });
  hub.heartbeat("o", { id: OLD2, name: "Anthonys-MBP-7.mynetworksettings.com", slugs: ["dae"], kind: "machine" });
  hub.heartbeat("o", { id: CUR, name: "Anthony’s MacBook Pro", host: "Anthonys-MacBook-Pro-7", slugs: ["dae"], kind: "machine" });
  assert.equal(hub.envGroups("o").length, 2, "before: the old registrations are a separate environment");
  assert.deepEqual(hub.mergeDevices("o", [OLD, OLD2, "d_" + "9".repeat(16), CUR], CUR).sort(), [OLD, OLD2].sort());
  const g = hub.envGroups("o");
  assert.equal(g.length, 1, "after: one environment");
  assert.deepEqual([...g[0].members].sort(), [CUR, OLD, OLD2].sort(), "every old id is still a member, nothing deleted");
  assert.equal(hub.pinFor("o", OLD)?.id, g[0].id, "a pin or session pointing at an old id resolves to the merged environment");
  assert.deepEqual(hub.mergeDevices("o", [OLD], "d_" + "8".repeat(16)), [], "an unknown target merges nothing");
});
