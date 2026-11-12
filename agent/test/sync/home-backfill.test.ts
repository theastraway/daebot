// Where a saved session lives: the evidence the store holds, the automatic pass that assigns it, and the clean names, end to end.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import { CLOUD_ENV, groupDevices } from "../../src/env.ts";
import type { DeviceLike } from "../../src/env.ts";
import { botMigration, inferHome, migrationDecision, readEvidence } from "../../src/sync/home.ts";
import { SyncService } from "../../src/sync/service.ts";
import type { SessionStore, StoredSession } from "../../src/persist.ts";
import type { BotRecord, BotsApi } from "../../src/bots/types.ts";
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


const memStore = (recs: StoredSession[]): SessionStore & { saved: string[]; all: Map<string, StoredSession> } => {
  const all = new Map(recs.map((r) => [r.id, r]));
  const saved: string[] = [];
  const meta = (r: StoredSession) => ({ id: r.id, surface: r.surface, title: r.title, updatedAt: r.updatedAt, owner: r.owner, ...(r.env ? { env: r.env } : {}) });
  return { saved, all, async save(r) { all.set(r.id, r); saved.push(r.id); }, load: (id) => all.get(id), list: () => [...all.values()].map(meta) };
};

/** A bots API that only knows what the migration reads and writes. */
function fakeBots(list: Partial<BotRecord>[]): BotsApi & { offs: string[] } {
  const bots = list.map((b, i) => ({ id: `b_${String(i).padStart(12, "0")}`, name: b.slug, purpose: "", color: "#6366f1", createdAt: 1, updatedAt: 1, ...b })) as BotRecord[];
  const offs: string[] = [];
  return {
    offs,
    list: async () => bots, snapshot: () => bots, get: (id: string) => bots.find((b) => b.id === id), bySlug: (s: string) => bots.find((b) => b.slug === s),
    setRemote(id: string, remote: boolean, o: { by: "user" | "auto"; note?: string; at?: number }) { const b = bots.find((x) => x.id === id)!; b.remote = remote; b.remoteAt = o.at; b.remoteLog = [...(b.remoteLog ?? []), { at: o.at ?? 0, remote, by: o.by, note: o.note ?? "" }]; if (!remote) offs.push(b.slug); return b; },
  } as unknown as BotsApi & { offs: string[] };
}

test("inferHome: a home is kept; none is MIND Cloud, whatever the evidence says (a computer is only ever the person's choice)", () => {
  assert.equal(inferHome(rec("x", { env: AIR })).why, "has-home");
  assert.deepEqual(inferHome(rec("y", {})), { env: CLOUD_ENV, why: "default" });
  assert.deepEqual(inferHome(withHistory("z", "desktop", tool("bash", true))), { env: CLOUD_ENV, why: "default" }, "a tool that ran on a computer, and surface desktop, no longer move a session there");
  assert.deepEqual(readEvidence(withHistory("a", "web", tool("bash", true))), { localTool: true, hostedRefusal: false }, "the evidence is still readable: it only protects a legacy Remote bot's thread in the migration");
});

test("backfillHomes: a session with no home is MIND Cloud; one with a home is not touched; a busy one waits; nothing is ever moved to a computer", async () => {
  const mk = (id: string, owner: string, extra: Partial<StoredSession> = {}, ev: HistoryEvent[] = []) => ({ ...withHistory(id, "desktop", ev), owner, ...extra });
  const store = memStore([mk("plain", "alice"), mk("ran-local", "alice", {}, tool("bash", true)), mk("tagged", "alice", { env: AIR }), mk("busy", "alice"), mk("cloud-with-tool", "alice", { env: CLOUD_ENV }, tool("read_file", true)), mk("bobs", "bob", {}, tool("grep", true))]);
  const woke: string[] = [];
  const svc = new SyncService({ store, bots: () => undefined, isBusy: (id) => id === "busy", tierOf: () => "staff", afterWrite: async (_o, id) => { woke.push(id); } });
  const r1 = await svc.backfillHomes(undefined, { recheckCloud: true });
  const alice = r1.find((x) => x.owner === "alice")!;
  assert.equal(alice.assigned, 2, "plain and ran-local");
  for (const id of ["plain", "ran-local", "bobs"]) { const r = store.all.get(id)!; assert.equal(r.env!.kind, "cloud", id); assert.equal(r.envBy, "default"); assert.ok(r.envAt); }
  assert.equal(store.all.get("tagged")!.env!.id, AIR.id, "left as it was");
  assert.equal(store.all.get("busy")!.env, undefined, "its live copy would write the old record back");
  assert.equal(store.all.get("cloud-with-tool")!.env!.kind, "cloud", "a cloud stamp is never re-read and moved to a computer any more");
  assert.deepEqual(alice.byHome, { "MIND Cloud": 2 });
  assert.deepEqual(woke.sort(), ["bobs", "plain", "ran-local"].sort());
  const before = store.saved.length;
  await svc.backfillHomes(undefined, { recheckCloud: true });
  assert.equal(store.saved.length, before, "a pass over settled sessions rewrites nothing");
});

test("migrationDecision: what stays and what goes to MIND Cloud", () => {
  const onMac = (extra: Partial<StoredSession> = {}, ev: HistoryEvent[] = []) => withHistory("s", "desktop", ev, { env: MAC, ...extra });
  assert.deepEqual(migrationDecision(onMac(), undefined), { move: true, why: "auto-stamped" });
  assert.deepEqual(migrationDecision(onMac({ envBy: "user", envAt: 5 }), undefined), { move: false, why: "user-chose-local" });
  assert.deepEqual(migrationDecision(onMac({ env: { id: "d_" + "9".repeat(16), kind: "server", name: "droplet-45" } }), undefined), { move: false, why: "server" });
  assert.deepEqual(migrationDecision(rec("c", { env: CLOUD_ENV }), undefined), { move: false, why: "cloud" });
  assert.deepEqual(migrationDecision(rec("n", {}), undefined), { move: false, why: "no-home" });
  const bot = (remote: boolean, by?: "user" | "auto") => ({ remote, remoteLog: by ? [{ at: 1, remote, by, note: "" }] : [] });
  assert.equal(migrationDecision(onMac({ bot: "b_1" }), bot(true, "user")).why, "bot-remote-by-user", "a thread of a bot the person put on a computer follows it");
  assert.equal(migrationDecision(onMac({ bot: "b_1" }, tool("bash", true)), bot(true)).why, "bot-remote-needs-local-tools", "a Remote bot with no record whose thread ran a computer-only tool needs the computer");
  assert.deepEqual(migrationDecision(onMac({ bot: "b_1" }, tool("bash", true)), bot(false, "auto")), { move: true, why: "auto-stamped" }, "Remote that turned itself on is not a choice (the bot pass has already turned it off)");
  assert.deepEqual(migrationDecision(onMac({ bot: "b_1" }), bot(false)), { move: true, why: "auto-stamped" });
  assert.equal(botMigration(bot(true, "auto"), []).off, true);
  assert.equal(botMigration(bot(true, "user"), []).off, false);
  assert.equal(botMigration(bot(true), []).off, true, "Remote on with no record and nothing that needed the computer: off");
  assert.equal(botMigration(bot(true), [withHistory("t", "web", tool("bash", true))]).why, "no-record-needs-local-tools");
  assert.equal(botMigration(bot(false), []).why, "not-remote");
});

test("migrateToCloud: stamped computers go to MIND Cloud with their history intact; the person's choices stay; it runs once per owner and says what it moved and why", async () => {
  const mk = (id: string, extra: Partial<StoredSession> = {}, ev: HistoryEvent[] = []) => ({ ...withHistory(id, "desktop", ev, { env: MAC, ...extra }), owner: "alice" });
  const store = memStore([
    mk("stamped"), mk("chose", { envBy: "user", envAt: 7 }), mk("on-server", { env: { id: "d_" + "9".repeat(16), kind: "server", name: "droplet-45" } }),
    mk("auto-bot-thread", { bot: "b_000000000000" }), mk("user-bot-thread", { bot: "b_000000000001" }), mk("legacy-bot-thread", { bot: "b_000000000002" }, tool("bash", true)), mk("legacy-quiet-thread", { bot: "b_000000000003" }),
    mk("busy"), { ...mk("already-cloud"), env: CLOUD_ENV }, { ...mk("bobs"), owner: "bob" },
  ]);
  const before = new Map([...store.all].map(([id, r]) => [id, r.history.length]));
  const bots = fakeBots([
    { slug: "auto-bot", remote: true, remoteLog: [{ at: 1, remote: true, by: "auto", note: "Turned on automatically" }] },
    { slug: "user-bot", remote: true, remoteLog: [{ at: 1, remote: true, by: "user", note: "Turned on in settings." }] },
    { slug: "legacy-bot", remote: true }, { slug: "legacy-quiet-bot", remote: true }, { slug: "cloud-bot" },
  ]);
  const dir = mkdtempSync(join(tmpdir(), "daebot-mig-"));
  const svc = new SyncService({ store, bots: (o) => (o === "alice" ? bots : undefined), isBusy: (id) => id === "busy", tierOf: () => "staff", migrationDir: dir });
  // a dry run writes nothing and leaves no marker
  const dry = await svc.migrateToCloud(["alice"], { dryRun: true });
  assert.equal(dry[0].moved.length, 3); assert.equal(store.saved.length, 0); assert.deepEqual(bots.offs, []);
  const [rep] = await svc.migrateToCloud(["alice"]);
  const movedIds = rep.moved.map((m) => m.id).sort();
  assert.deepEqual(movedIds, ["auto-bot-thread", "legacy-quiet-thread", "stamped"], JSON.stringify(rep));
  assert.ok(rep.moved.every((m) => m.from === MAC.name && m.why === "auto-stamped"));
  assert.deepEqual(rep.skippedBusy, ["busy"]);
  for (const id of movedIds) { const r = store.all.get(id)!; assert.equal(r.env!.kind, "cloud", id); assert.equal(r.envBy, "auto"); assert.ok(r.envAt! > 0); assert.equal(r.history.length, before.get(id), `${id} keeps its history`); }
  for (const id of ["chose", "on-server", "user-bot-thread", "legacy-bot-thread"]) assert.notEqual(store.all.get(id)!.env!.kind, "cloud", `${id} stays where the person (or its server/bot) put it`);
  assert.equal(store.all.get("bobs")!.env!.id, MAC.id, "an owner not asked about is not touched");
  assert.deepEqual(rep.botsOff.map((b) => b.slug).sort(), ["auto-bot", "legacy-quiet-bot"], JSON.stringify(rep.botsOff));
  assert.deepEqual(rep.botsKept.map((b) => b.slug).sort(), ["legacy-bot", "user-bot"]);
  assert.equal(bots.bySlug("auto-bot")!.remote, false); assert.equal(bots.bySlug("auto-bot")!.remoteLog!.at(-1)!.by, "auto");
  assert.match(bots.bySlug("auto-bot")!.remoteLog!.at(-1)!.note, /MIND Cloud/);
  // once: the marker stops a second pass, so a later choice of a computer is never undone; force overrides
  const again = await svc.migrateToCloud(["alice"]);
  assert.equal(again.length, 0);
  assert.ok(readdirSync(dir).some((f) => f.startsWith("env-cloud-v1-alice")));
});

test("end to end on the hosted gateway: pushes are MIND Cloud unless the person chose a computer; the start-up pass fixes what was saved before; one place per computer; rename", async () => {
  const hosted = await hostedRig({ envSweepMs: 2500 });
  try {
    const key = hosted.keys.alice;
    const reg = (id: string, name: string, host?: string, kind?: string) => hosted.host(key, "POST", "/api/sync/device/poll", { deviceId: id, name, host, kind, bots: [], wait: 0 });
    for (const x of [reg("d_" + "a".repeat(16), "Anthonys-MBP-7.mynetworksettings.com"), reg("d_" + "b".repeat(16), "Anthonys MBP 7.mynetworksettings.com"), reg("d_" + "c".repeat(16), "Anthonys MacBook Pro", "Anthonys-MBP-7.mynetworksettings.com"), reg("d_" + "e".repeat(16), "Atlas-PC.local"), reg("d_" + "f".repeat(16), "droplet-45", undefined, "server")]) assert.equal((await x).status, 200);
    const as = await hosted.as(key);
    const wire = (r: StoredSession) => (({ owner, tier, run, ...w }) => w)(r as any);
    const push = (rs: StoredSession[], device?: object) => hosted.host(key, "POST", "/api/sync/sessions", { records: rs.map(wire), ...(device ? { device } : {}) });
    const atlasPc = { id: "d_" + "e".repeat(16), name: "Atlas PC", kind: "machine" };
    // a record new to the server, pushed by a computer that did not tag it: MIND Cloud, the standard (a computer is only ever the person's choice)
    let res = JSON.parse((await push([withHistory("from-pc", "web", [])], atlasPc)).body).results;
    assert.equal(res[0].status, "ok");
    assert.equal(hosted.store.load("from-pc")!.env!.kind, "cloud", "the pushing computer is not a reason to put it there");
    // a tool that ran, or surface desktop, are no longer reasons either
    await push([withHistory("ran-bash", "web", tool("bash", true)), withHistory("just-chat", "web", tool("mind_query", true)), withHistory("typed-on-desktop", "desktop", [])]);
    assert.equal(hosted.store.load("ran-bash")!.env!.kind, "cloud");
    assert.equal(hosted.store.load("just-chat")!.env!.kind, "cloud");
    assert.equal(hosted.store.load("typed-on-desktop")!.env!.kind, "cloud");
    // a NEW record an older desktop build stamped with its own computer, with no decision recorded, is not auto-stamped onto that computer either
    const legacy = { ...wire(withHistory("legacy-stamp", "desktop", [])), env: { id: "d_" + "1".repeat(16), kind: "machine", name: "Anthonys MacBook Pro" } };
    await hosted.host(key, "POST", "/api/sync/sessions", { records: [legacy] });
    assert.equal(hosted.store.load("legacy-stamp")!.env!.kind, "cloud");
    // ...but a computer the person chose (a recorded decision) is kept
    const chosen = { ...wire(withHistory("chosen-local", "desktop", [])), env: { id: "d_" + "1".repeat(16), kind: "machine", name: "Anthonys MacBook Pro" }, envAt: Date.now(), envBy: "user" };
    await hosted.host(key, "POST", "/api/sync/sessions", { records: [chosen] });
    assert.equal(hosted.store.load("chosen-local")!.env!.kind, "machine");
    assert.equal(hosted.store.load("chosen-local")!.envBy, "user");
    // the list: names are tidy, the Mac's registrations are one place
    const l = JSON.parse((await as("GET", "/sessions")).body);
    const macs = l.envs.filter((e: any) => /mbp|macbook pro/i.test(e.name));
    assert.equal(macs.length, 1, JSON.stringify(l.envs));
    assert.equal(macs[0].name, "Anthonys MacBook Pro");
    assert.ok(l.envs.some((e: any) => e.name === "Atlas PC"), "a .local hostname is tidied");
    assert.equal(l.envs.filter((e: any) => e.kind === "server").length, 1);
    assert.equal(l.sessions.find((s: any) => s.id === "chosen-local").env.id, macs[0].id, "a session stored under an old registration shows under the one place");
    // rename: kept on the account, shown on every list, an empty name puts the automatic one back
    const rn = await as("POST", "/envs/rename", { id: macs[0].id, name: "  Work   laptop " });
    assert.equal(rn.status, 200, rn.body);
    const l2 = JSON.parse((await as("GET", "/sessions")).body);
    assert.ok(l2.envs.some((e: any) => e.name === "Work laptop"));
    assert.equal(l2.sessions.find((s: any) => s.id === "chosen-local").env.name, "Work laptop");
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
    assert.equal(hosted.store.load("old-bash")!.env!.kind, "cloud", "a tool that ran on a computer does not put an old session there");
    const row = JSON.parse((await hosted.host(key, "GET", "/api/sync/sessions?since=0&limit=500")).body).rows.find((r: any) => r.id === "old-bash");
    assert.equal(row.env.kind, "cloud", "the list row carries the home so a device adopts it without fetching the record");
    assert.equal(typeof row.envAt, "number"); assert.equal(row.envBy, "default");
  } finally { await hosted.close(); }
});
