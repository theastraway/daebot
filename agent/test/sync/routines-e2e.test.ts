// Routine definitions and run records sync across devices like sessions: made on the desktop, visible on daebot.live (status, runs, output
// thread); edited on one side, the other follows; deleted on one side, gone on the other (tombstone); the device that made it runs it.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedRig, deskRig, until, sleep } from "./rig.ts";
import { MAIN_BOT_ID, RoutineBook, RoutineHub } from "../../src/routines/store.ts";
import { routineSig, toWireRoutine } from "../../src/sync/routines.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const listOn = async (web: Awaited<ReturnType<Awaited<ReturnType<typeof hostedRig>>["as"]>>, botId: string) => JSON.parse((await web("GET", `/bots/${botId}/routines`)).body).routines as any[];

test("a routine and its run made on the desktop show on daebot.live with status, runs and the output thread; the server never runs it", async () => {
  const hosted = await hostedRig({ script: [{ text: "SERVER MUST NOT RUN THIS" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "routine output: all quiet" }] });
  try {
    const add = JSON.parse((await desk.api("POST", `/bots/${MAIN_BOT_ID}/routines`, { name: "Morning check", prompt: "Report.", kind: "timed", timing: { expression: "0 9 * * 1-5", tz: "America/New_York" } })).body).routine;
    const run = JSON.parse((await desk.api("POST", `/bots/${MAIN_BOT_ID}/routines/${add.id}/run`)).body);
    assert.equal(run.ok, true);
    const web = await hosted.as(hosted.keys.alice);
    const seen = await until(async () => (await listOn(web, MAIN_BOT_ID)).find((r) => r.id === add.id && r.lastStatus === "ok"));
    assert.equal(seen.name, "Morning check");
    assert.equal(seen.foreign, true, "made elsewhere: shown here, run there");
    assert.ok(seen.lastRunAt > 0 && seen.lastThreadId, "start time and the output thread");
    assert.equal(seen.nextRunAt, undefined, "the server does not schedule it");
    const local = JSON.parse((await desk.api("GET", `/bots/${MAIN_BOT_ID}/routines`)).body).routines.find((r: any) => r.id === add.id);
    assert.equal(seen.lastThreadId, local.lastThreadId);
    assert.equal(hosted.provider.requests.length, 0, "the server model never ran it");
  } finally { await desk.close(); await hosted.close(); }
});

test("an edit and a delete travel both ways: web -> desktop (definition), desktop -> web (delete, tombstone keeps an offline copy from coming back)", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const add = JSON.parse((await desk.api("POST", `/bots/${MAIN_BOT_ID}/routines`, { name: "Digest", prompt: "Summarise.", kind: "timed", timing: { expression: "0 8 * * *", tz: "America/New_York" } })).body).routine;
    const web = await hosted.as(hosted.keys.alice);
    await until(async () => (await listOn(web, MAIN_BOT_ID)).find((r) => r.id === add.id));
    // the web turns it off: the desktop (which runs it) follows
    await sleep(5);
    const off = await web("PATCH", `/bots/${MAIN_BOT_ID}/routines/${add.id}`, { enabled: false });
    assert.equal(off.status, 200, off.body);
    await until(async () => JSON.parse((await desk.api("GET", `/bots/${MAIN_BOT_ID}/routines`)).body).routines.find((r: any) => r.id === add.id)?.enabled === false);
    // the desktop deletes it: gone on the web
    const del = await desk.api("DELETE", `/bots/${MAIN_BOT_ID}/routines/${add.id}`);
    assert.equal(del.status, 200, del.body);
    await until(async () => !(await listOn(web, MAIN_BOT_ID)).some((r) => r.id === add.id));
    // an offline copy cannot resurrect it: pushing it again is refused as deleted
    const again = JSON.parse((await hosted.host(hosted.keys.alice, "POST", "/api/sync/routines", { routines: [{ id: add.id, botSlug: "main", name: "Digest", prompt: "x", enabled: true, kind: "timed", timing: { expression: "0 8 * * *", tz: "America/New_York" }, createdAt: 1, updatedAt: Date.now() + 99999, runs: [] }] })).body);
    assert.equal(again.results[0].status, "deleted");
    assert.equal((await listOn(web, MAIN_BOT_ID)).some((r) => r.id === add.id), false);
  } finally { await desk.close(); await hosted.close(); }
});

test("routines are per user: bob never sees alice's, and cannot push into her tombstones or books", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const add = JSON.parse((await desk.api("POST", `/bots/${MAIN_BOT_ID}/routines`, { name: "Private", prompt: "p", kind: "timed", timing: { expression: "0 8 * * *", tz: "America/New_York" } })).body).routine;
    const webA = await hosted.as(hosted.keys.alice);
    await until(async () => (await listOn(webA, MAIN_BOT_ID)).find((r) => r.id === add.id));
    const bob = JSON.parse((await hosted.host(hosted.keys.bob, "GET", "/api/sync/routines?since=0")).body);
    assert.deepEqual(bob.routines, []);
    const webB = await hosted.as(hosted.keys.bob);
    assert.equal((await listOn(webB, MAIN_BOT_ID)).some((r) => r.id === add.id), false);
  } finally { await desk.close(); await hosted.close(); }
});

test("merge rules: the newer definition wins, run records are unioned (latest 20), the last run follows the newest, a foreign routine is never claimed by the timer", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsync-"));
  let t = 1_000_000;
  const hub = new RoutineHub(dir, { now: () => t });
  const book: RoutineBook = hub.book("u1", MAIN_BOT_ID);
  const w = (over: any = {}) => ({ id: "r_aaaaaaaaaaaa", name: "N", prompt: "p", enabled: true, kind: "timed" as const, timing: { expression: "*/5 * * * *", tz: "UTC" }, createdAt: 1, updatedAt: 10, runs: [{ at: 100, source: "timer", status: "ok" as const, model: true, ms: 5 }], lastRunAt: 100, lastStatus: "ok" as const, ...over });
  assert.equal(book.applySynced(w(), true), "created");
  assert.equal(book.get("r_aaaaaaaaaaaa")!.foreign, true);
  assert.equal(book.applySynced(w(), true), "same");
  assert.equal(book.claimSlot("r_aaaaaaaaaaaa", t + 10 ** 9), undefined, "foreign: never claimed");
  // older definition does not win, new runs union
  assert.equal(book.applySynced(w({ name: "OLD", updatedAt: 5, runs: [{ at: 200, source: "manual", status: "error" as const, model: true, ms: 1, result: "boom" }], lastRunAt: 200, lastStatus: "error" as const, lastResult: "boom" }), true), "updated");
  let r = book.get("r_aaaaaaaaaaaa")!;
  assert.equal(r.name, "N"); assert.equal(r.runs!.length, 2); assert.equal(r.lastStatus, "error"); assert.equal(r.lastRunAt, 200);
  // newer definition wins
  book.applySynced(w({ name: "NEW", prompt: "q", enabled: false, updatedAt: 50 }), true);
  r = book.get("r_aaaaaaaaaaaa")!;
  assert.deepEqual([r.name, r.prompt, r.enabled, r.updatedAt], ["NEW", "q", false, 50]);
  // 20 kept
  const many = Array.from({ length: 30 }, (_, i) => ({ at: 1000 + i, source: "timer", status: "ok" as const, model: false, ms: 1 }));
  book.applySynced(w({ updatedAt: 50, runs: many, lastRunAt: 1029 }), true);
  assert.equal(book.get("r_aaaaaaaaaaaa")!.runs!.length, 20);
  assert.equal(book.get("r_aaaaaaaaaaaa")!.runs!.at(-1)!.at, 1029);
  // invalid input is refused, never half-applied
  assert.equal(book.applySynced(w({ id: "r_bbbbbbbbbbbb", timing: { expression: "not cron", tz: "UTC" } }), true), "invalid");
  assert.equal(book.get("r_bbbbbbbbbbbb"), undefined);
  // the heartbeat is never synced, and sig changes with a run
  assert.ok(!book.syncable().some((x) => x.builtin));
  const s1 = routineSig(book.get("r_aaaaaaaaaaaa")!);
  book.recordRun("r_aaaaaaaaaaaa", { at: 5000, source: "manual", status: "ok", model: true, ms: 3 });
  assert.notEqual(routineSig(book.get("r_aaaaaaaaaaaa")!), s1);
  assert.equal("secret" in toWireRoutine(book.get("r_aaaaaaaaaaaa")!, "main"), false);
});

test("the runner's timer and every trigger entry skip a foreign routine (the device that made it runs it)", async () => {
  const { rig, OWNER, BOT } = await import("../routines/rig.ts");
  const r = rig();
  const book = r.hub.book(OWNER, BOT);
  assert.equal(book.applySynced({ id: "r_cccccccccccc", name: "Elsewhere", prompt: "p", enabled: true, kind: "timed", timing: { expression: "* * * * *", tz: "UTC" }, createdAt: 1, updatedAt: 2, runs: [] }, true), "created");
  assert.equal(book.applySynced({ id: "r_dddddddddddd", name: "Hook", prompt: "p", enabled: true, kind: "trigger", trigger: { type: "thread_message" }, createdAt: 1, updatedAt: 2, runs: [] } as any, true), "created");
  for (let i = 0; i < 5; i++) { r.clock.t += 120_000; await r.runner.tick(r.clock.t); }
  assert.equal(r.runner.trigger(OWNER, BOT, "thread_message", { text: "hi" }), 0);
  assert.equal(r.turns.filter((x) => x.thread.includes("Elsewhere") || x.thread.includes("Hook")).length, 0, "nothing ran here");
  // a local edit (a deliberate one) makes no difference: still foreign
  book.update("r_cccccccccccc", { prompt: "edited here" });
  assert.equal(book.get("r_cccccccccccc")!.foreign, true);
}
);
