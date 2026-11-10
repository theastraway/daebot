// RECONCILE: a session that reached daebot.live only through device sync is made to appear in the tenant's MIND with every message, once.
process.env.DAEBOT_BOTS_ENABLED = "1";
process.env.DAEBOT_MIND_RECONCILE_MS = "60";
process.env.DAEBOT_MISTAKE_LOG_KEY = "log-key-for-tests-0123456789";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedRig, until, sleep } from "./rig.ts";
import { SessionLogger, messageIdFor, wantedMessages } from "../../src/mind/session-log.ts";
import { createFileStore } from "../../src/persist.ts";
import { userIdFor } from "../../src/auth/users.ts";
import { http } from "../gateway/helpers.ts";
import { H } from "./rig.ts";
import { rec } from "./helpers.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Row = { role: string; content: string; client_message_id?: string };
/** A MIND that keeps what it is given, like the real one: open is idempotent, append drops a repeated client_message_id, get pages by seq. */
function fakeMind(rows = new Map<string, { status: string; messages: Row[] }>()) {
  const calls: any[] = [];
  let down = false;
  const client: any = {
    call: async (_t: string, a: any) => {
      calls.push(a);
      if (down) throw new Error("MIND down");
      if (a.action === "open") {
        const had = rows.has(a.external_session_id);
        if (!had) rows.set(a.external_session_id, { status: "active", messages: [] });
        else rows.get(a.external_session_id)!.status = "active"; // the real open reactivates an ended session
        return JSON.stringify({ session_id: `m_${a.external_session_id}`, resumed: had });
      }
      const row = [...rows.entries()].find(([k]) => `m_${k}` === a.session_id)?.[1];
      if (!row) throw Object.assign(new Error("not found"), { status: 404 });
      if (a.action === "get") {
        const all = row.messages.map((m, i) => ({ ...m, seq: i + 1 })).filter((m) => a.before_seq === undefined || m.seq < a.before_seq);
        const win = all.slice(-Math.min(a.limit ?? 200, 3)); // a tiny page, to prove paging
        return JSON.stringify({ status: row.status, messages: win, has_more_before: all.length > win.length });
      }
      if (a.action === "append") {
        row.status = "active";
        for (const m of a.messages) if (!(m.client_message_id && row.messages.some((x) => x.client_message_id === m.client_message_id))) row.messages.push(m);
        return JSON.stringify({ ok: true });
      }
      if (a.action === "close") row.status = "ended";
      return JSON.stringify({ ok: true });
    },
  };
  return { rows, calls, client, down: (v: boolean) => { down = v; } };
}
const roles = (r?: { messages: Row[] }) => (r?.messages ?? []).map((m) => `${m.role}:${m.content}`);

async function setup(extra: Partial<ConstructorParameters<typeof SessionLogger>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  const store = createFileStore(dir);
  const mind = fakeMind();
  const l = new SessionLogger({ client: () => mind.client, store, owner: "owner", sourceKeyOf: (r) => (r.peer ? "daebot-bot-to-bot" : "daebot"), stateFile: join(dir, "s.json"), ...extra });
  l.start();
  return { dir, store, mind, l };
}

test("a synced session nobody logged is written to MIND whole, once; a second run adds nothing", async () => {
  const { store, mind, l } = await setup();
  await store.save(rec("s1", { title: "Synced chat", texts: [["u1", "q one"], ["a1", "answer one"], ["u2", "q two"], ["a2", "answer two"]] }), { origin: "sync" });
  await l.flush();
  assert.equal(mind.rows.size, 0, "the live logger leaves a synced session to the device that ran it");
  const sum = await l.reconcile();
  assert.equal(sum.messagesAppended, 4);
  assert.deepEqual(roles(mind.rows.get("s1")), ["user:q one", "assistant:answer one", "user:q two", "assistant:answer two"]);
  const again = await l.reconcile({ force: true });
  assert.equal(again.messagesAppended, 0);
  assert.equal(mind.rows.get("s1")!.messages.length, 4, "never a duplicate");
});

test("a session a device logged only in part gets just the missing messages, and a message another device logged without an id is not repeated", async () => {
  const { store, mind, l } = await setup();
  mind.rows.set("s2", { status: "active", messages: [{ role: "user", content: "q one" }, { role: "assistant", content: "answer one" }] });
  await store.save(rec("s2", { texts: [["u1", "q one"], ["a1", "answer one"], ["u2", "q two"], ["a2", "answer two"], ["u3", "q three"], ["a3", "answer three"]] }), { origin: "sync" });
  const sum = await l.reconcile();
  assert.equal(sum.messagesAppended, 4);
  assert.deepEqual(roles(mind.rows.get("s2")), ["user:q one", "assistant:answer one", "user:q two", "assistant:answer two", "user:q three", "assistant:answer three"]);
  // the same text said twice is two messages, and both are kept
  await store.save(rec("s3", { texts: [["u1", "ok"], ["a1", "yes"], ["u2", "ok"], ["a2", "yes"]] }), { origin: "sync" });
  await l.reconcile();
  await l.reconcile({ force: true });
  assert.deepEqual(roles(mind.rows.get("s3")), ["user:ok", "assistant:yes", "user:ok", "assistant:yes"]);
});

test("a retried append is stored once: every message carries a stable client_message_id", async () => {
  const { store, mind, l } = await setup();
  await store.save(rec("s4", { texts: [["u1", "hello"], ["a1", "hi"]] }), { origin: "sync" });
  await l.reconcile();
  const ids = mind.rows.get("s4")!.messages.map((m) => m.client_message_id);
  assert.deepEqual(ids, wantedMessages((store.load("s4"))!).map((m, i) => messageIdFor("s4", i, m)));
  assert.ok(ids.every((x) => /^dbt1:s4:\d+:[0-9a-f]{16}$/.test(x!)));
});

test("a deleted session stays closed with its history: it is not in the store, so the reconciler never touches it; a closed one is skipped", async () => {
  const { store, mind, l } = await setup();
  await store.save(rec("gone", { texts: [["u1", "keep me"], ["a1", "kept"]] })); // logged live
  await l.flush();
  await store.remove!("gone");
  await l.flush();
  assert.equal(mind.rows.get("gone")!.status, "ended");
  const opens = mind.calls.length;
  const sum = await l.reconcile();
  assert.equal(sum.sessions, 0);
  assert.equal(mind.calls.length, opens, "no call about it");
  assert.equal(mind.rows.get("gone")!.status, "ended", "still closed");
  assert.deepEqual(roles(mind.rows.get("gone")), ["user:keep me", "assistant:kept"], "history kept");
  // a session the logger closed that is somehow still in the store is skipped, not reopened
  await store.save(rec("closedish", { texts: [["u1", "x"], ["a1", "y"]] }), { origin: "sync" });
  await l.reconcile();
  const l2 = (l as any).st.sessions.closedish; l2.closed = true; mind.rows.get("closedish")!.status = "ended";
  const r = await l.reconcile({ ids: ["closedish"], force: true });
  assert.equal(r.results[0].status, "closed");
  assert.equal(mind.rows.get("closedish")!.status, "ended");
});

test("an empty chat is not filed in MIND; a turn still running is not logged half-said; MIND down is an error that the next run repairs", async () => {
  const { store, mind, l } = await setup();
  await store.save(rec("empty", { texts: [] }), { origin: "sync" });
  await store.save(rec("busy", { texts: [["u1", "working on it"]], run: { status: "running" } as any }), { origin: "sync" });
  await store.save(rec("flaky", { texts: [["u1", "ping"], ["a1", "pong"]] }), { origin: "sync" });
  mind.down(true);
  const bad = await l.reconcile({ ids: ["flaky"] });
  assert.equal(bad.errors, 1);
  mind.down(false);
  const sum = await l.reconcile();
  assert.equal(mind.rows.has("empty"), false);
  assert.deepEqual(roles(mind.rows.get("busy")), ["user:working on it"]);
  assert.deepEqual(roles(mind.rows.get("flaky")), ["user:ping", "assistant:pong"]);
  assert.equal(sum.errors, 0);
});

test("a dry run reports what is missing and writes nothing", async () => {
  const { store, mind, l } = await setup();
  await store.save(rec("d1", { texts: [["u1", "a"], ["a1", "b"]] }), { origin: "sync" });
  const sum = await l.reconcile({ dryRun: true });
  assert.equal(sum.results[0].missing, 2);
  assert.equal(mind.rows.size, 0);
});

test("a transcript longer than one MIND page is read in full (paging), nothing duplicated", async () => {
  const { store, mind, l } = await setup();
  const texts: [string, string][] = Array.from({ length: 12 }, (_, i) => [i % 2 ? `a${i}` : `u${i}`, `m${i}`]);
  await store.save(rec("long", { texts }), { origin: "sync" });
  await l.reconcile();
  const before = mind.rows.get("long")!.messages.length;
  await l.reconcile({ force: true });
  assert.equal(mind.rows.get("long")!.messages.length, before);
  assert.equal(before, 12);
});

test("HOSTED: a session a desktop with no chat scope never logged reaches the tenant's MIND after its sync push; a bot DM too; another tenant gets nothing", async () => {
  const hosted = await hostedRig();
  try {
    hosted.fake.adminKeys.add(hosted.cfgKey);
    hosted.fake.chatScopeless.add(hosted.keys.alice); // alice's key cannot write chats yet: the reconciler asks MIND to add the scopes
    const web = await hosted.as(hosted.keys.alice); // her runtime (and its logger) exists once she is signed in
    await web("GET", "/sessions");
    const owner = userIdFor("alice");
    await hosted.store.save({ ...rec("sync_1", { title: "From the Mac", texts: [["u1", "plan my week"], ["a1", "here is the plan"]] }), owner }, { origin: "sync" });
    await hosted.store.save({ ...rec("dm_47a8", { surface: "bot", title: "Dae to Daebot", peer: "main", bot: "b_x", texts: [["u1", "hey daebot"], ["a1", "hey dae"]] }), owner }, { origin: "sync" });
    await until(() => [...hosted.fake.agentSessions.values()].filter((r) => r.user === "alice" && r.messages.length).length === 2);
    const rows = [...hosted.fake.agentSessions.values()].filter((r) => r.user === "alice");
    assert.deepEqual(roles(rows.find((r) => r.external_session_id === "sync_1")), ["user:plan my week", "assistant:here is the plan"]);
    const dm = rows.find((r) => r.external_session_id === "dm_47a8")!;
    assert.equal(dm.source_key, "daebot-bot-to-bot");
    assert.deepEqual(roles(dm), ["user:hey daebot", "assistant:hey dae"]);
    assert.equal([...hosted.fake.agentSessions.values()].filter((r) => r.user === "bob").length, 0);
    await sleep(300);
    assert.equal(rows.reduce((n, r) => n + r.messages.length, 0), 4, "written once");
  } finally { await hosted.close(); }
});

test("ADMIN BACKFILL: POST /api/admin/mind/reconcile fills every user's MIND from sessions already on the server; GET reads the result; a re-run adds nothing", async () => {
  const hosted = await hostedRig();
  process.env.DAEBOT_MIND_RECONCILE_MS = "off"; // no per-push reconcile: only the backfill writes
  try {
    for (const u of ["alice", "bob"]) await (await hosted.as(hosted.keys[u]))("GET", "/sessions");
    await hosted.store.save({ ...rec("a_old", { texts: [["u1", "alice q"], ["a1", "alice a"]] }), owner: userIdFor("alice") }, { origin: "sync" });
    await hosted.store.save({ ...rec("b_old", { texts: [["u1", "bob q"], ["a1", "bob a"]] }), owner: userIdFor("bob") }, { origin: "sync" });
    const keyH = { ...H, "x-daebot-log-key": process.env.DAEBOT_MISTAKE_LOG_KEY! };
    assert.equal((await http(hosted.gw.url, "POST", "/api/admin/mind/reconcile", { headers: H, body: {} })).status, 401, "needs the log key");
    const go = async (body: unknown) => {
      const r = await http(hosted.gw.url, "POST", "/api/admin/mind/reconcile", { headers: keyH, body });
      assert.equal(r.status, 200);
      return until(async () => { const s = JSON.parse((await http(hosted.gw.url, "GET", "/api/admin/mind/reconcile", { headers: keyH })).body); return s.running === false && s.finishedAt ? s : undefined; });
    };
    const dry = await go({ dryRun: true });
    assert.equal(dry.owners.find((o: any) => o.user === "alice").results[0].missing, 2);
    assert.equal(hosted.fake.agentSessions.size, 0, "a dry run writes nothing");
    const run = await go({});
    assert.equal(run.owners.find((o: any) => o.user === "alice").messagesAppended, 2);
    assert.equal(run.owners.find((o: any) => o.user === "bob").messagesAppended, 2);
    const mine = (u: string) => [...hosted.fake.agentSessions.values()].filter((r) => r.user === u);
    assert.deepEqual(roles(mine("alice")[0]), ["user:alice q", "assistant:alice a"]);
    assert.deepEqual(roles(mine("bob")[0]), ["user:bob q", "assistant:bob a"]);
    const again = await go({});
    assert.equal(again.owners.reduce((n: number, o: any) => n + (o.messagesAppended ?? 0), 0), 0);
  } finally { process.env.DAEBOT_MIND_RECONCILE_MS = "60"; await hosted.close(); }
});
