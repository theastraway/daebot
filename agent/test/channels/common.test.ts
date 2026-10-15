import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ConversationHub, chunkText, createChannelsForTest, formatForChannel, loadChannelsConfig, markdownToPlain,
  markdownToTelegramHtml, RATE_NOTICE, renderConfirm,
} from "./common-exports.ts";
import { fakeGateway, textTurn } from "./helpers.ts";
import type { AgentEvent } from "../../src/types.ts";

test("chunkText respects limits and re-fences code blocks", () => {
  const code = "```js\n" + "const a = 1;\n".repeat(400) + "```";
  const parts = chunkText(code, 500);
  assert.ok(parts.length > 5);
  for (const p of parts) {
    assert.ok(p.length <= 500, `chunk ${p.length}`);
    assert.equal((p.match(/^```/gm) ?? []).length % 2, 0, "balanced fences per chunk");
  }
  assert.deepEqual(chunkText("short", 100), ["short"]);
  assert.deepEqual(chunkText("", 100), []);
  const prose = chunkText("word ".repeat(1000), 100);
  assert.ok(prose.every((p) => p.length <= 100));
  assert.equal(prose.join(" ").replace(/\s+/g, " ").trim(), ("word ".repeat(1000)).trim());
});

test("formatForChannel chunks at each channel limit", () => {
  const long = "lorem ipsum dolor ".repeat(1000);
  for (const [kind, lim] of [["telegram", 4096], ["discord", 2000], ["imessage", 1000]] as const) {
    const parts = formatForChannel(kind, long);
    assert.ok(parts.length > 1, kind);
    assert.ok(parts.every((p) => p.length <= lim), `${kind} within ${lim}`);
  }
  assert.deepEqual(formatForChannel("plain", "x".repeat(9000)).length, 1);
  assert.deepEqual(formatForChannel("telegram", "   "), []);
});

test("telegram html conversion escapes and supports the safe subset", () => {
  const html = markdownToTelegramHtml("# Title\n**bold** and *it* and `a<b` and [x](https://e.com/?a=1&b=2)\n```py\nif a < b:\n  pass\n```\n- item");
  assert.match(html, /<b>Title<\/b>/);
  assert.match(html, /<b>bold<\/b> and <i>it<\/i>/);
  assert.match(html, /<code>a&lt;b<\/code>/);
  assert.match(html, /<a href="https:\/\/e\.com\/\?a=1&amp;b=2">x<\/a>/);
  assert.match(html, /<pre>if a &lt; b:\n {2}pass<\/pre>/);
  assert.match(html, /\u2022 item/);
  assert.equal(markdownToTelegramHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("imessage plain conversion strips markdown", () => {
  const plain = markdownToPlain("## Hi\n**bold** _it_ `code` [site](https://a.b)\n```\nblock\n```");
  assert.equal(plain, "Hi\nbold it code site (https://a.b)\nblock");
});

test("hub maps conversations to sessions and reuses them", async () => {
  const gw = fakeGateway();
  const hub = new ConversationHub({ surface: "telegram", gateway: gw, policy: {} });
  const out: string[] = [];
  const reply = async (m: string) => { out.push(m); };
  await hub.handle({ conversationId: "a", senderId: "u1", text: "one" }, reply);
  await hub.handle({ conversationId: "a", senderId: "u1", text: "two" }, reply);
  await hub.handle({ conversationId: "b", senderId: "u1", text: "three" }, reply);
  assert.equal(gw.opened.length, 2);
  assert.deepEqual(gw.sessions[0]!.sent, ["one", "two"]);
  assert.deepEqual(out, ["echo: one", "echo: two", "echo: three"]);
  assert.equal(gw.opened[0]!.surface, "telegram");
});

test("hub serializes turns per conversation", async () => {
  const gw = fakeGateway((t) => textTurn(`r:${t}`), 5);
  const hub = new ConversationHub({ surface: "discord", gateway: gw, policy: { defaultTier: "admin" } });
  const out: string[] = [];
  const reply = async (m: string) => { out.push(m); };
  await Promise.all(["1", "2", "3", "4"].map((t) => hub.handle({ conversationId: "c", senderId: "u", text: t }, reply)));
  assert.equal(gw.opened.length, 1, "one session despite concurrent first messages");
  assert.equal(gw.sessions[0]!.maxConcurrent, 1);
  assert.deepEqual(out, ["r:1", "r:2", "r:3", "r:4"]);
});

test("tier policy: admin unrestricted, staff/public get identity, unknown is public", async () => {
  const gw = fakeGateway();
  const hub = new ConversationHub({ surface: "telegram", gateway: gw, policy: { tiers: { boss: "admin", aide: "staff" } } });
  const reply = async () => {};
  await hub.handle({ conversationId: "g", senderId: "boss", text: "hi" }, reply);
  await hub.handle({ conversationId: "g", senderId: "aide", text: "hi" }, reply);
  await hub.handle({ conversationId: "g", senderId: "rando", text: "hi" }, reply);
  await hub.handle({ conversationId: "g", senderId: "rando2", text: "hi" }, reply);
  assert.equal(gw.opened.length, 3, "one session per (conversation, tier); two public senders share the restricted one");
  assert.equal(gw.opened[0]!.opts, undefined);
  assert.deepEqual(gw.opened[1]!.opts, { identity: "staff" });
  assert.deepEqual(gw.opened[2]!.opts, { identity: "public" });
  assert.equal(hub.tierOf("nobody"), "public");
});

test("rate limit: public 10/min with a single notice, admin unlimited, window slides", async () => {
  let now = 1_000_000;
  const gw = fakeGateway();
  const hub = new ConversationHub({ surface: "telegram", gateway: gw, policy: { tiers: { boss: "admin" } }, now: () => now });
  const out: string[] = [];
  const reply = async (m: string) => { out.push(m); };
  for (let i = 0; i < 15; i++) await hub.handle({ conversationId: "p", senderId: "stranger", text: `m${i}` }, reply);
  assert.equal(gw.sessions[0]!.sent.length, 10);
  assert.equal(out.filter((m) => m === RATE_NOTICE).length, 1);
  for (let i = 0; i < 30; i++) await hub.handle({ conversationId: "a", senderId: "boss", text: `m${i}` }, reply);
  assert.equal(gw.sessions[1]!.sent.length, 30);
  now += 61_000;
  await hub.handle({ conversationId: "p", senderId: "stranger", text: "again" }, reply);
  assert.equal(gw.sessions[0]!.sent.length, 11);
});

test("confirm events render as a plain-text approval question", async () => {
  const ev: AgentEvent[] = [
    { type: "text", delta: "Drafting." },
    { type: "confirm", id: "k1", tool: "send_email", args: { to: "a@b.co" }, reason: "This emails a real person." },
    { type: "done", finalText: "Drafting." },
  ];
  const gw = fakeGateway(() => ev);
  const hub = new ConversationHub({ surface: "imessage", gateway: gw, policy: { defaultTier: "admin" } });
  const out: string[] = [];
  await hub.handle({ conversationId: "c", senderId: "u", text: "mail him" }, async (m) => { out.push(m); });
  assert.equal(out[0], "Drafting.");
  assert.match(out[1]!, /send_email with \{"to":"a@b\.co"\}/);
  assert.match(out[1]!, /This emails a real person\./);
  assert.match(out[1]!, /reply 'send it' to approve/i);
  assert.equal(renderConfirm({ type: "confirm", id: "x", tool: "t", args: {}, reason: "r" }).includes("with {}"), false);
});

test("only enforced gate events produce a status line", async () => {
  const v = { gate: "receipt", action: "block" as const, reason: "Query MIND first." };
  const gw = fakeGateway(() => [
    { type: "gate", verdict: v, enforced: false },
    { type: "gate", verdict: v, enforced: true },
    { type: "toolStart", receiptId: "c1", tool: "x", args: {} },
    { type: "done", finalText: "ok" },
  ]);
  const hub = new ConversationHub({ surface: "telegram", gateway: gw, policy: { defaultTier: "admin" } });
  const out: string[] = [];
  await hub.handle({ conversationId: "c", senderId: "u", text: "go" }, async (m) => { out.push(m); });
  assert.deepEqual(out, ["[gate receipt] Query MIND first.", "ok"]);
});

test("long output flushes in pieces near 1500 chars", async () => {
  const para = "x".repeat(700);
  const gw = fakeGateway(() => textTurn(para + "\n\n", para + "\n\n", para + "\n\n", para));
  const hub = new ConversationHub({ surface: "discord", gateway: gw, policy: { defaultTier: "admin" } });
  const out: string[] = [];
  await hub.handle({ conversationId: "c", senderId: "u", text: "go" }, async (m) => { out.push(m); });
  assert.ok(out.length >= 2 && out.length <= 3, `got ${out.length}`);
  assert.ok(out.every((m) => m.length <= 1500));
  assert.equal(out.join("").replace(/\s/g, "").length, 2800);
});

test("idle sessions close after 24h and reopen on next message", async () => {
  let now = 0;
  const gw = fakeGateway();
  const hub = new ConversationHub({ surface: "telegram", gateway: gw, policy: {}, now: () => now });
  const reply = async () => {};
  await hub.handle({ conversationId: "c", senderId: "u", text: "a" }, reply);
  now = 23 * 3600_000;
  assert.equal(await hub.sweep(), 0);
  now = 25 * 3600_000;
  assert.equal(await hub.sweep(), 1);
  assert.deepEqual(gw.closed, ["s0"]);
  await hub.handle({ conversationId: "c", senderId: "u", text: "b" }, reply);
  assert.equal(gw.opened.length, 2);
});

test("a throwing session yields an error notice and a fresh session next time", async () => {
  let n = 0;
  const gw = fakeGateway();
  const orig = gw.open.bind(gw);
  gw.open = async (...a) => { const s = await orig(...a); if (n++ === 0) (s as any).send = () => { throw new Error("boom"); }; return s; };
  const hub = new ConversationHub({ surface: "telegram", gateway: gw, policy: {} });
  const out: string[] = [];
  const reply = async (m: string) => { out.push(m); };
  await hub.handle({ conversationId: "c", senderId: "u", text: "a" }, reply);
  assert.match(out[0]!, /went wrong/);
  await hub.handle({ conversationId: "c", senderId: "u", text: "b" }, reply);
  assert.equal(out[1], "echo: b");
});

test("loadChannelsConfig reads env and createChannels returns only configured adapters", () => {
  const env = { TELEGRAM_BOT_TOKEN: "tg-token-123", TELEGRAM_ADMIN_IDS: "1,2", TELEGRAM_ALLOWED_CHAT_IDS: "10 20",
    SENDBLUE_API_KEY: "k", SENDBLUE_API_SECRET: "s", SENDBLUE_FROM_NUMBER: "+15550001111", MINDCLAW_CHANNELS_FILE: "/nonexistent.json" };
  const cfg = loadChannelsConfig(env as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.telegram?.tiers, { "1": "admin", "2": "admin" });
  assert.deepEqual(cfg.telegram?.allowedChatIds, ["10", "20"]);
  assert.equal(cfg.discord, undefined);
  assert.deepEqual(createChannelsForTest(cfg).map((a) => a.name), ["telegram", "imessage"]);
  assert.deepEqual(createChannelsForTest({}).length, 0);
});
