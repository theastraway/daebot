import { test } from "node:test";
import assert from "node:assert/strict";
import { DiscordAdapter, DISCORD_INTENTS } from "../../src/channels/discord.ts";
import { fakeGateway, jsonRes, until } from "./helpers.ts";

const TOKEN = "discord-SECRET-token-xyz";

// Minimal fake of the WebSocket surface the adapter uses; the test plays the Discord gateway.
class FakeWS {
  static all: FakeWS[] = [];
  url: string;
  sent: any[] = [];
  closedWith?: number;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number }) => void;
  onerror?: () => void;
  constructor(url: string) { this.url = url; FakeWS.all.push(this); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close(code = 1000) { if (this.closedWith === undefined) { this.closedWith = code; queueMicrotask(() => this.onclose?.({ code })); } }
  server(frame: any) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  serverClose(code: number) { this.closedWith = code; this.onclose?.({ code }); }
}
const last = () => FakeWS.all[FakeWS.all.length - 1]!;
const ops = (ws: FakeWS, op: number) => ws.sent.filter((f) => f.op === op);
const WS = FakeWS as unknown as typeof WebSocket;
const hello = (ws: FakeWS, interval = 15) => ws.server({ op: 10, d: { heartbeat_interval: interval } });
const ready = (ws: FakeWS) => ws.server({ op: 0, t: "READY", s: 1, d: { session_id: "sess-1", resume_gateway_url: "wss://resume.example", user: { id: "BOT" } } });

async function boot(extra: Partial<ConstructorParameters<typeof DiscordAdapter>[0]> = {}, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, gw = fakeGateway()) {
  FakeWS.all = [];
  const calls: { url: string; init: any }[] = [];
  const f = fetchImpl ?? ((async (url: string, init: any) => { calls.push({ url, init }); return jsonRes({ id: "m1" }); }) as unknown as typeof fetch);
  const sleeps: number[] = [];
  const a = new DiscordAdapter({ token: TOKEN, gatewayUrl: "wss://gw.example", ...extra },
    { fetch: f, WebSocket: WS, sleep: sleep ?? (async (ms) => { sleeps.push(ms); }) });
  const started = a.start(gw);
  await until(() => FakeWS.all.length === 1, 1000, "socket");
  const ws = last();
  hello(ws);
  await until(() => ops(ws, 2).length === 1, 1000, "identify");
  ready(ws);
  await started;
  return { a, ws, gw, calls, sleeps };
}

test("identify -> ready -> heartbeats carry the last sequence", async () => {
  const { a, ws } = await boot();
  const id = ops(ws, 2)[0]!.d;
  assert.equal(id.token, TOKEN);
  assert.equal(id.intents, DISCORD_INTENTS);
  assert.match(ws.url, /^wss:\/\/gw\.example\/\?v=10&encoding=json$/);
  ws.server({ op: 0, t: "TYPING_START", s: 5, d: {} });
  await until(() => ops(ws, 1).length >= 1, 1000, "heartbeat");
  assert.equal(ops(ws, 1).at(-1)!.d, 5);
  ws.server({ op: 11 });
  await until(() => ops(ws, 1).length >= 2, 1000, "second heartbeat after ack");
  await a.stop();
});

test("server close -> reconnect on resume url -> RESUME with session id and seq", async () => {
  const { a, ws, sleeps } = await boot();
  ws.server({ op: 0, t: "TYPING_START", s: 9, d: {} });
  ws.serverClose(1006);
  await until(() => FakeWS.all.length === 2, 1000, "reconnect");
  const ws2 = last();
  assert.match(ws2.url, /^wss:\/\/resume\.example\/\?v=10/);
  assert.deepEqual(sleeps, [1000]);
  hello(ws2);
  await until(() => ops(ws2, 6).length === 1, 1000, "resume frame");
  assert.deepEqual(ops(ws2, 6)[0]!.d, { token: TOKEN, session_id: "sess-1", seq: 9 });
  assert.equal(ops(ws2, 2).length, 0, "no fresh identify when resuming");
  await a.stop();
});

test("missed heartbeat ack triggers reconnect", async () => {
  const { a, ws } = await boot();
  // never ack: first beat sets acked=false, second beat finds it unacked and drops the socket
  await until(() => FakeWS.all.length === 2, 1000, "zombie reconnect");
  assert.equal(ws.closedWith, 4000);
  await a.stop();
});

test("op 7 reconnect and op 9 invalid session (non-resumable) re-identifies", async () => {
  const { a, ws, sleeps } = await boot();
  ws.server({ op: 7 });
  await until(() => FakeWS.all.length === 2);
  const ws2 = last();
  hello(ws2, 1000);
  await until(() => ops(ws2, 6).length === 1);
  ws2.server({ op: 9, d: false });
  await until(() => ops(ws2, 2).length === 1, 1000, "re-identify");
  assert.ok(sleeps.some((s) => s >= 1000 && s <= 5000), "waits 1-5s before re-identify");
  await a.stop();
});

test("fatal close code (4004) rejects start and does not reconnect", async () => {
  FakeWS.all = [];
  const a = new DiscordAdapter({ token: TOKEN, gatewayUrl: "wss://gw.example" }, { fetch: (async () => jsonRes({})) as any, WebSocket: WS, sleep: async () => {} });
  const p = a.start(fakeGateway());
  await until(() => FakeWS.all.length === 1);
  hello(last());
  last().serverClose(4004);
  await assert.rejects(p, (e: Error) => { assert.ok(!e.message.includes("SECRET")); return /4004/.test(e.message); });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(FakeWS.all.length, 1);
});

test("DMs answered; guild messages only when mentioned; bots ignored; mention stripped", async () => {
  const { a, ws, gw, calls } = await boot();
  const mc = (d: any) => ws.server({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "1", channel_id: "C1", author: { id: "U1", username: "ann" }, content: "x", ...d } });
  mc({ content: "dm hello" });                                                   // DM -> answered
  mc({ guild_id: "G", content: "no mention" });                                  // ignored
  mc({ guild_id: "G", content: "<@BOT> do the thing", mentions: [{ id: "BOT" }] }); // answered, mention stripped
  mc({ guild_id: "G", content: "<@!BOT> reply", referenced_message: null, mentions: [{ id: "BOT" }], channel_id: "C2" });
  mc({ author: { id: "B2", bot: true }, content: "bot talk" });                  // ignored
  mc({ guild_id: "G", content: "followup", referenced_message: { author: { id: "BOT" } }, channel_id: "C3" });
  await until(() => calls.filter((c) => c.url.endsWith("/messages")).length >= 4, 2000, "4 replies");
  const all = gw.sessions.flatMap((s) => s.sent).sort();
  assert.deepEqual(all, ["dm hello", "do the thing", "followup", "reply"]);
  const post = calls.find((c) => c.url.endsWith("/channels/C1/messages"))!;
  assert.equal(post.init.method, "POST");
  assert.equal(post.init.headers.authorization, `Bot ${TOKEN}`);
  const body = JSON.parse(post.init.body);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.ok(calls.some((c) => c.url.endsWith("/channels/C1/typing")));
  await a.stop();
});

test("REST 429 honors retry_after then succeeds; long replies chunk at 2000", async () => {
  let n = 0;
  const posts: string[] = [];
  const f = (async (url: string, init: any) => {
    if (String(url).endsWith("/messages")) {
      if (n++ === 0) return jsonRes({ message: "rate limited", retry_after: 1.5, global: false }, 429);
      posts.push(JSON.parse(init.body).content);
    }
    return jsonRes({ id: "x" });
  }) as unknown as typeof fetch;
  const gw = fakeGateway(() => [{ type: "text", delta: "word ".repeat(900) }, { type: "done", finalText: "" }]);
  const { a, ws, sleeps } = await boot({ tiers: {} }, f, undefined, gw);
  ws.server({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "1", channel_id: "C1", author: { id: "U1" }, content: "go" } });
  await until(() => posts.length >= 3, 2000, "chunked posts");
  assert.ok(sleeps.includes(1500), `slept retry_after: ${sleeps}`);
  assert.ok(posts.every((p) => p.length <= 2000));
  await a.stop();
});
