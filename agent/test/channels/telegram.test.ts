import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramAdapter } from "../../src/channels/telegram.ts";
import { fakeGateway, jsonRes, until } from "./helpers.ts";

const TOKEN = "123456:SECRET-TOKEN-abcdef";

interface Call { method: string; body: any }
function fakeTelegram(opts: { failPolls?: Array<Response | Error> } = {}) {
  const calls: Call[] = [];
  const queue: any[][] = [];
  const failPolls = [...(opts.failPolls ?? [])];
  let wake: (() => void) | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    assert.ok(String(url).includes(`/bot${TOKEN}/`));
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    if (method === "getMe") return jsonRes({ ok: true, result: { id: 999, is_bot: true, username: "MindBot" } });
    if (method === "getUpdates") {
      const f = failPolls.shift();
      if (f instanceof Error) throw f;
      if (f) return f;
      if (queue.length) return jsonRes({ ok: true, result: queue.shift() });
      await new Promise<void>((res, rej) => {
        wake = res;
        init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      });
      return jsonRes({ ok: true, result: queue.length ? queue.shift() : [] });
    }
    return jsonRes({ ok: true, result: { message_id: 1 } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, push(u: any[]) { queue.push(u); wake?.(); } };
}
const msg = (id: number, over: any = {}) => ({
  update_id: id,
  message: { message_id: id, from: { id: 42, username: "ann" }, chat: { id: 42, type: "private" }, text: "hello", ...over },
});
const sends = (calls: Call[]) => calls.filter((c) => c.method === "sendMessage");

test("private message: session opened, HTML reply sent, offset advances", async () => {
  const tg = fakeTelegram();
  const gw = fakeGateway((t) => [{ type: "text", delta: `**hi** ${t}` }, { type: "done", finalText: "" }]);
  const logs: string[] = [];
  const a = new TelegramAdapter({ token: TOKEN, tiers: { "42": "admin" } }, { fetch: tg.fetchImpl, sleep: async () => {}, log: (m) => logs.push(m) });
  await a.start(gw);
  tg.push([msg(100), msg(101, { text: "again" })]);
  await until(() => sends(tg.calls).length >= 2, 2000, "two replies");
  assert.equal(gw.opened.length, 1);
  assert.equal(gw.opened[0]!.surface, "telegram");
  assert.equal(gw.opened[0]!.opts, undefined, "admin: no identity restriction");
  const first = sends(tg.calls)[0]!.body;
  assert.equal(first.chat_id, 42);
  assert.equal(first.parse_mode, "HTML");
  assert.equal(first.text, "<b>hi</b> hello");
  assert.ok(tg.calls.some((c) => c.method === "sendChatAction" && c.body.action === "typing"));
  tg.push([]);
  await until(() => tg.calls.filter((c) => c.method === "getUpdates").length >= 3, 2000, "next poll");
  const polls = tg.calls.filter((c) => c.method === "getUpdates");
  assert.equal(polls[0]!.body.offset, 0);
  assert.equal(polls[0]!.body.timeout, 30);
  assert.equal(polls[1]!.body.offset, 102, "offset = last update_id + 1");
  await a.stop();
  assert.ok(logs.every((l) => !l.includes("SECRET-TOKEN")), "token never logged");
  assert.deepEqual(gw.closed, ["s0"]);
});

test("unknown sender is public tier with identity restriction", async () => {
  const tg = fakeTelegram();
  const gw = fakeGateway();
  const a = new TelegramAdapter({ token: TOKEN }, { fetch: tg.fetchImpl, sleep: async () => {} });
  await a.start(gw);
  tg.push([msg(1)]);
  await until(() => sends(tg.calls).length === 1);
  assert.deepEqual(gw.opened[0]!.opts, { identity: "public" });
  await a.stop();
});

test("groups: only mentions or replies to the bot are answered; mention is stripped", async () => {
  const tg = fakeTelegram();
  const gw = fakeGateway();
  const a = new TelegramAdapter({ token: TOKEN }, { fetch: tg.fetchImpl, sleep: async () => {} });
  await a.start(gw);
  const grp = { chat: { id: -7, type: "supergroup" } };
  tg.push([
    msg(1, { ...grp, text: "just chatting" }),
    msg(2, { ...grp, text: "@MindBot what time is it", entities: [{ type: "mention", offset: 0, length: 8 }] }),
    msg(3, { ...grp, text: "@someoneelse hi", entities: [{ type: "mention", offset: 0, length: 12 }] }),
    msg(4, { ...grp, text: "following up", reply_to_message: { from: { id: 999 } } }),
    msg(5, { ...grp, text: "reply to a human", reply_to_message: { from: { id: 5 } } }),
  ]);
  await until(() => sends(tg.calls).length >= 2, 2000, "2 replies");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(gw.sessions[0]!.sent, ["what time is it", "following up"]);
  await a.stop();
});

test("allowlist silently ignores other chats", async () => {
  const tg = fakeTelegram();
  const gw = fakeGateway();
  const a = new TelegramAdapter({ token: TOKEN, allowedChatIds: [42] }, { fetch: tg.fetchImpl, sleep: async () => {} });
  await a.start(gw);
  tg.push([msg(1, { chat: { id: 77, type: "private" }, from: { id: 77 } }), msg(2)]);
  await until(() => sends(tg.calls).length === 1);
  assert.deepEqual(gw.sessions[0]!.sent, ["hello"]);
  assert.equal(gw.opened.length, 1);
  await a.stop();
});

test("poll errors back off exponentially, honor retry_after, then recover", async () => {
  const tg = fakeTelegram({ failPolls: [
    new Error(`network down for bot ${TOKEN}`),
    new Error("again"),
    jsonRes({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } }, 429),
  ] });
  const sleeps: number[] = [];
  const logs: string[] = [];
  const gw = fakeGateway();
  const a = new TelegramAdapter({ token: TOKEN }, { fetch: tg.fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, log: (m) => logs.push(m) });
  await a.start(gw);
  await until(() => sleeps.length >= 3, 2000, "3 backoffs");
  assert.deepEqual(sleeps.slice(0, 3), [1000, 2000, 7000]);
  assert.ok(logs.every((l) => !l.includes("SECRET-TOKEN")), "token scrubbed from error logs");
  tg.push([msg(5)]);
  await until(() => sends(tg.calls).length === 1, 2000, "recovered reply");
  await a.stop();
});

test("HTML parse failure falls back to plain text", async () => {
  const tg = fakeTelegram();
  let first = true;
  const inner = tg.fetchImpl;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/sendMessage") && first) { first = false; tg.calls.push({ method: "sendMessage", body: JSON.parse(String(init.body)) });
      return jsonRes({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, 400); }
    return inner(url, init);
  }) as unknown as typeof fetch;
  const gw = fakeGateway(() => [{ type: "text", delta: "**bold** <b>" }, { type: "done", finalText: "" }]);
  const a = new TelegramAdapter({ token: TOKEN }, { fetch: fetchImpl, sleep: async () => {} });
  await a.start(gw);
  tg.push([msg(1)]);
  await until(() => sends(tg.calls).length === 2);
  assert.equal(sends(tg.calls)[1]!.body.parse_mode, undefined);
  assert.equal(sends(tg.calls)[1]!.body.text, "bold <b>");
  await a.stop();
});
