import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createVoiceAgent, checkToolToken, toolToken, sessionBody, agentPrompt, TOOL_PATH } from "../../src/gateway/voiceagent.ts";
import type { AgentBot, VoiceAgentOptions } from "../../src/gateway/voiceagent.ts";
import { createStartVoiceAgentTool } from "../../src/bots/voicechat-tool.ts";
import { hostedToolAllowed } from "../../src/hosted.ts";

const SECRET = "s".repeat(32);
const ME: any = { id: "u_alice", username: "alice", owner: false, tier: "staff" };
const BOT: AgentBot = { id: "b_1", slug: "sam", name: "Sam", purpose: "Chief of staff", instructions: "# Role\nBe brief.", voice: { voiceId: "MiueK1FXuZTCItgbQwPu", speed: 1.1, agentLlm: "claude-haiku-4-5", agentFirstMessage: "Yo", agentPrompt: "Sound relaxed.", language: "es" } };

function rig(over: Partial<VoiceAgentOptions> = {}, mind: (url: string, init: any) => { status: number; body: any } = () => ({ status: 200, body: {} })) {
  const calls: { url: string; init: any }[] = [];
  const posted: any[] = [];
  const saved: any[] = [];
  const f = (async (url: string, init: any) => { calls.push({ url, init }); const r = mind(url, init); return new Response(JSON.stringify(r.body), { status: r.status }); }) as unknown as typeof fetch;
  const opts: VoiceAgentOptions = {
    baseUrl: "http://m/developer/v1", keyFor: (p) => (p.id === "u_alice" ? "alicekey" : undefined), secret: SECRET, publicBase: () => "https://daebot.live",
    botOf: (p, slug) => (p.id === "u_alice" && slug === "sam" ? BOT : undefined),
    saveTranscript: async (_p, _b, lines) => { saved.push(lines); return "sess_1"; },
    principalOf: (o) => (o === "u_alice" ? ME : undefined), fetchImpl: f,
    tools: {
      list: (o) => (o === "u_alice" ? [{ id: "s1", title: "Pricing chat", updatedAt: 2000 }, { id: "s2", title: "Hiring", updatedAt: 3000, bot: "b_1" }] : [{ id: "x9", title: "Bob secret", updatedAt: 1 }]),
      read: (o, id) => (o === "u_alice" && id === "s1" ? [{ role: "user", text: "What is our price?" }, { role: "assistant", text: "We charge $99 a month." }] : undefined),
      post: async (o, id, text) => { if (o !== "u_alice" || id !== "s1") return "missing"; posted.push(text); return "sent"; },
    },
    ...over,
  };
  const h = createVoiceAgent(opts);
  const call = (kind: "handle" | "tool", path: string, method: string, body?: unknown, headers: Record<string, string> = {}, p = ME) => {
    const buf = Buffer.from(JSON.stringify(body ?? {}));
    const req: any = Object.assign(Readable.from([buf]), { method, headers: { "content-type": "application/json", ...headers } });
    const out: { status: number; body: any } = { status: 0, body: undefined };
    const res: any = { headersSent: false, writeHead(s: number) { out.status = s; }, end(d?: string) { if (d) out.body = JSON.parse(d); } };
    return (kind === "handle" ? h.handle(req, res, path, p) : h.tool(req, res, path)).then(() => out);
  };
  return { call, calls, posted, saved };
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
  assert.deepEqual(b.tools.map((t: any) => t.name), ["list_sessions", "read_session", "search_chats", "post_to_session"]);
  assert.match(b.prompt, /You are Sam, Chief of staff/); assert.match(b.prompt, /Be brief\./); assert.match(b.prompt, /Sound relaxed\./); assert.match(b.prompt, /Plan the launch\./);
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
