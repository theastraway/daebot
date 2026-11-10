// Every Daebot session is logged to the signed-in tenant's MIND as ONE Agent Session, from every device, with its messages once.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedRig, deskRig, until, sleep } from "./rig.ts";
import { messagesFrom, SessionLogger } from "../../src/mind/session-log.ts";
import { createFileStore } from "../../src/persist.ts";
import { rec } from "./helpers.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mindRows = (hosted: Awaited<ReturnType<typeof hostedRig>>, user = "alice") => [...hosted.fake.agentSessions.values()].filter((r) => r.user === user);
const said = (r: { messages: { role: string; content: string }[] }) => r.messages.filter((m) => m.role !== "tool").map((m) => `${m.role}:${m.content}`);

test("messagesFrom: user at once, assistant only when its turn is done, tools summarised, photos named", () => {
  const h: any[] = [
    { type: "user", text: "hi", id: "u1", photos: [{ id: "p1", name: "a.jpg", width: 1, height: 1 }] },
    { type: "toolStart", tool: "bash", receiptId: "r1", args: {} }, { type: "toolStart", tool: "bash", receiptId: "r2", args: {} },
    { type: "text", delta: "work" }, { type: "text", delta: "ing" },
  ];
  let r = messagesFrom(h, 0);
  assert.deepEqual(r.msgs.map((m) => m.role), ["user"]);
  assert.equal(r.upTo, 1, "the unfinished turn waits");
  assert.match(r.msgs[0].content, /1 photo attached: a\.jpg/);
  h.push({ type: "done", finalText: "working" });
  r = messagesFrom(h, 1);
  assert.deepEqual(r.msgs, [{ role: "tool", content: "Tools: bash x2" }, { role: "assistant", content: "working" }]);
  assert.equal(r.upTo, h.length);
});

test("a desktop session is logged to the tenant's MIND (once, with its messages); a phone message on the same session lands in the SAME MIND session", async () => {
  const hosted = await hostedRig({ script: [{ text: "phone reply" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "mac reply" }] });
  try {
    const { sessionId } = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop", title: "Plan the week" })).body);
    await desk.api("POST", `/sessions/${sessionId}/send`, { text: "from the mac" });
    await until(() => mindRows(hosted).some((r) => said(r).includes("assistant:mac reply")));
    // the phone continues it on daebot.live
    await until(() => hosted.store.load(sessionId));
    await desk.api("POST", "/sync/now");
    const web = await hosted.as(hosted.keys.alice);
    await web("POST", "/sessions", { surface: "web", resumeId: sessionId }); // the phone opens the chat it saw in its list
    await web("POST", `/sessions/${sessionId}/send`, { text: "from the phone" });
    await until(() => said(mindRows(hosted)[0] ?? { messages: [] }).includes("assistant:phone reply"));
    await desk.api("POST", "/sync/now"); await sleep(500); await desk.api("POST", "/sync/now");
    const rows = mindRows(hosted).filter((r) => r.external_session_id === sessionId);
    assert.equal(rows.length, 1, "one MIND session for the one Daebot session, whichever device wrote");
    assert.equal(rows[0].source_key, "daebot");
    assert.equal(rows[0].title, "Plan the week");
    assert.deepEqual(said(rows[0]), ["user:from the mac", "assistant:mac reply", "user:from the phone", "assistant:phone reply"], "every message once, in order");
    // bob's tenant holds nothing of alice's
    assert.equal(mindRows(hosted, "bob").length, 0);
  } finally { await desk.close(); await hosted.close(); }
});

test("a bot thread is logged under daebot-bot-<slug>; a bot-to-bot DM is logged as its OWN session under daebot-bot-to-bot, never in MAIN", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "scout here" }] });
  try {
    const bot = JSON.parse((await desk.api("POST", "/bots", { slug: "scout", name: "Scout" })).body).bot;
    const { sessionId } = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop", bot: bot.id })).body);
    await desk.api("POST", `/sessions/${sessionId}/send`, { text: "scout, report" });
    await until(() => mindRows(hosted).some((r) => r.source_key === "daebot-bot-scout" && said(r).includes("assistant:scout here")));
    const store = desk.store;
    await store.save({ ...rec("dm_1", { surface: "bot", title: "Scout to Daebot", bot: bot.id, peer: "main", texts: [["u1", "status between bots"], ["a1", "all clear"]] }), owner: "owner" });
    await until(() => mindRows(hosted).some((r) => r.external_session_id === "dm_1"));
    const dm = mindRows(hosted).find((r) => r.external_session_id === "dm_1")!;
    assert.equal(dm.source_key, "daebot-bot-to-bot", "its own source, labelled bot to bot");
    assert.equal(dm.title, "Bot to bot: Scout to Daebot");
    assert.deepEqual(hosted.fake.seen.find((x) => x.path.endsWith("/agent-sessions/open") && x.body?.external_session_id === "dm_1")?.body.tags, ["bot-to-bot"], "tagged bot-to-bot in MIND");
    assert.equal(hosted.fake.seen.filter((x) => x.path.endsWith("/agent-sessions/open") && x.body?.external_session_id === sessionId).every((x) => x.body.tags === undefined), true, "an ordinary bot thread carries no such tag");
    assert.ok(said(dm).some((x) => x.includes("status between bots")));
    assert.ok(!mindRows(hosted).some((r) => r.source_key === "daebot" && JSON.stringify(r.messages).includes("status between bots")), "never in the MAIN session");
    assert.equal(mindRows(hosted).filter((r) => r.external_session_id === "dm_1").length, 1);
  } finally { await desk.close(); await hosted.close(); }
});

test("a signed-in user whose key lacks the chat scopes: hosted asks MIND to add them (admin key), then logs the chat; the first 403 never loses a message", async () => {
  const hosted = await hostedRig({ script: [{ text: "logged anyway" }] });
  try {
    hosted.fake.adminKeys.add(hosted.cfgKey);
    hosted.fake.chatScopeless.add(hosted.keys.alice);
    const web = await hosted.as(hosted.keys.alice);
    const { sessionId } = JSON.parse((await web("POST", "/sessions", { surface: "web", title: "No scope yet" })).body);
    await web("POST", `/sessions/${sessionId}/send`, { text: "hello from the web" });
    await until(() => mindRows(hosted).some((r) => r.external_session_id === sessionId && said(r).includes("assistant:logged anyway")));
    assert.equal(hosted.fake.chatScopeless.has(hosted.keys.alice), false, "MIND upgraded the user's key");
    const up = hosted.fake.seen.filter((x) => x.path === "/developer/v1/agent-sessions/daebot-scopes");
    assert.equal(up.length, 1, "asked once");
    assert.equal(up[0].key, hosted.cfgKey, "with the server's admin key, not the user's");
    assert.equal(up[0].body.key, hosted.keys.alice);
    assert.deepEqual(said(mindRows(hosted).find((r) => r.external_session_id === sessionId)!), ["user:hello from the web", "assistant:logged anyway"]);
    // bob's key was never touched
    assert.equal(hosted.fake.seen.some((x) => x.path.endsWith("daebot-scopes") && x.body?.key === hosted.keys.bob), false);
  } finally { await hosted.close(); }
});

test("BACKFILL: sessions saved before logging existed are logged on first run, not twice on the second", async () => {
  const hosted = await hostedRig();
  const dir = mkdtempSync(join(tmpdir(), "desk-old-"));
  const old = createFileStore(dir);
  await old.save(rec("old_1", { title: "An old chat", texts: [["u1", "old question"], ["a1", "old answer"]] }));
  const desk = await deskRig(hosted, hosted.keys.alice, { dir, sync: false });
  try {
    await until(() => mindRows(hosted).some((r) => r.external_session_id === "old_1"));
    const row = mindRows(hosted).find((r) => r.external_session_id === "old_1")!;
    await until(() => said(row).length === 2);
    assert.deepEqual(said(row), ["user:old question", "assistant:old answer"]);
    await desk.close();
    const again = await deskRig(hosted, hosted.keys.alice, { dir, sync: false });
    await sleep(600);
    assert.equal(mindRows(hosted).filter((r) => r.external_session_id === "old_1").length, 1);
    assert.equal(said(mindRows(hosted).find((r) => r.external_session_id === "old_1")!).length, 2, "not logged a second time");
    await again.close();
  } finally { await hosted.close(); }
});

test("a deleted chat closes its MIND session with a note; the history stays", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "ok" }] });
  try {
    const { sessionId } = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop" })).body);
    await desk.api("POST", `/sessions/${sessionId}/send`, { text: "keep my history" });
    await until(() => mindRows(hosted).some((r) => said(r).includes("assistant:ok")));
    await desk.api("DELETE", `/sessions/${sessionId}?purge=1`);
    const row = (await until(() => mindRows(hosted).find((r) => r.status === "ended")))!;
    assert.match(row.summary ?? "", /deleted/);
    assert.deepEqual(said(row), ["user:keep my history", "assistant:ok"]);
  } finally { await desk.close(); await hosted.close(); }
});

test("MIND unreachable: nothing is lost, the logger retries and writes each message once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "log-retry-"));
  const store = createFileStore(dir);
  const calls: any[] = [];
  let down = true;
  const client: any = { call: async (_t: string, a: any) => { calls.push(a); if (down) throw new Error("MIND down"); return JSON.stringify(a.action === "open" ? { session_id: "m1", resumed: false } : { ok: true }); } };
  const l = new SessionLogger({ client: () => client, store, owner: "owner", sourceKeyOf: () => "daebot", stateFile: join(dir, "s.json"), retryMs: 80 });
  l.start();
  await store.save(rec("r1", { texts: [["u1", "q"], ["a1", "a"]] }));
  await sleep(300);
  assert.ok(l.stats.errors > 0);
  down = false;
  await until(() => calls.some((c) => c.action === "append"));
  await sleep(200);
  const appended = calls.filter((c) => c.action === "append").flatMap((c) => c.messages.map((m: any) => m.content));
  assert.deepEqual(appended, ["q", "a"]);
  l.stop();
});

test("DESKTOP: a key without the chat scopes is upgraded through daebot.live (which holds the admin key), then the logger writes the chat", async () => {
  const { upgradeViaDaebot } = await import("../../src/mind/scope-upgrade.ts");
  const hosted = await hostedRig();
  try {
    hosted.fake.adminKeys.add(hosted.cfgKey);
    hosted.fake.chatScopeless.add(hosted.keys.alice);
    const dir = mkdtempSync(join(tmpdir(), "log-scope-"));
    const store = createFileStore(dir);
    const mindClient: any = { call: async (_t: string, a: any) => {
      const r = await fetch(`${hosted.fake.base}/agent-sessions/${a.action === "open" ? "open" : `${a.session_id}/${a.action}`}`, { method: "POST", headers: { "x-api-key": hosted.keys.alice, "content-type": "application/json" }, body: JSON.stringify(a) });
      if (!r.ok) { const e: any = new Error(`MIND agent_sessions ${a.action}: HTTP ${r.status} ${(JSON.parse(await r.text()) as any).detail}`); e.status = r.status; throw e; }
      return await r.text();
    } };
    const l = new SessionLogger({ client: () => mindClient, store, owner: "owner", sourceKeyOf: () => "daebot", stateFile: join(dir, "s.json"), retryMs: 80, upgradeScopes: () => upgradeViaDaebot({ url: "https://daebot.live", key: hosted.keys.alice, fetchImpl: hosted.bridge() }) });
    l.start();
    await store.save(rec("dsk1", { texts: [["u1", "from a desktop"], ["a1", "answered"]] }));
    await until(() => mindRows(hosted).some((r) => r.external_session_id === "dsk1" && said(r).includes("assistant:answered")));
    assert.equal(l.stats.upgraded, 1);
    assert.equal(hosted.fake.chatScopeless.has(hosted.keys.alice), false);
    // an unknown key is refused by daebot.live, and nothing is upgraded for it
    assert.equal(await upgradeViaDaebot({ url: "https://daebot.live", key: "mind_" + "z".repeat(30), fetchImpl: hosted.bridge() }), false);
    l.stop();
  } finally { await hosted.close(); }
});
