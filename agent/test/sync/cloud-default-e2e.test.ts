// MIND Cloud is the standard home, end to end through two real gateways (the desktop and daebot.live):
//   * every NEW session and bot starts on MIND Cloud, from every surface, and a desktop message in a cloud session RUNS on daebot.live;
//   * a computer is only ever the person's choice (the "Run on a computer" switch), it is remembered everywhere, and a local session runs there;
//   * a local session whose computer is off never gives a raw error: one clear message with one action, "Move to MIND Cloud";
//   * the one-time migration puts stamped (not chosen) computers back on MIND Cloud with every message kept, and the desktop follows.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedRig, deskRig, until, sleep, localSession } from "./rig.ts";
import { parseSse } from "../gateway/helpers.ts";
import { rec } from "./helpers.ts";

const MAC = "d_" + "1".repeat(16);
const J = (r: { body: string }) => JSON.parse(r.body);

test("every new session starts on MIND Cloud, from the desktop, the web, the phone and the agent API; a new bot too", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice, { deviceName: "Anthonys MacBook Pro" });
  try {
    const web = await hosted.as(hosted.keys.alice);
    const onDesk = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop", title: "from the mac" })).body).sessionId;
    const onWeb = JSON.parse((await web("POST", "/sessions", { surface: "web" })).body).sessionId;
    const onPhone = JSON.parse((await web("POST", "/sessions", { surface: "ios" })).body).sessionId;
    const viaApi = String((await hosted.host(hosted.keys.alice, "POST", "/api/agent/turn", { text: "hi", surface: "mind-chat" })).headers["x-daebot-session"]);
    const dl = JSON.parse((await desk.api("GET", "/sessions")).body);
    // the desktop's own session list: nothing in it names a computer unless the person chose it
    await desk.api("POST", `/sessions/${onDesk}/send`, { text: "first message" });
    await until(() => hosted.store.load(onDesk));
    for (const [label, rec1] of [["desktop", hosted.store.load(onDesk)], ["web", await until(() => hosted.store.load(onWeb) ?? undefined, 500).catch(() => undefined)], ["api", await until(() => hosted.store.load(viaApi))]] as const) {
      if (!rec1) continue;
      assert.equal(rec1.env!.kind, "cloud", `${label}: new sessions are MIND Cloud`);
      assert.equal(rec1.envBy, "default", `${label}: nobody chose a computer`);
    }
    void onPhone; void dl;
    // a new bot: its home is MIND Cloud on the desktop and on daebot.live, and a thread of it too
    const deskBot = JSON.parse((await desk.api("POST", "/bots", { slug: "scout", name: "Scout" })).body).bot;
    assert.equal(deskBot.env.kind, "cloud", "the desktop shows a new bot on MIND Cloud");
    assert.equal(deskBot.remote, false);
    const hostBot = await until(async () => JSON.parse((await web("GET", "/bots")).body).bots.find((b: any) => b.slug === "scout"));
    assert.equal(hostBot.env.kind, "cloud"); assert.equal(hostBot.remote, false);
    const t = JSON.parse((await web("POST", "/sessions", { surface: "web", bot: hostBot.id })).body).sessionId;
    await web("POST", `/sessions/${t}/send`, { text: "hello bot" });
    const tr = (await until(() => hosted.store.load(t)))!;
    assert.equal(tr.env!.kind, "cloud");
  } finally { await desk.close(); await hosted.close(); }
});

test("a desktop message in a MIND Cloud session runs on daebot.live: the cloud model answers, the events reach the desktop, the transcript lands in both stores", async () => {
  const hosted = await hostedRig({ script: [{ text: "answered in the cloud" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "DESKTOP MODEL SHOULD NOT RUN" }] });
  try {
    const sid = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop", title: "cloud by default" })).body).sessionId;
    const res = await desk.api("POST", `/sessions/${sid}/send`, { text: "where do you run?" });
    assert.equal(res.status, 200, res.body);
    assert.equal(String(res.headers["x-daebot-cloud"]), "1");
    const evs = parseSse(res.body) as any[];
    assert.ok(evs.some((e) => e.type === "text" && /answered in the cloud/.test(e.delta)), res.body);
    assert.equal(evs.at(-1).type, "done");
    assert.equal(desk.provider.requests.length, 0, "the computer's own model never ran it");
    assert.equal(hosted.provider.requests.length, 1, "the cloud's model did");
    // the cloud holds it, and the desktop's store has the same transcript, once
    const onCloud = (await until(() => hosted.store.load(sid)))!;
    assert.equal(onCloud.env!.kind, "cloud");
    const local = (await until(() => { const r = desk.store.load(sid); return r && r.history.some((e: any) => e.type === "text" && /answered in the cloud/.test(e.delta)) ? r : undefined; }))!;
    assert.equal(local.history.filter((e: any) => e.type === "user").length, 1);
    const hist = JSON.parse((await desk.api("GET", `/sessions/${sid}/history`)).body);
    assert.ok(hist.events.some((e: any) => e.type === "user" && e.text === "where do you run?"));
    // a second message continues the same cloud thread
    const again = await desk.api("POST", `/sessions/${sid}/send`, { text: "and again" });
    assert.equal(again.status, 200, again.body);
    assert.equal(hosted.provider.requests.length, 2);
    assert.equal(desk.provider.requests.length, 0);
  } finally { await desk.close(); await hosted.close(); }
});

test("a cloud bot thread opened on the desktop runs in the cloud too (Run on a computer is off)", async () => {
  const hosted = await hostedRig({ script: [{ text: "scout in the cloud" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "DESKTOP MODEL SHOULD NOT RUN" }] });
  try {
    const bot = JSON.parse((await desk.api("POST", "/bots", { slug: "scout", name: "Scout" })).body).bot;
    await until(async () => JSON.parse((await (await hosted.as(hosted.keys.alice))("GET", "/bots")).body).bots.find((b: any) => b.slug === "scout"));
    const sid = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop", bot: bot.id })).body).sessionId;
    const res = await desk.api("POST", `/sessions/${sid}/send`, { text: "scout, status" });
    assert.ok((parseSse(res.body) as any[]).some((e) => e.type === "text" && /scout in the cloud/.test(e.delta)), res.body);
    assert.equal(desk.provider.requests.length, 0);
    const th = (await until(() => hosted.store.load(sid)))!;
    assert.equal(th.bot !== undefined, true, "the cloud thread is the bot's");
  } finally { await desk.close(); await hosted.close(); }
});

test("when MIND Cloud cannot be reached the desktop says so in one message with one action (Run on this computer), never a raw error", async () => {
  const hosted = await hostedRig({ script: [{ text: "cloud" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "ran here instead" }] });
  try {
    const sid = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop" })).body).sessionId;
    await hosted.close(); // daebot.live goes away
    const res = await desk.api("POST", `/sessions/${sid}/send`, { text: "anyone?" });
    const evs = parseSse(res.body) as any[];
    const n = evs.find((e) => e.type === "notice" && e.action);
    assert.ok(n, res.body);
    assert.match(n.text, /MIND Cloud/);
    assert.deepEqual(n.action, { kind: "run_here", label: "Run on this computer", sessionId: sid });
    assert.equal(desk.provider.requests.length, 0, "it did not silently run here");
    // the one action: the person chooses this computer, and the same message then runs here
    assert.equal((await desk.api("PATCH", `/sessions/${sid}`, { home: "local" })).status, 200);
    const ok = await desk.api("POST", `/sessions/${sid}/send`, { text: "anyone?" });
    assert.ok((parseSse(ok.body) as any[]).some((e) => e.type === "text" && /ran here instead/.test(e.delta)), ok.body);
  } finally { await desk.close(); }
});

test("the switch: Run on a computer is the person's explicit choice, saved with the session, shown on every device, and the session then runs there; off puts it back on MIND Cloud", async () => {
  const hosted = await hostedRig({ script: [{ text: "SERVER SHOULD NOT ANSWER" }, { text: "cloud again" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "ran on the mac" }, { text: "ran on the mac too" }], deviceName: "Anthonys MacBook Pro" });
  try {
    const web = await hosted.as(hosted.keys.alice);
    const sid = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop", title: "chosen" })).body).sessionId;
    // this computer is online (it polls); the person turns the switch on at the desktop
    const on = await desk.api("PATCH", `/sessions/${sid}`, { home: "local" });
    assert.equal(on.status, 200, on.body);
    assert.equal(JSON.parse(on.body).env.id, MAC);
    await until(() => desk.store.load(sid)?.envBy === "user");
    const first = await desk.api("POST", `/sessions/${sid}/send`, { text: "on the mac" });
    assert.ok((parseSse(first.body) as any[]).some((e) => e.type === "text" && /ran on the mac/.test(e.delta)));
    assert.equal(hosted.provider.requests.length, 0);
    // every device shows it: the hosted record, the web list, with who decided
    const onCloud = (await until(() => { const r = hosted.store.load(sid); return r?.envBy === "user" ? r : undefined; }))!;
    assert.equal(onCloud.env!.id, MAC);
    const row = JSON.parse((await web("GET", "/sessions")).body).sessions.find((s: any) => s.id === sid);
    assert.equal(row.env.id, MAC);
    // a message from the phone to this local session goes to the computer, not to the cloud
    await web("POST", "/sessions", { surface: "web", resumeId: sid }); // the phone opens the chat it saw in its list
    const phone = await web("POST", `/sessions/${sid}/send`, { text: "from the phone" });
    const pe = parseSse(phone.body) as any[];
    assert.ok(pe.some((e) => e.type === "text" && /ran on the mac too/.test(e.delta)), phone.body);
    assert.equal(hosted.provider.requests.length, 0, "the cloud model did not answer a local session");
    // the person turns it off (from the phone): MIND Cloud again, on every device
    const off = await web("PATCH", `/sessions/${sid}`, { home: "cloud" });
    assert.equal(off.status, 200, off.body);
    await until(() => desk.store.load(sid)?.env?.kind === "cloud");
    await web("POST", "/sessions", { surface: "web", resumeId: sid }); // the phone reopens the chat (a sync may have just refreshed it)
    const back = await web("POST", `/sessions/${sid}/send`, { text: "now in the cloud" });
    assert.ok((parseSse(back.body) as any[]).some((e) => e.type === "text" && /SERVER SHOULD NOT ANSWER|cloud again/.test(e.delta)), back.body);
    assert.equal(hosted.provider.requests.length, 1);
    // bad input is refused
    assert.equal((await web("PATCH", `/sessions/${sid}`, { home: "mars" })).status, 400);
  } finally { await desk.close(); await hosted.close(); }
});

test("OFFLINE LOCAL: a message to a local session whose computer is off gives a clear message with one action; the action continues the thread in MIND Cloud with the same words", async () => {
  const hosted = await hostedRig({ script: [{ text: "continued in the cloud" }], onlineMs: 300 });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "mac" }], deviceName: "Anthonys MacBook Pro" });
  try {
    const web = await hosted.as(hosted.keys.alice);
    const sid = await localSession(desk, { surface: "desktop", title: "on my mac" });
    await desk.api("POST", `/sessions/${sid}/send`, { text: "first" });
    await until(() => hosted.store.load(sid)?.envBy === "user");
    await desk.close(); // the Mac goes to sleep
    await sleep(450);
    await web("POST", "/sessions", { surface: "web", resumeId: sid }); // the phone opens the chat it saw in its list
    const pending = web("POST", `/sessions/${sid}/send`, { text: "are you awake?" });
    await sleep(400);
    // the sender sees the message and the one action
    // (the request stays open while the message waits; the action ends it)
    const mv = await web("PATCH", `/sessions/${sid}`, { home: "cloud" });
    assert.equal(mv.status, 200, mv.body);
    assert.deepEqual(JSON.parse(mv.body).queued, ["are you awake?"], "the waiting message is handed back to be sent where the session now runs");
    const evs = parseSse((await pending).body) as any[];
    const n = evs.find((e) => e.type === "notice" && e.action);
    assert.ok(n, JSON.stringify(evs));
    assert.match(n.text, /Anthonys MacBook Pro is asleep or offline/);
    assert.doesNotMatch(n.text, /not awake|no such session|error/i);
    assert.deepEqual(n.action, { kind: "move_to_cloud", label: "Move to MIND Cloud", sessionId: sid });
    assert.ok(evs.some((e) => e.type === "notice" && /Moved to MIND Cloud/.test(e.text)));
    // and the same words, sent again, now run in the cloud
    const res = await web("POST", `/sessions/${sid}/send`, { text: "are you awake?" });
    assert.ok((parseSse(res.body) as any[]).some((e) => e.type === "text" && /continued in the cloud/.test(e.delta)), res.body);
    await until(() => hosted.store.load(sid)?.env?.kind === "cloud");
    assert.equal(hosted.store.load(sid)!.envBy, "user");
  } finally { await hosted.close(); }
});

test("MIGRATION: sessions stamped onto a computer (not chosen) move to MIND Cloud with every message kept, the desktop follows, and what the person chose stays", async () => {
  const hosted = await hostedRig({ logKey: "k-migrate" });
  const desk = await deskRig(hosted, hosted.keys.alice, { deviceName: "Anthonys MacBook Pro" });
  try {
    const key = hosted.keys.alice;
    // the account has two sessions the old build stamped onto the Mac, and one the person chose
    const stamp = { id: MAC, kind: "machine" as const, name: "Anthonys MacBook Pro" };
    const seed = (id: string, extra: Record<string, unknown> = {}) => ({ ...rec(id, { surface: "desktop", title: id, texts: [["u1", `hello ${id}`], ["a1", `hi from ${id}`], ["u2", "second"], ["a2", "answer"]], env: stamp, ...extra }) });
    // put them in through the sync API as a device would (records with a decision time were chosen; ones without were stamped by the old build)
    const wire = (r: any) => (({ owner, tier, run, ...w }) => w)(r);
    await hosted.host(key, "POST", "/api/sync/sessions", { records: [wire(seed("stamped-1")), wire(seed("stamped-2")), wire(seed("chosen-1", { envAt: Date.now(), envBy: "user" }))] });
    // the sync API already refuses to auto-stamp a NEW record (tested elsewhere); write the old stamps straight into the store as they were saved before
    const o = hosted.store.load("chosen-1")!.owner;
    for (const id of ["stamped-1", "stamped-2"]) await hosted.store.save({ ...hosted.store.load(id)!, env: stamp, envAt: undefined, envBy: undefined, owner: o });
    const lenBefore = hosted.store.load("stamped-1")!.history.length;
    // nothing moves on its own: an admin starts the migration for the account named (here by username), and a dry run changes nothing
    const dry = J(await hosted.admin("POST", "/api/admin/sync/homes", { migrate: "dry", owners: ["alice"] })).result;
    assert.equal(dry[0].moved.length, 2); assert.equal(hosted.store.load("stamped-1")!.env!.kind, "machine");
    const run = J(await hosted.admin("POST", "/api/admin/sync/homes", { migrate: true, owners: ["alice"] })).result;
    assert.deepEqual(run[0].moved.map((x: any) => x.id).sort(), ["stamped-1", "stamped-2"]);
    assert.ok(run[0].moved.every((x: any) => x.why === "auto-stamped" && x.from === "Anthonys MacBook Pro"), "it says what moved and why");
    assert.deepEqual(run[0].kept.map((x: any) => `${x.id}:${x.why}`), ["chosen-1:user-chose-local"]);
    await until(() => hosted.store.load("stamped-1")?.env?.kind === "cloud" && hosted.store.load("stamped-2")?.env?.kind === "cloud", 10_000);
    const m = hosted.store.load("stamped-1")!;
    assert.equal(m.envBy, "auto"); assert.ok(m.envAt! > 0);
    assert.equal(m.history.length, lenBefore, "no message is lost in the move");
    assert.equal(hosted.store.load("chosen-1")!.env!.id, MAC, "a computer the person chose is kept");
    assert.equal(hosted.store.load("chosen-1")!.envBy, "user");
    // the desktop follows (it held its own stamp for the same session)
    await desk.store.save({ ...rec("stamped-1", { surface: "desktop", title: "stamped-1", texts: [["u1", "hello stamped-1"], ["a1", "hi from stamped-1"], ["u2", "second"], ["a2", "answer"]], env: stamp }), owner: "owner" });
    await until(() => desk.store.load("stamped-1")?.env?.kind === "cloud", 10_000);
    assert.equal(desk.store.load("stamped-1")!.history.length, lenBefore, "the desktop's copy keeps every message too");
    // the report says what moved and why
    const map = JSON.parse((await hosted.host(key, "GET", "/api/sync/sessions?since=0&limit=50")).body).rows.find((r: any) => r.id === "stamped-1");
    assert.equal(map.env.kind, "cloud"); assert.equal(map.envBy, "auto");
  } finally { await desk.close(); await hosted.close(); }
});

test("the migration never runs on its own, runs once per account, and never undoes a computer the person chose", async () => {
  const hosted = await hostedRig({ logKey: "k-once", envSweepMs: 400 });
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const sid = await localSession(desk, { surface: "desktop", title: "mine" });
    await desk.api("POST", `/sessions/${sid}/send`, { text: "hi" });
    await until(() => hosted.store.load(sid)?.envBy === "user");
    await sleep(1500); // the start-up backfill has run by now: it only gives a home to sessions with none
    assert.equal(hosted.store.load(sid)!.env!.id, MAC, "nothing migrated by itself");
    assert.equal((await hosted.admin("POST", "/api/admin/sync/homes", { migrate: true, owners: ["alice"] })).status, 200);
    assert.equal(hosted.store.load(sid)!.env!.id, MAC); assert.equal(hosted.store.load(sid)!.envBy, "user");
    const again = J(await hosted.admin("POST", "/api/admin/sync/homes", { migrate: true, owners: ["alice"] })).result;
    assert.deepEqual(again, [], "a second run does nothing: the marker says it already ran");
    assert.equal((await hosted.host(hosted.keys.alice, "POST", "/api/admin/sync/homes", { migrate: true })).status, 401, "only an admin starts it");
  } finally { await desk.close(); await hosted.close(); }
});
