// Where a saved session lives: the evidence the store holds, the automatic pass that assigns it, and the clean names, end to end.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_ENV, groupDevices } from "../../src/env.ts";
import type { DeviceLike } from "../../src/env.ts";
import { inferHome, pickComputer, readEvidence } from "../../src/sync/home.ts";
import { SyncService } from "../../src/sync/service.ts";
import type { SessionStore, StoredSession } from "../../src/persist.ts";
import type { HistoryEvent } from "../../src/types.ts";
import { hostedRig, until } from "./rig.ts";
import { rec } from "./helpers.ts";

const MAC = { id: "d_" + "1".repeat(16), kind: "machine" as const, name: "Anthonys MacBook Pro" };
const AIR = { id: "d_" + "2".repeat(16), kind: "machine" as const, name: "Macs MacBook Air" };
const dev = (id: string, name: string, lastSeen: number, o: Partial<DeviceLike> = {}): DeviceLike => ({ id, name, lastSeen, online: false, ...o });
const groups = groupDevices([dev(MAC.id, MAC.name, 500, { online: true }), dev("d_" + "3".repeat(16), "Anthonys-MBP-7.mynetworksettings.com", 100, { host: "Anthonys-MBP-7.mynetworksettings.com" }), dev(MAC.id.replace("1", "4"), MAC.name, 90), dev(AIR.id, AIR.name, 400)]);
const tool = (name: string, ok: boolean, preview = ""): HistoryEvent[] => [{ type: "toolStart", receiptId: "c1", tool: name, args: {} } as HistoryEvent, { type: "toolEnd", receiptId: "c1", tool: name, ok, preview } as HistoryEvent];
const withHistory = (id: string, surface: string, events: HistoryEvent[], o: Partial<StoredSession> = {}): StoredSession => ({ ...rec(id, { surface, texts: [["u1", "hi"]], ...o }), history: [{ type: "user", text: "hi", id: "u1" } as HistoryEvent, ...events] });

test("evidence: a tool daebot.live cannot run that returned ok means a computer; a refusal for being hosted does not", () => {
  assert.deepEqual(readEvidence(withHistory("a", "web", tool("bash", true))), { localTool: true, hostedRefusal: false });
  assert.deepEqual(readEvidence(withHistory("a", "web", tool("mind_query", true))), { localTool: false, hostedRefusal: false }, "a tool the hosted side runs proves nothing");
  assert.deepEqual(readEvidence(withHistory("a", "web", tool("screen", false, "screen: Screen watching is only available in the Daebot desktop app."))), { localTool: false, hostedRefusal: true });
  assert.deepEqual(readEvidence(withHistory("a", "web", tool("bash", false, "exit 1"))), { localTool: false, hostedRefusal: false }, "a failing command still ran somewhere, but says nothing about where");
});

test("inferHome: the pushing device, then a tool that ran, then a Remote bot, then surface desktop; with none of them it stays MIND Cloud", () => {
  const ctx = { groups };
  assert.equal(inferHome(rec("x", { env: AIR }), ctx).why, "has-home", "a home already there is never touched");
  assert.deepEqual(inferHome(withHistory("a", "web", []), { ...ctx, pusher: AIR }), { env: AIR, why: "pushed-by-device" });
  const t = inferHome(withHistory("b", "web", tool("bash", true)), ctx);
  assert.equal(t.why, "local-tool"); assert.equal(t.env.id, MAC.id, "the owner's main computer (registered most often) stands in when the record cannot say which");
  const botRec = withHistory("c", "web", tool("glob", true), { bot: "b_air" });
  assert.deepEqual(inferHome(botRec, { ...ctx, botHome: (id) => (id === "b_air" ? AIR : undefined) }), { env: AIR, why: "local-tool" }, "a thread of a Remote bot ran where its bot runs");
  assert.deepEqual(inferHome(withHistory("d", "web", [], { bot: "b_air" }), { ...ctx, botHome: () => AIR }), { env: AIR, why: "bot-remote" });
  assert.equal(inferHome(withHistory("e", "desktop", []), ctx).why, "surface-desktop");
  assert.deepEqual(inferHome(withHistory("f", "desktop", tool("screen", false, "only available in the Daebot desktop app")), ctx), { env: CLOUD_ENV, why: "no-evidence" }, "a desktop-surface chat the hosted side ran stays cloud");
  assert.deepEqual(inferHome(withHistory("g", "web", tool("mind_query", true)), ctx), { env: CLOUD_ENV, why: "no-evidence" });
  assert.deepEqual(inferHome(withHistory("h", "web", tool("bash", true)), { groups: [] }), { env: CLOUD_ENV, why: "no-evidence" }, "no computer registered: nowhere to put it");
  assert.equal(pickComputer([]), undefined);
});

function memStore(recs: StoredSession[]): SessionStore & { saved: string[]; all: Map<string, StoredSession> } {
  const all = new Map(recs.map((r) => [r.id, r]));
  const saved: string[] = [];
  const meta = (r: StoredSession) => ({ id: r.id, surface: r.surface, title: r.title, updatedAt: r.updatedAt, owner: r.owner, ...(r.env ? { env: r.env } : {}) });
  return { saved, all, async save(r) { all.set(r.id, r); saved.push(r.id); }, load: (id) => all.get(id), list: () => [...all.values()].map(meta) };
}

test("backfillHomes: every owner, once; a session with a home is not touched; a busy one waits; cloud stamps are only moved by proof, and only on the first pass", async () => {
  const mk = (id: string, owner: string, extra: Partial<StoredSession> = {}, ev: HistoryEvent[] = []) => ({ ...withHistory(id, "web", ev), owner, ...extra });
  const store = memStore([
    mk("plain", "alice"), mk("ran-local", "alice", {}, tool("bash", true)), mk("tagged", "alice", { env: AIR }), mk("busy", "alice", {}, tool("bash", true)),
    mk("wrongly-cloud", "alice", { env: CLOUD_ENV }, tool("read_file", true)), mk("truly-cloud", "alice", { env: CLOUD_ENV }, tool("mind_query", true)),
    mk("bobs", "bob", {}, tool("grep", true)),
  ]);
  const woke: string[] = [];
  const svc = new SyncService({ store, bots: () => undefined, isBusy: (id) => id === "busy", tierOf: () => "staff", afterWrite: async (_o, id) => { woke.push(id); }, homeCtx: (o) => (o === "alice" ? { groups } : { groups: [] }) });
  const r1 = await svc.backfillHomes(undefined, { recheckCloud: false });
  const alice = r1.find((x) => x.owner === "alice")!;
  assert.equal(alice.assigned, 2, "plain and ran-local");
  assert.equal(store.all.get("plain")!.env!.kind, "cloud");
  assert.equal(store.all.get("ran-local")!.env!.id, MAC.id);
  assert.equal(store.all.get("tagged")!.env!.id, AIR.id, "left as it was");
  assert.equal(store.all.get("busy")!.env, undefined, "its live copy would write the old record back");
  assert.equal(store.all.get("wrongly-cloud")!.env!.kind, "cloud", "not re-read on an ordinary pass");
  assert.deepEqual(alice.byHome, { "MIND Cloud": 1, "Anthonys MacBook Pro": 1 });
  assert.equal(store.all.get("bobs")!.env!.kind, "cloud", "bob has no computer registered: nowhere to put a tool run");
  assert.deepEqual(woke.sort(), ["bobs", "plain", "ran-local"].sort());
  const r2 = await svc.backfillHomes(["alice"], { recheckCloud: true });
  assert.equal(r2.length, 1);
  assert.equal(store.all.get("wrongly-cloud")!.env!.id, MAC.id, "a cloud stamp is moved by a tool that cannot run on daebot.live");
  assert.equal(store.all.get("truly-cloud")!.env!.kind, "cloud");
  const before = store.saved.length;
  await svc.backfillHomes(undefined, { recheckCloud: true });
  assert.equal(store.saved.length, before, "a pass over settled sessions rewrites nothing (the busy one is still skipped)");
});

test("end to end on the hosted gateway: pushes get a home from their device or their history; the start-up pass fixes what was saved before; one place per computer; rename", async () => {
  const hosted = await hostedRig({ envSweepMs: 2500 });
  try {
    const key = hosted.keys.alice;
    const reg = (id: string, name: string, host?: string, kind?: string) => hosted.host(key, "POST", "/api/sync/device/poll", { deviceId: id, name, host, kind, bots: [], wait: 0 });
    for (const x of [reg("d_" + "a".repeat(16), "Anthonys-MBP-7.mynetworksettings.com"), reg("d_" + "b".repeat(16), "Anthonys MBP 7.mynetworksettings.com"), reg("d_" + "c".repeat(16), "Anthonys MacBook Pro", "Anthonys-MBP-7.mynetworksettings.com"), reg("d_" + "e".repeat(16), "Atlas-PC.local"), reg("d_" + "f".repeat(16), "droplet-45", undefined, "server")]) assert.equal((await x).status, 200);
    const as = await hosted.as(key);
    const wire = (r: StoredSession) => (({ owner, tier, run, ...w }) => w)(r as any);
    const push = (rs: StoredSession[], device?: object) => hosted.host(key, "POST", "/api/sync/sessions", { records: rs.map(wire), ...(device ? { device } : {}) });
    const atlasPc = { id: "d_" + "e".repeat(16), name: "Atlas PC", kind: "machine" };
    // a record new to the server, pushed by a computer that did not tag it: that computer is its home
    let res = JSON.parse((await push([withHistory("from-pc", "web", [])], atlasPc)).body).results;
    assert.equal(res[0].status, "ok");
    assert.equal(hosted.store.load("from-pc")!.env!.name, "Atlas PC");
    // pushed with no device: the tool that ran says computer; nothing says cloud
    await push([withHistory("ran-bash", "web", tool("bash", true)), withHistory("just-chat", "web", tool("mind_query", true)), withHistory("typed-on-desktop", "desktop", [])]);
    assert.equal(hosted.store.load("ran-bash")!.env!.kind, "machine");
    assert.equal(hosted.store.load("just-chat")!.env!.kind, "cloud");
    assert.equal(hosted.store.load("typed-on-desktop")!.env!.kind, "machine");
    // the list: names are tidy, the Mac's registrations are one place
    const l = JSON.parse((await as("GET", "/sessions")).body);
    const macs = l.envs.filter((e: any) => /mbp|macbook pro/i.test(e.name));
    assert.equal(macs.length, 1, JSON.stringify(l.envs));
    assert.equal(macs[0].name, "Anthonys MacBook Pro");
    assert.ok(l.envs.some((e: any) => e.name === "Atlas PC"), "a .local hostname is tidied");
    assert.equal(l.envs.filter((e: any) => e.kind === "server").length, 1);
    assert.equal(l.sessions.find((s: any) => s.id === "ran-bash").env.id, macs[0].id, "a session stored under an old registration shows under the one place");
    // rename: kept on the account, shown on every list, an empty name puts the automatic one back
    const rn = await as("POST", "/envs/rename", { id: macs[0].id, name: "  Work   laptop " });
    assert.equal(rn.status, 200, rn.body);
    const l2 = JSON.parse((await as("GET", "/sessions")).body);
    assert.ok(l2.envs.some((e: any) => e.name === "Work laptop"));
    assert.equal(l2.sessions.find((s: any) => s.id === "ran-bash").env.name, "Work laptop");
    assert.equal((await as("POST", "/envs/rename", { id: "d_" + "9".repeat(16), name: "x" })).status, 404);
    assert.equal((await as("POST", "/envs/rename", { name: "x" })).status, 400);
    assert.equal((await hosted.host(key, "POST", "/api/sync/envs/rename", { id: macs[0].id, name: "" })).status, 200, "a desktop can rename through its key");
    assert.ok(JSON.parse((await as("GET", "/sessions")).body).envs.some((e: any) => e.name === "Anthonys MacBook Pro"));
    assert.ok(JSON.parse((await hosted.host(key, "GET", "/api/sync/sessions?since=0&limit=5")).body).envGroups.length >= 3, "desktops get the merged places with every list");
    // the start-up pass: sessions saved before environments existed (no home) are given one without anyone pushing
    const owner = hosted.store.load("ran-bash")!.owner;
    for (const id of ["old-chat", "old-bash"]) await hosted.store.save({ ...withHistory(id, "web", id === "old-bash" ? tool("grep", true) : []), owner });
    assert.equal(hosted.store.load("old-chat")!.env, undefined);
    await until(() => hosted.store.load("old-chat")?.env && hosted.store.load("old-bash")?.env, 8000);
    assert.equal(hosted.store.load("old-chat")!.env!.kind, "cloud");
    assert.equal(hosted.store.load("old-bash")!.env!.kind, "machine");
    const row = JSON.parse((await hosted.host(key, "GET", "/api/sync/sessions?since=0&limit=500")).body).rows.find((r: any) => r.id === "old-bash");
    assert.equal(row.env.kind, "machine", "the list row carries the home so a device adopts it without fetching the record");
  } finally { await hosted.close(); }
});
