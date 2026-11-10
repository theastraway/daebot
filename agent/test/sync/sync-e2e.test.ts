// Session sync end to end: a desktop gateway (local) and daebot.live (hosted) with the same MIND user converge; users stay apart.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedRig, deskRig, until, H } from "./rig.ts";
import { parseSse } from "../gateway/helpers.ts";

test("a session created on the desktop appears on daebot.live for the same user, and only for that user", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const { sessionId } = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop", title: "from the mac" })).body);
    await desk.api("POST", `/sessions/${sessionId}/send`, { text: "hello from the mac" });
    // the desktop agent mirrors it
    const row = await until(async () => {
      const r = JSON.parse((await hosted.host(hosted.keys.alice, "GET", "/api/sync/sessions?since=0")).body);
      return r.rows.find((x: any) => x.id === sessionId);
    });
    assert.ok(row);
    const got = JSON.parse((await hosted.host(hosted.keys.alice, "GET", `/api/sync/sessions/${sessionId}`)).body).session;
    assert.ok(got.history.some((e: any) => e.type === "user" && e.text === "hello from the mac"));
    assert.ok(got.history.some((e: any) => e.type === "text" && /desktop says hi/.test(e.delta)));
    assert.ok(!("owner" in got));
    // it is in alice's hosted store, owned by alice's principal, and nobody else can read or list it
    const stored = hosted.store.load(sessionId)!;
    assert.match(String(stored.owner), /^u_[a-f0-9]{24}$/);
    const bobList = JSON.parse((await hosted.host(hosted.keys.bob, "GET", "/api/sync/sessions?since=0")).body);
    assert.equal(bobList.rows.length, 0);
    assert.equal((await hosted.host(hosted.keys.bob, "GET", `/api/sync/sessions/${sessionId}`)).status, 404);
    // and no duplicates after more rounds
    await desk.api("POST", "/sync/now");
    await desk.api("POST", "/sync/now");
    const again = JSON.parse((await hosted.host(hosted.keys.alice, "GET", "/api/sync/sessions?since=0")).body);
    assert.equal(again.rows.filter((x: any) => x.id === sessionId).length, 1);
    assert.equal(hosted.store.load(sessionId)!.history.filter((e: any) => e.type === "user").length, 1);
  } finally { await desk.close(); await hosted.close(); }
});

test("a session started on daebot.live (the phone/web) pulls down to the desktop", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const res = await hosted.host(hosted.keys.alice, "POST", "/api/agent/turn", { text: "typed on the phone", surface: "web" });
    assert.equal(res.status, 200, res.body);
    const sid = String(res.headers["x-daebot-session"]);
    assert.ok(parseSse(res.body).some((e: any) => e.type === "text"));
    await until(() => desk.store.load(sid));
    const local = desk.store.load(sid)!;
    assert.equal(local.owner, "owner");
    assert.ok(local.history.some((e: any) => e.type === "user" && e.text === "typed on the phone"));
    // the desktop's own list shows it (this is what the Mac UI renders)
    const list = JSON.parse((await desk.api("GET", "/sessions")).body).sessions;
    assert.ok(list.some((s: any) => s.id === sid));
  } finally { await desk.close(); await hosted.close(); }
});

test("both devices add messages to the same session: both survive, in both stores, once each", async () => {
  const hosted = await hostedRig({ script: [{ text: "reply one" }, { text: "reply two" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "mac reply" }, { text: "mac reply 2" }] });
  try {
    const { sessionId } = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop" })).body);
    await desk.api("POST", `/sessions/${sessionId}/send`, { text: "first from mac" });
    await until(() => hosted.store.load(sessionId));
    await desk.api("POST", "/sync/now");
    // the phone continues the same session on the hosted side
    const turn = await hosted.host(hosted.keys.alice, "POST", "/api/agent/turn", { text: "second from phone", sessionId, surface: "web" });
    assert.equal(turn.status, 200, turn.body);
    await until(async () => { await desk.api("POST", "/sync/now"); return desk.store.load(sessionId)!.history.some((e: any) => e.type === "user" && e.text === "second from phone"); });
    const texts = (r: any) => r.history.filter((e: any) => e.type === "user").map((e: any) => e.text);
    assert.deepEqual(texts(desk.store.load(sessionId)!), ["first from mac", "second from phone"]);
    assert.deepEqual(texts(hosted.store.load(sessionId)!), ["first from mac", "second from phone"]);
  } finally { await desk.close(); await hosted.close(); }
});

test("sync API: needs a valid key, refuses another user's session id, refuses browser origins", async () => {
  const hosted = await hostedRig();
  try {
    assert.equal((await hosted.host("", "GET", "/api/sync/sessions")).status, 401);
    assert.equal((await hosted.host("mind_" + "0".repeat(32), "GET", "/api/sync/sessions")).status, 401);
    const w = { v: 1, id: "shared-id", surface: "desktop", title: "a", createdAt: 1, updatedAt: 5, state: { messages: [], receiptCounter: 0, totalCostUsd: 0, userMessageIndex: 0 }, violations: [], history: [{ type: "user", text: "alice's", id: "u1" }] };
    const a = await hosted.host(hosted.keys.alice, "POST", "/api/sync/sessions", { records: [w] });
    assert.deepEqual(JSON.parse(a.body).results.map((r: any) => r.status), ["ok"]);
    const b = await hosted.host(hosted.keys.bob, "POST", "/api/sync/sessions", { records: [{ ...w, history: [{ type: "user", text: "bob's", id: "u9" }] }] });
    assert.deepEqual(JSON.parse(b.body).results.map((r: any) => r.status), ["forbidden"]);
    assert.equal((hosted.store.load("shared-id")!.history[0] as any).text, "alice's");
    const o = await import("../gateway/helpers.ts").then((m) => m.http(hosted.gw.url, "GET", "/api/sync/sessions", { headers: { ...H, "x-mind-key": hosted.keys.alice, origin: "https://evil.example" } }));
    assert.equal(o.status, 403);
    const bad = await hosted.host(hosted.keys.alice, "POST", "/api/sync/sessions", { records: [{ junk: 1 }] });
    assert.deepEqual(JSON.parse(bad.body).results.map((r: any) => r.status), ["invalid"]);
  } finally { await hosted.close(); }
});

test("a bot thread syncs and maps to the bot's own id on each side (the same MIND bot has different local ids)", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const bot = JSON.parse((await desk.api("POST", "/bots", { slug: "scout", name: "Scout" })).body).bot;
    const { sessionId } = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop", bot: bot.id })).body);
    await desk.api("POST", `/sessions/${sessionId}/send`, { text: "scout, look around" });
    await until(() => hosted.store.load(sessionId));
    const h = hosted.store.load(sessionId)!;
    assert.ok(h.bot, "the hosted copy is a bot thread");
    assert.notEqual(h.bot, bot.id, "the hosted side has its own id for the same bot");
    assert.equal(h.owner?.startsWith("u_"), true);
  } finally { await desk.close(); await hosted.close(); }
});
