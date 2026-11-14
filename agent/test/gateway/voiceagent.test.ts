import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createVoiceAgent, checkToolToken, toolToken, sessionBody, agentPrompt, TOOL_PATH } from "../../src/gateway/voiceagent.ts";
import type { AgentBot, ToolBackend, VoiceAgentOptions } from "../../src/gateway/voiceagent.ts";
import { createStartVoiceAgentTool } from "../../src/bots/voicechat-tool.ts";
import { hostedToolAllowed } from "../../src/hosted.ts";

const SECRET = "s".repeat(32);
const ME: any = { id: "u_alice", username: "alice", owner: false, tier: "staff" };
const BOT: AgentBot = { id: "b_1", slug: "sam", name: "Sam", purpose: "Chief of staff", instructions: "# Role\nBe brief.", voice: { voiceId: "MiueK1FXuZTCItgbQwPu", speed: 1.1, agentLlm: "claude-haiku-4-5", agentFirstMessage: "Yo", agentPrompt: "Sound relaxed.", language: "es" } };

const WSS = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&conversation_signature=x";
const NO_LIVE = "No live call chat. Start voice chat from a chat first.";

function rig(over: Partial<Omit<VoiceAgentOptions, "tools">> & { tools?: Partial<ToolBackend> } = {}, mind: (url: string, init: any) => { status: number; body: any } = () => ({ status: 200, body: {} })) {
  const calls: { url: string; init: any }[] = [];
  const posted: any[] = [];
  const said: { id: string; text: string }[] = [];
  const saved: any[] = [];
  const savedChat: (string | undefined)[] = [];
  const { tools: toolOver, ...rest } = over;
  const f = (async (url: string, init: any) => { calls.push({ url, init }); const r = mind(url, init); return new Response(JSON.stringify(r.body), { status: r.status }); }) as unknown as typeof fetch;
  const opts: VoiceAgentOptions = {
    baseUrl: "http://m/developer/v1", keyFor: (p) => (p.id === "u_alice" ? "alicekey" : undefined), secret: SECRET, publicBase: () => "https://daebot.live",
    botOf: (p, slug) => (p.id === "u_alice" && slug === "sam" ? BOT : undefined),
    saveTranscript: async (_p, _b, lines, chatId?) => { saved.push(lines); savedChat.push(chatId); return chatId || "sess_1"; },
    principalOf: (o) => (o === "u_alice" ? ME : undefined), fetchImpl: f, now: () => Date.now(),
    tools: {
      list: (o) => (o === "u_alice" ? [{ id: "s1", title: "Pricing chat", updatedAt: 2000 }, { id: "s2", title: "Hiring", updatedAt: 3000, bot: "b_1" }] : [{ id: "x9", title: "Bob secret", updatedAt: 1 }]),
      read: (o, id) => (o === "u_alice" && (id === "s1" || id === "s_opened") ? [{ role: "user", text: "What is our price?" }, { role: "assistant", text: "We charge $99 a month." }] : undefined),
      post: async (o, id, text) => { if (o !== "u_alice" || id !== "s1") return "missing"; posted.push(text); return "sent"; },
      say: async (o, id, text) => { if (o !== "u_alice") return "missing"; said.push({ id, text }); return "sent"; },
      ...toolOver,
    },
    ...rest,
  };
  const h = createVoiceAgent(opts);
  const call = (kind: "handle" | "tool", path: string, method: string, body?: unknown, headers: Record<string, string> = {}, p = ME) => {
    const buf = Buffer.from(JSON.stringify(body ?? {}));
    const req: any = Object.assign(Readable.from([buf]), { method, headers: { "content-type": "application/json", ...headers } });
    const out: { status: number; body: any } = { status: 0, body: undefined };
    const res: any = { headersSent: false, writeHead(s: number) { out.status = s; }, end(d?: string) { if (d) out.body = JSON.parse(d); } };
    return (kind === "handle" ? h.handle(req, res, path, p) : h.tool(req, res, path)).then(() => out);
  };
  return { call, calls, posted, said, saved, savedChat };
}
const bearer = (owner = "u_alice", slug = "sam") => ({ authorization: `Bearer ${toolToken(SECRET, owner, slug)}` });

test("tool tokens are bound to owner and bot and cannot be forged", () => {
  const t = toolToken(SECRET, "u_alice", "sam");
  assert.deepEqual(checkToolToken(SECRET, t), { owner: "u_alice", slug: "sam" });
  assert.equal(checkToolToken("other-secret-other-secret-other!!", t), undefined);
  assert.equal(checkToolToken(SECRET, t.replace("sam", "bob")), undefined);
  assert.equal(checkToolToken(SECRET, t.slice(0, -3)), undefined);
  assert.equal(checkToolToken(SECRET, "v1.x.y.z"), undefined);
  assert.notEqual(toolToken(SECRET, "u_alice", "sam"), toolToken(SECRET, "u_bob", "sam"));
});

test("session body carries the bot's voice, llm, first message, prompt and its own tools", () => {
  const b: any = sessionBody(SECRET, BOT, "u_alice", "https://daebot.live", "Plan the launch.");
  assert.equal(b.bot, "sam"); assert.equal(b.llm, "claude-haiku-4-5"); assert.equal(b.first_message, "Yo"); assert.equal(b.language, "es");
  assert.deepEqual(b.voice, { voice_id: "MiueK1FXuZTCItgbQwPu", speed: 1.1 });
  assert.equal(b.tools_base_url, "https://daebot.live/voice-agent/tools");
  assert.equal(b.tools.length, 7);
  assert.deepEqual(b.tools.map((t: any) => t.name), ["list_sessions", "read_session", "search_chats", "post_to_session", "chat_read", "chat_post", "chat_post_link"]);
  assert.match(b.tools.find((t: any) => t.name === "chat_post_link").description, /https only/);
  assert.doesNotMatch(b.tools.find((t: any) => t.name === "chat_post_link").description, /http or https/);
  assert.match(b.tools.find((t: any) => t.name === "chat_post_link").properties.url.description, /https URL/);
  const open: any = sessionBody(SECRET, BOT, "u_alice", "https://daebot.live", undefined, true);
  assert.match(open.tools.find((t: any) => t.name === "chat_post_link").description, /http or https only/);
  assert.match(open.prompt, /http or https/);
  assert.match(b.prompt, /https only/);
  assert.ok(b.tools.every((t: any) => Object.keys(t.properties).length <= 8));
  assert.match(b.prompt, /You are Sam, Chief of staff/); assert.match(b.prompt, /Be brief\./); assert.match(b.prompt, /Sound relaxed\./); assert.match(b.prompt, /Plan the launch\./);
  assert.match(b.prompt, /no reading out links/); assert.match(b.prompt, /chat_read/); assert.match(b.prompt, /chat_post_link/); assert.match(b.prompt, /I put it in the chat/);
  assert.equal(checkToolToken(SECRET, b.tools_token)?.owner, "u_alice");
  assert.match(agentPrompt({ ...BOT, voice: undefined }, undefined), /list_sessions/);
});

test("/voice/agent/session asks MIND with the user's own key and the bot slug, returns only the signed URL", async () => {
  const r = rig({}, () => ({ status: 200, body: { signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&conversation_signature=x", session: "s", max_seconds: 900, first_message: "Yo", agent_id: "a" } }));
  const out = await r.call("handle", "/voice/agent/session", "POST", { bot: "sam", prompt: "Plan it." });
  assert.equal(out.status, 200);
  assert.deepEqual(Object.keys(out.body).sort(), ["botName", "firstMessage", "maxSeconds", "session", "signedUrl"]);
  assert.equal(r.calls[0].url, "http://m/developer/v1/audio/agent/session");
  assert.equal(r.calls[0].init.headers["X-API-Key"], "alicekey"); assert.equal(r.calls[0].init.headers["X-Daebot-Bot"], "sam");
  assert.equal((await r.call("handle", "/voice/agent/session", "POST", { bot: "nobody" })).status, 404);
});

test("a signed URL that is not ElevenLabs is refused; MIND refusals (cap, credits, key) map cleanly", async () => {
  assert.equal((await rig({}, () => ({ status: 200, body: { signed_url: "wss://evil.example/x" } })).call("handle", "/voice/agent/session", "POST", { bot: "sam" })).status, 502);
  const cap = await rig({}, () => ({ status: 402, body: { error: "spend_cap_reached", scope: "bot", message: "This bot reached its $1 daily cap." } })).call("handle", "/voice/agent/session", "POST", { bot: "sam" });
  assert.equal(cap.status, 402); assert.equal(cap.body.error, "spend_cap_reached"); assert.equal(cap.body.scope, "bot");
  assert.equal((await rig({}, () => ({ status: 401, body: {} })).call("handle", "/voice/agent/session", "POST", { bot: "sam" })).status, 401);
  assert.equal((await rig().call("handle", "/voice/agent/session", "POST", { bot: "sam" }, {}, { ...ME, id: "u_nokey" })).status, 503);
});

test("finish saves the merged transcript into the bot's thread and reports cost", async () => {
  const r = rig({}, () => ({ status: 200, body: { seconds: 42, credits_used: 1.5, transcript: [{ role: "agent", text: "Hi" }, { role: "agent", text: "Ready?" }, { role: "user", text: "Yes" }] } }));
  const out = await r.call("handle", "/voice/agent/finish", "POST", { bot: "sam", conversationId: "conv_abc123" });
  assert.equal(out.status, 200); assert.equal(out.body.sessionId, "sess_1"); assert.equal(out.body.lines, 2);
  assert.deepEqual(r.saved[0], [{ role: "agent", text: "Hi\n\nReady?" }, { role: "user", text: "Yes" }]);
  assert.deepEqual(JSON.parse(r.calls[0].init.body), { bot: "sam", conversation_id: "conv_abc123" });
  assert.equal((await rig({}, () => ({ status: 202, body: {} })).call("handle", "/voice/agent/finish", "POST", { bot: "sam" })).status, 202);
});

test("server tools: need the bearer token, are scoped to its owner, and read/search/post work", async () => {
  const r = rig();
  const P = TOOL_PATH;
  assert.equal((await r.call("tool", `${P}list_sessions`, "POST", {}, {})).status, 401);
  assert.equal((await r.call("tool", `${P}list_sessions`, "POST", {}, { authorization: "Bearer v1.forged.sam.aaaaaaaaaaaaaaaaaaaaaa" })).status, 401);
  const l = await r.call("tool", `${P}list_sessions`, "POST", {}, bearer());
  assert.deepEqual(l.body.sessions.map((s: any) => s.session_id), ["s2", "s1"], "newest first, only this owner's");
  const rd = await r.call("tool", `${P}read_session`, "POST", { session_id: "s1" }, bearer());
  assert.match(rd.body.transcript, /User: What is our price\?\nAssistant: We charge \$99 a month\./);
  assert.match((await r.call("tool", `${P}read_session`, "POST", { session_id: "x9" }, bearer())).body.error, /No such chat/, "another owner's chat is not found");
  const s = await r.call("tool", `${P}search_chats`, "POST", { query: "price" }, bearer());
  assert.equal(s.body.matches.length, 1); assert.equal(s.body.matches[0].session_id, "s1"); assert.match(s.body.matches[0].snippet, /price/);
  assert.equal((await r.call("tool", `${P}post_to_session`, "POST", { session_id: "s1", text: "ship it" }, bearer())).body.ok, true);
  assert.deepEqual(r.posted, ["ship it"]);
  assert.equal((await r.call("tool", `${P}post_to_session`, "POST", { session_id: "x9", text: "hi" }, bearer())).body.ok, false);
  assert.equal((await r.call("tool", `${P}nope`, "POST", {}, bearer())).status, 404);
  assert.equal((await r.call("tool", `${P}list_sessions`, "GET", undefined, bearer())).status, 405);
});

const signed = (max = 900) => ({ status: 200, body: { signed_url: WSS, session: "s", max_seconds: max, first_message: "Yo" } });

test("session binds a chat the user owns, opens one when none is given, and a foreign id is 404", async () => {
  let opened = 0;
  const r = rig({ openCallChat: async () => { opened++; return "s1"; } }, () => signed());
  const foreign = await r.call("handle", "/voice/agent/session", "POST", { bot: "sam", chat: "x9" });
  assert.equal(foreign.status, 404);
  assert.equal(r.calls.length, 0, "a chat the user does not own never starts a billed call");
  const given = await r.call("handle", "/voice/agent/session", "POST", { bot: "sam", chat: "s1" });
  assert.equal(given.status, 200);
  assert.equal(given.body.chatId, "s1");
  assert.equal(opened, 0);
  assert.deepEqual(Object.keys(given.body).sort(), ["botName", "chatId", "firstMessage", "maxSeconds", "session", "signedUrl"]);
  const fresh = rig({ openCallChat: async () => "s_opened" }, () => signed());
  const openedOut = await fresh.call("handle", "/voice/agent/session", "POST", { bot: "sam" });
  assert.equal(openedOut.status, 200);
  assert.equal(openedOut.body.chatId, "s_opened");
});

test("chat_read clamps limit, caps length, and errors when no call is bound", async () => {
  const lines = Array.from({ length: 60 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `m${i}` }));
  const r = rig({ openCallChat: async () => "s1", tools: { read: () => lines } }, () => signed());
  assert.equal((await r.call("tool", `${TOOL_PATH}chat_read`, "POST", {}, bearer())).body.error, NO_LIVE);
  assert.equal((await r.call("handle", "/voice/agent/session", "POST", { bot: "sam" })).body.chatId, "s1");
  const dflt = await r.call("tool", `${TOOL_PATH}chat_read`, "POST", {}, bearer());
  assert.equal(dflt.status, 200);
  assert.equal(dflt.body.chat_id, "s1");
  assert.equal(dflt.body.messages, 20);
  assert.equal(dflt.body.total_messages, 60);
  assert.match(dflt.body.transcript, /^User: m40\n/);
  assert.match(dflt.body.transcript, /Assistant: m59$/);
  const hi = await r.call("tool", `${TOOL_PATH}chat_read`, "POST", { limit: "80" }, bearer());
  assert.equal(hi.body.messages, 50);
  assert.match(hi.body.transcript, /^User: m10\n/);
  const lo = await r.call("tool", `${TOOL_PATH}chat_read`, "POST", { limit: "0" }, bearer());
  assert.equal(lo.body.messages, 1);
  assert.equal(lo.body.transcript, "Assistant: m59");
  assert.equal((await r.call("tool", `${TOOL_PATH}chat_read`, "POST", { limit: "-4" }, bearer())).body.messages, 1);
  assert.equal((await r.call("tool", `${TOOL_PATH}chat_read`, "POST", { limit: "nope" }, bearer())).body.messages, 20);
  const long = Array.from({ length: 10 }, () => ({ role: "user" as const, text: "a".repeat(1000) }));
  const capped = rig({ openCallChat: async () => "s1", tools: { read: () => long } }, () => signed());
  await capped.call("handle", "/voice/agent/session", "POST", { bot: "sam" });
  const cut = await capped.call("tool", `${TOOL_PATH}chat_read`, "POST", { limit: "50" }, bearer());
  assert.ok(cut.body.messages < 10);
  assert.ok(cut.body.transcript.length <= 6000);
  assert.equal(cut.body.total_messages, 10);
});

test("chat_post writes as the bot and does not start a turn", async () => {
  const r = rig({ openCallChat: async () => "s1" }, () => signed());
  await r.call("handle", "/voice/agent/session", "POST", { bot: "sam", chat: "s1" });
  const out = await r.call("tool", `${TOOL_PATH}chat_post`, "POST", { text: "1. one\n2. two" }, bearer());
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.deepEqual(r.said, [{ id: "s1", text: "1. one\n2. two" }]);
  assert.deepEqual(r.posted, []);
  const big = await r.call("tool", `${TOOL_PATH}chat_post`, "POST", { text: "b".repeat(2500) }, bearer());
  assert.equal(big.body.ok, true);
  assert.equal(r.said[1].text.length, 2000);
  assert.match((await r.call("tool", `${TOOL_PATH}chat_post`, "POST", { text: "  " }, bearer())).body.error, /text is required/);
});

test("chat_post_link posts a markdown link and rejects unsafe urls", async () => {
  const r = rig({ openCallChat: async () => "s1" }, () => signed());
  await r.call("handle", "/voice/agent/session", "POST", { bot: "sam", chat: "s1" });
  const ok = await r.call("tool", `${TOOL_PATH}chat_post_link`, "POST", { url: "https://docs.example.com/guide", label: "See [docs](now)\nplease" }, bearer());
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.posted, "[See docsnowplease](https://docs.example.com/guide)");
  assert.deepEqual(r.said, [{ id: "s1", text: ok.body.posted }]);
  const plain = await r.call("tool", `${TOOL_PATH}chat_post_link`, "POST", { url: "http://example.com/a" }, bearer());
  assert.equal(plain.body.ok, false);
  assert.equal(plain.body.error, "url must be https");
  assert.equal(plain.body.posted, undefined);
  const longLabel = "L".repeat(150);
  const trimmed = await r.call("tool", `${TOOL_PATH}chat_post_link`, "POST", { url: "https://example.com/a", label: longLabel }, bearer());
  assert.equal(trimmed.body.posted, `[${"L".repeat(120)}](https://example.com/a)`);
  for (const url of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "https://user:pass@example.com/a", "http://user:pass@example.com/a", "https://user@example.com/a", "https://example.com/" + "a".repeat(2000)]) {
    const bad = await r.call("tool", `${TOOL_PATH}chat_post_link`, "POST", { url }, bearer());
    assert.equal(bad.status, 200, url);
    assert.equal(bad.body.ok, false, url);
    assert.equal(typeof bad.body.error, "string", url);
  }
  assert.equal(r.said.length, 2, "rejected urls, including plain http, are not posted");
  assert.equal((await rig().call("tool", `${TOOL_PATH}chat_post_link`, "POST", { url: "https://example.com/a" }, bearer())).body.error, NO_LIVE);
  const allowed = rig({ allowHttpLinks: true, openCallChat: async () => "s1" }, () => signed());
  await allowed.call("handle", "/voice/agent/session", "POST", { bot: "sam", chat: "s1" });
  const httpOk = await allowed.call("tool", `${TOOL_PATH}chat_post_link`, "POST", { url: "http://example.com/a" }, bearer());
  assert.equal(httpOk.body.posted, "[example.com](http://example.com/a)");
  assert.equal((await allowed.call("tool", `${TOOL_PATH}chat_post_link`, "POST", { url: "javascript:alert(1)" }, bearer())).body.ok, false);
  assert.equal((await allowed.call("tool", `${TOOL_PATH}chat_post_link`, "POST", { url: "http://user:pass@example.com/a" }, bearer())).body.ok, false);
  assert.equal(allowed.said.length, 1);
});

test("an expired live-call binding is ignored", async () => {
  let t = 1_700_000_000_000;
  const r = rig({ now: () => t, openCallChat: async () => "s1" }, (url) => String(url).includes("/finish")
    ? { status: 200, body: { seconds: 1, credits_used: 0, transcript: [{ role: "user", text: "later" }] } }
    : signed(10));
  assert.equal((await r.call("handle", "/voice/agent/session", "POST", { bot: "sam" })).body.chatId, "s1");
  assert.equal((await r.call("tool", `${TOOL_PATH}chat_read`, "POST", {}, bearer())).body.chat_id, "s1");
  t += 10_000 + 60_000;
  assert.equal((await r.call("tool", `${TOOL_PATH}chat_read`, "POST", {}, bearer())).body.error, NO_LIVE);
  const fin = await r.call("handle", "/voice/agent/finish", "POST", { bot: "sam", conversationId: "conv_abc123" });
  assert.equal(fin.status, 200);
  assert.equal(r.savedChat[0], undefined);
  assert.equal(fin.body.sessionId, "sess_1");
});

test("finish appends the transcript into the bound chat and clears the binding", async () => {
  const r = rig({ openCallChat: async () => "s1" }, (url) => String(url).includes("/finish")
    ? { status: 200, body: { seconds: 5, credits_used: 0, transcript: [{ role: "agent", text: "Hi" }, { role: "user", text: "Yes" }] } }
    : signed());
  await r.call("handle", "/voice/agent/session", "POST", { bot: "sam", chat: "s1" });
  const fin = await r.call("handle", "/voice/agent/finish", "POST", { bot: "sam", conversationId: "conv_abc123" });
  assert.equal(fin.status, 200);
  assert.equal(fin.body.sessionId, "s1");
  assert.deepEqual(r.saved[0], [{ role: "agent", text: "Hi" }, { role: "user", text: "Yes" }]);
  assert.deepEqual(r.savedChat, ["s1"]);
  assert.equal((await r.call("tool", `${TOOL_PATH}chat_read`, "POST", {}, bearer())).body.error, NO_LIVE);
});

test("a live-call binding survives a new instance and a second instance sees it", async () => {
  const callsFile = join(mkdtempSync(join(tmpdir(), "vc-")), "voice-calls.json");
  let t = 1_700_000_000_000;
  const now = () => t;
  const a = rig({ now, callsFile, openCallChat: async () => "s1" }, () => signed(30));
  assert.equal((await a.call("handle", "/voice/agent/session", "POST", { bot: "sam", chat: "s1" })).body.chatId, "s1");
  const restarted = rig({ now, callsFile }, () => signed(30));
  assert.equal((await restarted.call("tool", `${TOOL_PATH}chat_read`, "POST", {}, bearer())).body.chat_id, "s1", "a new process over the same file still has the call");
  const b = rig({ now, callsFile }, (url) => String(url).includes("/finish")
    ? { status: 200, body: { seconds: 1, credits_used: 0, transcript: [{ role: "user", text: "bye" }] } }
    : signed(30));
  assert.equal((await b.call("tool", `${TOOL_PATH}chat_post`, "POST", { text: "from the other process" }, bearer())).body.ok, true);
  assert.deepEqual(b.said, [{ id: "s1", text: "from the other process" }]);
  const fin = await b.call("handle", "/voice/agent/finish", "POST", { bot: "sam", conversationId: "conv_abc123" });
  assert.equal(fin.status, 200);
  assert.equal(fin.body.sessionId, "s1");
  assert.deepEqual(b.savedChat, ["s1"]);
  assert.equal((await a.call("tool", `${TOOL_PATH}chat_read`, "POST", {}, bearer())).body.error, NO_LIVE, "finish clears the binding for the process that opened it");
  assert.equal((await restarted.call("tool", `${TOOL_PATH}chat_read`, "POST", {}, bearer())).body.error, NO_LIVE);
});

test("an expired binding is ignored and purged from the shared file", async () => {
  const callsFile = join(mkdtempSync(join(tmpdir(), "vc-")), "voice-calls.json");
  let t = 1_700_000_000_000;
  const now = () => t;
  const a = rig({ now, callsFile, openCallChat: async () => "s1" }, () => signed(10));
  await a.call("handle", "/voice/agent/session", "POST", { bot: "sam" });
  const b = rig({ now, callsFile }, () => signed(10));
  assert.equal((await b.call("tool", `${TOOL_PATH}chat_read`, "POST", {}, bearer())).body.chat_id, "s1");
  t += 10_000 + 60_000;
  assert.equal((await a.call("tool", `${TOOL_PATH}chat_read`, "POST", {}, bearer())).body.error, NO_LIVE);
  assert.deepEqual(JSON.parse(readFileSync(callsFile, "utf8")).owners, {});
  assert.equal((await b.call("tool", `${TOOL_PATH}chat_read`, "POST", {}, bearer())).body.error, NO_LIVE);
});

test("a tool token is still per owner: bob cannot read alice's live call chat", async () => {
  const BOB: any = { ...ME, id: "u_bob", username: "bob" };
  const r = rig({
    principalOf: (o) => (o === "u_alice" ? ME : o === "u_bob" ? BOB : undefined),
    openCallChat: async () => "s1",
  }, () => signed());
  assert.equal((await r.call("handle", "/voice/agent/session", "POST", { bot: "sam" })).body.chatId, "s1");
  assert.equal((await r.call("tool", `${TOOL_PATH}chat_read`, "POST", {}, bearer())).body.chat_id, "s1");
  const bob = await r.call("tool", `${TOOL_PATH}chat_read`, "POST", {}, bearer("u_bob"));
  assert.equal(bob.status, 200);
  assert.equal(bob.body.error, NO_LIVE);
  assert.equal(bob.body.transcript, undefined);
  assert.match((await r.call("tool", `${TOOL_PATH}read_session`, "POST", { session_id: "s1" }, bearer("u_bob"))).body.error, /No such chat/);
});

test("start_voice_agent: needs a prompt, is read class, and a hosted session may offer it", async () => {
  const t = createStartVoiceAgentTool();
  assert.equal(t.class, "read");
  assert.equal((await t.run({}, {} as any)).ok, false);
  const ok = await t.run({ prompt: "Talk through the launch plan." }, {} as any);
  assert.equal(ok.ok, true); assert.match(ok.output, /opening on the user's screen/);
  assert.equal(hostedToolAllowed("start_voice_agent"), true);
});

test("web: voice chat button, dock, worklet and settings fields are wired; CSP allows only the ElevenLabs socket", () => {
  const web = (f: string) => readFileSync(join(import.meta.dirname, "..", "..", "web", f), "utf8");
  const html = web("index.html");
  for (const id of ["btn-vchat", "vc-dock", "vc-status", "vc-stop", "bv-allm", "bv-first", "bv-aprompt"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(web("app.js"), /initVoiceAgent\(/); assert.match(web("app.js"), /start_voice_agent/);
  const v = web("voiceagent.js").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(v, /innerHTML|eval\(|new Function|document\.write/);
  assert.doesNotMatch(v, /xi-api-key|ELEVENLABS_API_KEY/i, "no key in the browser");
  assert.match(web("voiceagent-worklet.js"), /registerProcessor\("daebot-capture"/);
});

test("voice chat client helpers: PCM round trip and socket event parsing", async () => {
  const va: any = await import(new URL("../../web/voiceagent.js", import.meta.url).href);
  const src = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const back = va.pcm16Base64ToFloat(va.floatToPcm16Base64(src));
  src.forEach((x, i) => assert.ok(Math.abs(back[i] - x) < 0.001, `${i}`));
  assert.deepEqual(va.parseEvent(JSON.stringify({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { conversation_id: "conv_1" } })), { kind: "start", conversationId: "conv_1" });
  assert.deepEqual(va.parseEvent(JSON.stringify({ type: "user_transcript", user_transcription_event: { user_transcript: "hi" } })), { kind: "user", text: "hi" });
  assert.deepEqual(va.parseEvent(JSON.stringify({ type: "ping", ping_event: { event_id: 7, ping_ms: 10 } })), { kind: "ping", id: 7, ms: 10 });
  assert.equal(va.parseEvent("{nope"), undefined); assert.equal(va.parseEvent(JSON.stringify({ type: "weird" })), undefined);
});

test("voice chat bridge: typed chat is context, bang and interrupt barge in, own posts are dropped", async () => {
  const b: any = await import(new URL("../../web/voicechat-bridge.js", import.meta.url).href);
  assert.deepEqual(b.chatEventToCall({ type: "user", text: "look at this" }), { type: "contextual_update", text: "User typed in chat: look at this" });
  assert.deepEqual(b.chatEventToCall({ kind: "user", text: "  from the composer  " }), { type: "contextual_update", text: "User typed in chat: from the composer" });
  assert.deepEqual(b.chatEventToCall({ type: "user", text: "!ship it" }), { type: "user_message", text: "!ship it", stopPlayback: true });
  assert.deepEqual(b.chatEventToCall({ type: "user", text: "hello", interrupt: true }, { speaking: false }), { type: "contextual_update", text: "User typed in chat: hello" });
  assert.deepEqual(b.chatEventToCall({ type: "user", text: "hello", interrupt: true }, { speaking: true }), { type: "user_message", text: "hello", stopPlayback: true });
  assert.equal(b.chatEventToCall({ type: "text", delta: "I put it in the chat." }), null);
  assert.equal(b.chatEventToCall({ role: "assistant", text: "posted" }), null);
  assert.equal(b.chatEventToCall({ role: "agent", text: "posted" }), null);
  assert.equal(b.chatEventToCall({ type: "user", text: "echo", fromAgent: true }), null);
  assert.equal(b.chatEventToCall({ type: "notice", text: "hi" }), null);
  assert.equal(b.chatEventToCall({ type: "user", text: "   " }), null);
  const sent: any[] = [];
  let stopped = 0;
  assert.equal(b.forwardChatEvent({ type: "user", text: "!now" }, { send: (m: any) => sent.push(m), stopPlayback: () => { stopped++; } }), true);
  assert.deepEqual(sent, [{ type: "user_message", text: "!now" }]);
  assert.equal(stopped, 1);
  assert.equal(b.forwardChatEvent({ type: "text", delta: "mine" }, { send: (m: any) => sent.push(m), stopPlayback: () => { stopped++; } }), false);
  assert.equal(sent.length, 1);
  assert.match(readFileSync(join(import.meta.dirname, "..", "..", "web", "voiceagent.js"), "utf8"), /\.\.\.\(chat \? \{ chat \} : \{\}\)/);
  const app = readFileSync(join(import.meta.dirname, "..", "..", "web", "app.js"), "utf8");
  assert.match(app, /chatId: \(\) => state\.currentId \|\| undefined/);
  assert.match(app, /tellCall\(id, \{ type: "user", text, interrupt: true \}\)/);
  assert.match(app, /newUserTexts\(/);
  assert.match(app, /tellCall = \(sessionId, ev\) => \{ if \(sessionId && sessionId === voiceChat\.chatId\(\)\) voiceChat\.onChatEvent\(ev\); \}/);
  assert.doesNotMatch(app, /onChatEvent\(\{ type: "text"/);
  assert.doesNotMatch(app, /tellCall\([^)]*type: "text"/);
});
