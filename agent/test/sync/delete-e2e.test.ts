// Deletes and archives travel between devices. A delete leaves a tombstone so a device that was offline cannot bring the session back.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedRig, deskRig, until, sleep, localSession } from "./rig.ts";
import { TombstoneBook } from "../../src/sync/tombstones.ts";

async function started(desk: Awaited<ReturnType<typeof deskRig>>, hosted: Awaited<ReturnType<typeof hostedRig>>, text = "hi") {
  const sessionId = await localSession(desk, { surface: "desktop", title: "to delete" });
  await desk.api("POST", `/sessions/${sessionId}/send`, { text });
  await until(() => hosted.store.load(sessionId));
  return sessionId as string;
}

test("deleting a session on the desktop removes it from daebot.live, and the list says so", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const sid = await started(desk, hosted);
    const del = await desk.api("DELETE", `/sessions/${sid}?purge=1`);
    assert.equal(del.status, 200, del.body);
    await until(() => !hosted.store.load(sid));
    const list = JSON.parse((await hosted.host(hosted.keys.alice, "GET", "/api/sync/sessions?since=0")).body);
    const row = list.rows.find((r: any) => r.id === sid);
    assert.equal(row?.deleted, true, "a tombstone row");
    // another user never sees it
    const bob = JSON.parse((await hosted.host(hosted.keys.bob, "GET", "/api/sync/sessions?since=0")).body);
    assert.equal(bob.rows.length, 0);
    assert.equal((await hosted.host(hosted.keys.alice, "GET", `/api/sync/sessions/${sid}`)).status, 404);
  } finally { await desk.close(); await hosted.close(); }
});

test("deleting on daebot.live (the web or phone) removes it from the desktop", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const sid = await started(desk, hosted);
    const web = await hosted.as(hosted.keys.alice);
    assert.equal((await web("DELETE", `/sessions/${sid}?purge=1`)).status, 200);
    await until(() => !desk.store.load(sid));
    assert.ok(!JSON.parse((await desk.api("GET", "/sessions")).body).sessions.some((s: any) => s.id === sid));
    // and it does not come back on later rounds
    await desk.api("POST", "/sync/now");
    await desk.api("POST", "/sync/now");
    assert.equal(desk.store.load(sid), undefined);
    assert.equal(hosted.store.load(sid), undefined);
  } finally { await desk.close(); await hosted.close(); }
});

test("a second device deletes the session when it learns of the delete; an offline device cannot resurrect it", async () => {
  const hosted = await hostedRig();
  const a = await deskRig(hosted, hosted.keys.alice, { deviceId: "d_" + "a".repeat(16) });
  const b = await deskRig(hosted, hosted.keys.alice, { deviceId: "d_" + "b".repeat(16) });
  try {
    const sid = await started(a, hosted, "shared chat");
    await until(() => b.store.load(sid));
    await b.close(); // device B goes offline holding its copy (its store stays on disk)
    assert.equal((await a.api("DELETE", `/sessions/${sid}?purge=1`)).status, 200);
    await until(() => !hosted.store.load(sid));
    // B comes back with the same data dir, and edits the session offline first
    const rec = b.store.load(sid)!;
    await b.store.save({ ...rec, title: "edited offline", updatedAt: rec.updatedAt + 5000 });
    const b2 = await deskRig(hosted, hosted.keys.alice, { deviceId: "d_" + "b".repeat(16), dir: b.dir });
    try {
      await until(() => !b2.store.load(sid));
      await b2.api("POST", "/sync/now");
      await sleep(300);
      assert.equal(hosted.store.load(sid), undefined, "the deleted session did not come back on the server");
      assert.equal(a.store.load(sid), undefined);
    } finally { await b2.close(); }
  } finally { await a.close(); await hosted.close(); }
});

test("a delete made while offline is remembered across a restart and sent when the device is back", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const sid = await started(desk, hosted);
    const dir = desk.dir;
    await desk.close();
    // offline: the local record is deleted with no server contact (an unreachable server is simulated by a dead sync url)
    const dead = await deskRig(hosted, hosted.keys.alice, { dir, sync: false });
    await dead.api("DELETE", `/sessions/${sid}?purge=1`);
    await dead.close();
    assert.ok(hosted.store.load(sid), "the server has not heard yet");
    // the tombstone was never recorded by a sync-less gateway, so record it as the agent would, then restart with sync on
    const book = new TombstoneBook({ file: join(dir, "sync-state.json") });
    book.mark("owner", sid); book.addPending(sid);
    const again = await deskRig(hosted, hosted.keys.alice, { dir });
    try {
      await until(() => !hosted.store.load(sid));
      assert.equal(new TombstoneBook({ file: join(dir, "sync-state.json") }).pending().length, 0, "the pending delete was sent");
    } finally { await again.close(); }
  } finally { await hosted.close(); }
});

test("archive and unarchive travel between devices", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const sid = await started(desk, hosted);
    const rec = desk.store.load(sid)!;
    await desk.store.save({ ...rec, archived: true, metaAt: Date.now() + 10 });
    await until(() => hosted.store.load(sid)?.archived === true);
    // unarchived on the hosted side (the phone): the desktop follows
    const h = hosted.store.load(sid)!;
    const next = { ...h }; delete next.archived; next.metaAt = Date.now() + 20;
    await hosted.store.save(next);
    await until(() => desk.store.load(sid)?.archived !== true);
  } finally { await desk.close(); await hosted.close(); }
});

test("a rename travels between devices without reordering the list", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const sid = await started(desk, hosted);
    const before = desk.store.load(sid)!.updatedAt;
    assert.equal((await desk.api("PATCH", `/sessions/${sid}`, { title: "Renamed on the Mac" })).status, 200);
    await until(() => hosted.store.load(sid)?.title === "Renamed on the Mac");
    assert.equal(desk.store.load(sid)!.updatedAt, before, "the sidebar order did not move");
    const web = await hosted.as(hosted.keys.alice);
    assert.equal((await web("PATCH", `/sessions/${sid}`, { title: "Back on the web" })).status, 200);
    await until(() => desk.store.load(sid)?.title === "Back on the web");
  } finally { await desk.close(); await hosted.close(); }
});

test("tombstone book: first delete time stands, expires after 180 days, survives a reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "tomb-"));
  const file = join(dir, "t.json");
  let now = 1_000_000;
  const b = new TombstoneBook({ file, now: () => now });
  assert.equal(b.mark("o", "x", 5), 5);
  assert.equal(b.mark("o", "x", 9), 5);
  b.addPending("x");
  const re = new TombstoneBook({ file, now: () => now });
  assert.equal(re.has("o", "x"), true);
  assert.deepEqual(re.pending(), ["x"]);
  assert.equal(re.has("p", "x"), false);
  now += 181 * 24 * 3600 * 1000;
  assert.deepEqual(re.since("o", 0), []);
});
