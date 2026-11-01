import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { DailyCostCap, issueSession } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { userIdFor } from "../../src/auth/users.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import { http, tmpStatic } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex"); // throwaway test values
const H = { host: "daebot.live", "x-forwarded-proto": "https" };

async function rig(rounds: any[] = [{ text: "hi there" }]) {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd(), carol: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob", [keys.carol]: "carol" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const token = rnd();
  const dir = mkdtempSync(join(tmpdir(), "daebot-accts-"));
  const provider = new FakeProvider(rounds);
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore });
  return { gw, keys, token, dir, sessionStore, fake, close: async () => { await gw.close(); await fake.close(); } };
}

type Res = { headers: Record<string, string | string[] | undefined> };
const setCookies = (r: Res): string[] => ([] as string[]).concat((r.headers["set-cookie"] as string[] | undefined) ?? []);
/** A tiny browser: keeps the latest value of every cookie, honors Max-Age=0 deletion. */
class Jar {
  c = new Map<string, string>();
  take(r: Res): this {
    for (const line of setCookies(r)) {
      const [pair, ...attrs] = line.split(";").map((x) => x.trim());
      const i = pair.indexOf("=");
      const name = pair.slice(0, i), val = pair.slice(i + 1);
      if (attrs.some((a) => /^max-age=0$/i.test(a)) || val === "") this.c.delete(name); else this.c.set(name, val);
    }
    return this;
  }
  copy(): Jar { const j = new Jar(); j.c = new Map(this.c); return j; }
  get headers() { return { ...H, cookie: [...this.c].map(([k, v]) => `${k}=${v}`).join("; ") }; }
}
const signIn = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, key: string) => {
  const r = await http(g.gw.url, "POST", "/auth/key", { headers: jar.headers, body: { key } });
  assert.equal(r.status, 200, r.body);
  jar.take(r);
  return r;
};
const get = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, path: string) => http(g.gw.url, "GET", path, { headers: jar.headers });
const post = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, path: string, body: unknown = {}) => http(g.gw.url, "POST", path, { headers: jar.headers, body });


const tc = (id: string, args: Record<string, unknown>) => ({ id, name: "task_board", args });
/** Gives a user a real LIFE board in the fake MIND: an Astra AI Focus with a project, and a MIND Focus with a project. */
const seedLife = (g: Awaited<ReturnType<typeof rig>>, user: string) => {
  const L = g.fake.life.get(user) ?? g.fake.life.set(user, { focuses: new Map(), items: new Map(), docs: new Map() }).get(user)!;
  L.focuses.set("f-astra", { focus_id: "f-astra", name: "Astra AI" });
  L.focuses.set("f-mind", { focus_id: "f-mind", name: "MIND" });
  L.items.set("p-atlas", { item_id: "p-atlas", title: "Atlas Monitor", status: "active_mind", item_type: "project", focus_id: "f-astra", parent_id: null, is_completed: false });
  L.items.set("p-daebot", { item_id: "p-daebot", title: "Daebot", status: "active_mind", item_type: "project", focus_id: "f-mind", parent_id: null, is_completed: false });
  return L;
};
const P = "Atlas Monitor";
const board = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar) => JSON.parse((await get(g, jar, "/board")).body) as { tasks: any[]; stopped: number };

test("task_board: tasks the model declares show on GET /board; a reply to the stopped one goes into THAT session and turns it yellow", async () => {
  const g = await rig([
    { calls: [tc("c1", { action: "set", tasks: [
      { id: "t1", title: "Build the page", status: "in_progress", project: P },
      { id: "t2", title: "Pick the database", status: "stopped", question: "Postgres or SQLite?", project: P },
      { id: "t3", title: "Write the tests", status: "not_started", project: P },
    ] })] },
    { text: "Postgres or SQLite?" },
    { text: "Going with Postgres, carrying on." },
  ]);
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    seedLife(g, "alice");
    const sid = JSON.parse((await post(g, jar, "/sessions", { surface: "web", title: "Build an app" })).body).sessionId;
    assert.equal((await post(g, jar, `/sessions/${sid}/send`, { text: "build me an app" })).status, 200);
    const b = await board(g, jar);
    const mine = b.tasks.filter((t) => t.sessionId === sid);
    assert.deepEqual(mine.map((t) => [t.id, t.status]), [["t1", "in_progress"], ["t2", "stopped"], ["t3", "not_started"]]);
    assert.ok(mine.every((t) => t.sessionTitle === "Build an app" && typeof t.updatedAt === "number"));
    assert.equal(mine[1].question, "Postgres or SQLite?");
    assert.equal(b.stopped, 1);

    // the reply: the normal send path of that same session
    assert.equal((await post(g, jar, `/sessions/${sid}/send`, { text: "Use Postgres." })).status, 200);
    const hist = JSON.parse((await get(g, jar, `/sessions/${sid}/history`)).body).events as any[];
    assert.ok(hist.some((e) => e.type === "user" && e.text === "Use Postgres."), "the reply landed in that session's transcript");
    const after = (await board(g, jar)).tasks.filter((t) => t.sessionId === sid);
    assert.equal(after.find((t) => t.id === "t2").status, "in_progress", "the stopped task moved to yellow when the user replied");
    assert.equal(after.find((t) => t.id === "t2").question, undefined);
  } finally { await g.close(); }
});

test("GET /board is owner-scoped: bob never sees alice's sessions or tasks, and it needs a signed-in user", async () => {
  const g = await rig([
    { calls: [tc("c1", { action: "set", tasks: [{ id: "secret", title: "Alice private plan", status: "stopped", question: "Alice only question?", project: P }] })] },
    { text: "Alice only question?" },
    { text: "Here is Bob's summary." },
  ]);
  try {
    const alice = new Jar();
    await signIn(g, alice, g.keys.alice);
    seedLife(g, "alice");
    const a = JSON.parse((await post(g, alice, "/sessions", { surface: "web", title: "alice work" })).body).sessionId;
    await post(g, alice, `/sessions/${a}/send`, { text: "plan it" });
    const bob = new Jar();
    await signIn(g, bob, g.keys.bob);
    const b = JSON.parse((await post(g, bob, "/sessions", { surface: "web", title: "bob work" })).body).sessionId;
    await post(g, bob, `/sessions/${b}/send`, { text: "summarize" });
    const bobView = await get(g, bob, "/board");
    assert.equal(bobView.status, 200);
    assert.ok(!bobView.body.includes(a) && !bobView.body.includes("Alice") && !bobView.body.includes("alice"), "no trace of alice's session on bob's board");
    const rows = JSON.parse(bobView.body).tasks as any[];
    assert.deepEqual(rows, [], "bob declared nothing, so he has no card (and none of alice's)");
    const aliceRows = (await board(g, alice)).tasks;
    assert.ok(aliceRows.every((r) => r.sessionId !== b), "and the reverse");
    assert.equal(aliceRows.find((r) => r.id === "secret").status, "stopped");
    assert.equal((await get(g, new Jar(), "/board")).status, 401);
    assert.equal((await post(g, alice, "/board", {})).status, 405);
  } finally { await g.close(); }
});

test("a plain chat adds NO card: a session that declared no task, however its turn ended, is not on the board", async () => {
  const g = await rig([{ text: "Here is the plain answer." }, { text: "Which colour do you want?" }]);
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    const s1 = JSON.parse((await post(g, jar, "/sessions", { surface: "web", title: "first" })).body).sessionId;
    await post(g, jar, `/sessions/${s1}/send`, { text: "hi" });
    const s2 = JSON.parse((await post(g, jar, "/sessions", { surface: "web", title: "second" })).body).sessionId;
    await post(g, jar, `/sessions/${s2}/send`, { text: "paint it" });
    const b = await board(g, jar);
    assert.deepEqual(b.tasks, []);
    assert.equal(b.stopped, 0);
  } finally { await g.close(); }
});

test("the board survives a restart: it is saved with the session and read back from disk", async () => {
  const g = await rig([
    { calls: [tc("c1", { action: "set", tasks: [{ id: "t1", title: "Survive", status: "stopped", question: "Still here?", project: P }, { id: "t2", title: "Ship it", status: "ready_to_test", project: P }] })] },
    { text: "Still here?" },
  ]);
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    seedLife(g, "alice");
    const sid = JSON.parse((await post(g, jar, "/sessions", { surface: "web", title: "durable" })).body).sessionId;
    await post(g, jar, `/sessions/${sid}/send`, { text: "go" });
    await new Promise((r) => setTimeout(r, 100)); // saves are queued
    const rec = g.sessionStore.load(sid)!;
    assert.deepEqual((rec.board ?? []).map((t: any) => [t.id, t.status]), [["t1", "stopped"], ["t2", "ready_to_test"]]);
    // a fresh runtime over the same disk, as after a redeploy
    const cfg = baseCfg({ mindBaseUrl: "http://127.0.0.1:1", mindApiKey: "k" });
    const reborn = createRuntime(cfg, { provider: new FakeProvider([{ text: "x" }]), store: g.sessionStore, owner: userIdFor("alice"), bootCache: new BootCache(), hosted: { dailyUsdCap: 50, exempt: true } });
    const rows = reborn.boardRows!();
    assert.deepEqual(rows.filter((r) => r.sessionId === sid).map((r) => [r.id, r.status, r.question]), [["t1", "stopped", "Still here?"], ["t2", "ready_to_test", undefined]]);
    const stranger = createRuntime(cfg, { provider: new FakeProvider([{ text: "x" }]), store: g.sessionStore, owner: userIdFor("bob"), bootCache: new BootCache(), hosted: { dailyUsdCap: 50, exempt: true } });
    assert.deepEqual(stranger.boardRows!(), [], "another owner's runtime reads none of it");
  } finally { await g.close(); }
});

const del = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, path: string) => http(g.gw.url, "DELETE", path, { headers: jar.headers });

test("the whole loop on the live routes: declare with a project, decide, see scope + project + Decision on the card, LIFE item and decision doc in THAT user's MIND only", async () => {
  const decisionArgs = { task_id: "t1", subject: "Pick the host", outcomes: ["Ship Friday"], options: [1, 2, 3, 4].map((i) => ({ name: `Host ${i}`, consequences: `c${i}`, score: i === 2 ? 9 : 4 })), winner: "Host 2", mitigations: ["Back up first"], resolve: "Use Host 2. Dae builds.", cost: "$0, no spend" };
  const g = await rig([
    { calls: [tc("c1", { action: "update", id: "t1", title: "Move the sync job", status: "in_progress", project: "Atlas Monitor" })] },
    { calls: [{ id: "c2", name: "task_decision", args: decisionArgs }] },
    { text: "Started." },
  ]);
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    const L = seedLife(g, "alice");
    seedLife(g, "bob");
    const bobJar = new Jar();
    await signIn(g, bobJar, g.keys.bob);
    const sid = JSON.parse((await post(g, jar, "/sessions", { surface: "web", title: "Sync work" })).body).sessionId;
    assert.equal((await post(g, jar, `/sessions/${sid}/send`, { text: "move the sync job off the old host" })).status, 200);
    const row = (await board(g, jar)).tasks.find((t) => t.id === "t1");
    assert.equal(row.scope, "astra");
    assert.equal(row.project.name, "Atlas Monitor");
    assert.equal(row.decision.winner, "Host 2");
    assert.ok(row.lifeId && !row.sync, JSON.stringify(row));
    // alice's MIND has the LIFE task under her project, and the private decision document; bob's MIND has neither
    const life = L.items.get(row.lifeId);
    assert.deepEqual([life.item_type, life.parent_id, life.status, life.title], ["outcome", "p-atlas", "active_mind", "Move the sync job"]);
    assert.ok(L.docs.get(row.decision.id), "the decision document is in alice's MIND");
    assert.match(L.docs.get(row.decision.id).title, /^Decision - Pick the host - /);
    assert.ok(![...g.fake.life.get("bob")!.items.values()].some((i: any) => i.title === "Move the sync job"), "never bob's MIND");
    assert.equal(g.fake.life.get("bob")!.docs.size, 0);
    // the decision link opens the document
    const page = await get(g, jar, `/board/decision/${row.decision.id}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /Host 2/);
    assert.match(page.body, /Pick the host/);
    assert.equal((await get(g, new Jar(), `/board/decision/${row.decision.id}`)).status, 401);
    assert.equal((await get(g, jar, "/board/decision/nope-nope-nope")).status, 404);
    assert.equal((await get(g, bobJar, `/board/decision/${row.decision.id}`)).status, 404, "bob cannot read alice's document through his own board");
  } finally { await g.close(); }
});

test("cancel keeps the card and tags the LIFE item; delete removes both; neither touches another user's board", async () => {
  const g = await rig([
    { calls: [tc("c1", { action: "set", tasks: [{ id: "keep", title: "Cancel me", status: "in_progress", project: "Daebot" }, { id: "gone", title: "Delete me", status: "not_started", project: "Daebot" }, { id: "stay", title: "Leave me", status: "in_progress", project: "Daebot" }] })] },
    { text: "ok" },
  ]);
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    const L = seedLife(g, "alice");
    const bob = new Jar();
    await signIn(g, bob, g.keys.bob);
    seedLife(g, "bob");
    const sid = JSON.parse((await post(g, jar, "/sessions", { surface: "web", title: "work" })).body).sessionId;
    await post(g, jar, `/sessions/${sid}/send`, { text: "go" });
    const rows = (await board(g, jar)).tasks;
    assert.equal(rows.length, 3);
    const keep = rows.find((r) => r.id === "keep"), gone = rows.find((r) => r.id === "gone");
    assert.equal(rows[0].scope, "mind");

    assert.equal((await post(g, bob, `/board/tasks/${sid}/keep/cancel`)).status, 404, "bob cannot cancel alice's task");
    assert.equal((await del(g, bob, `/board/tasks/${sid}/gone`)).status, 404, "nor delete it");
    assert.equal((await get(g, jar, `/board/tasks/${sid}/keep/cancel`)).status, 405);

    assert.equal((await post(g, jar, `/board/tasks/${sid}/keep/cancel`)).status, 200);
    assert.equal((await post(g, jar, `/board/tasks/${sid}/nope/cancel`)).status, 404);
    let after = (await board(g, jar)).tasks;
    assert.equal(after.find((r) => r.id === "keep").status, "cancelled");
    const li = L.items.get(keep.lifeId);
    assert.deepEqual([li.status, li.tags.includes("cancelled")], ["thought", true]);

    assert.equal((await del(g, jar, `/board/tasks/${sid}/gone`)).status, 200);
    after = (await board(g, jar)).tasks;
    assert.deepEqual(after.map((r) => r.id).sort(), ["keep", "stay"]);
    assert.equal(L.items.has(gone.lifeId), false, "the LIFE item is gone from MIND");
    assert.equal(L.items.has(keep.lifeId), true, "the cancelled one is kept in MIND");

    // MIND refuses the delete: the card stays and the answer says why
    g.fake.lifeStatus = 500;
    const fail = await del(g, jar, `/board/tasks/${sid}/stay`);
    assert.equal(fail.status, 502);
    g.fake.lifeStatus = undefined;
    assert.ok((await board(g, jar)).tasks.some((r) => r.id === "stay"));
    // survives a restart: the cancelled card is read back from disk
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(g.sessionStore.load(sid)!.board!.find((t: any) => t.id === "keep")!.status, "cancelled");
  } finally { await g.close(); }
});

test("a status changed in MIND LIFE comes back onto the card, and an item deleted in MIND unlinks it", async () => {
  const g = await rig([
    { calls: [tc("c1", { action: "set", tasks: [{ id: "a", title: "A", status: "in_progress", project: "Daebot" }, { id: "b", title: "B", status: "in_progress", project: "Daebot" }] })] },
    { text: "ok" },
  ]);
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    const L = seedLife(g, "alice");
    const sid = JSON.parse((await post(g, jar, "/sessions", { surface: "web", title: "work" })).body).sessionId;
    await post(g, jar, `/sessions/${sid}/send`, { text: "go" });
    const rows = (await board(g, jar)).tasks;
    L.items.get(rows.find((r) => r.id === "a").lifeId).status = "completed";
    L.items.delete(rows.find((r) => r.id === "b").lifeId);
    await new Promise((r) => setTimeout(r, 8100)); // the per-project read is cached for a few seconds
    const after = (await board(g, jar)).tasks;
    assert.equal(after.find((r) => r.id === "a").status, "ready_to_test", "completed in MIND = ready to test on the card");
    const b = after.find((r) => r.id === "b");
    assert.equal(b.lifeId, undefined);
    assert.match(b.sync, /Removed from MIND LIFE/);
  } finally { await g.close(); }
});

test("a MIND outage never blocks the work: the card appears with a plain note", async () => {
  const g = await rig([
    { calls: [tc("c1", { action: "update", id: "a", title: "A", status: "in_progress", project: "Daebot" })] },
    { text: "ok" },
  ]);
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    seedLife(g, "alice");
    g.fake.lifeStatus = 503;
    const sid = JSON.parse((await post(g, jar, "/sessions", { surface: "web", title: "work" })).body).sessionId;
    await post(g, jar, `/sessions/${sid}/send`, { text: "go" });
    const a = (await board(g, jar)).tasks.find((r) => r.id === "a");
    assert.match(a.sync, /^Not saved to MIND/);
    assert.equal(a.lifeId, undefined);
  } finally { await g.close(); }
});
