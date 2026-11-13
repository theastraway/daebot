// Voice chat: a live ElevenLabs Conversational AI agent per bot, started from the bot panel or by the bot's start_voice_agent tool.
// The browser connects to ElevenLabs directly with a signed URL that MIND makes (MIND holds the ElevenLabs key, enforces the spend caps and bills the
// call); this file builds the session request from the bot's settings, saves the transcript into the bot's thread afterwards, and serves the agent's SERVER TOOLS:
// webhooks ElevenLabs calls (authenticated by a per-(owner, bot) token) so the voice agent can read the user's Daebot chats.
// During a call it can also read and post into the ONE chat that call is bound to. The token stays per (owner, bot): a per-call token would change
// MIND's tool fingerprint and force an ElevenLabs agent update on every call.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../auth/users.ts";
import type { BotVoice } from "../bots/voice.ts";

export const TOOL_PATH = "/voice-agent/tools/";
const MAX_SESSIONS_LISTED = 25;
const MAX_READ_CHARS = 6000;
const MAX_POST_CHARS = 2000;
const MAX_LINK_LABEL = 120;
/** Shown to the model (HTTP 200, like the other tool errors) when a tool needs the call's chat and there isn't one. */
const NO_LIVE_CHAT = "No live call chat. Start voice chat from a chat first.";

export interface AgentBot { id: string; slug: string; name: string; purpose: string; voice?: BotVoice; instructions: string }
export interface SessionLite { id: string; title: string; updatedAt: number; bot?: string }
export interface ChatLine { role: "user" | "assistant"; text: string }

/** What the server tools touch. Every call is scoped to ONE owner; another owner's id is simply "not found". */
export interface ToolBackend {
  list(owner: string): SessionLite[];
  read(owner: string, id: string): ChatLine[] | undefined;
  post(owner: string, id: string, text: string): Promise<"sent" | "busy" | "missing">;
  /** Post as the bot into a chat. Does not start a bot turn. */
  say(owner: string, id: string, text: string): Promise<"sent" | "missing">;
}

/** One live call's chat. Keyed owner:slug in the registry below. Expires shortly after the call's own cap so a late finish still lands in it. */
interface LiveCall { chatId: string; startedAt: number; expiresAt: number }

export interface VoiceAgentOptions {
  baseUrl: string;
  keyFor(p: Principal): string | undefined;
  /** HMAC secret for the per-agent tool tokens. */
  secret: string;
  publicBase(): string | undefined;
  botOf(p: Principal, slug: string): AgentBot | undefined;
  /** Saves a finished conversation. With chatId, appends into that chat instead of opening a new thread. Returns the session id. */
  saveTranscript(p: Principal, bot: AgentBot, lines: { role: "user" | "agent"; text: string }[], chatId?: string): Promise<string | undefined>;
  /** Opens the call's chat when the client did not name one. Same shape as the transcript save's new thread. */
  openCallChat?(p: Principal, bot: AgentBot): Promise<string | undefined>;
  tools: ToolBackend;
  principalOf(owner: string): Principal | undefined;
  fetchImpl?: typeof fetch;
  /** Clock for the live-call expiry. Tests advance it. */
  now?: () => number;
}

export const toolToken = (secret: string, owner: string, slug: string): string => {
  const body = `v1.${Buffer.from(owner).toString("base64url")}.${slug}`;
  return `${body}.${createHmac("sha256", secret).update(`voice-agent:${owner}:${slug}`).digest("base64url")}`;
};
/** The owner and bot slug a tool token was minted for, or undefined (forged, truncated, wrong secret). */
export function checkToolToken(secret: string, token: string): { owner: string; slug: string } | undefined {
  const m = /^v1\.([A-Za-z0-9_-]{1,120})\.([a-z0-9-]{1,32})\.([A-Za-z0-9_-]{20,})$/.exec(token);
  if (!m) return undefined;
  let owner: string;
  try { owner = Buffer.from(m[1], "base64url").toString("utf8"); } catch { return undefined; }
  const want = Buffer.from(toolToken(secret, owner, m[2]));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got) ? { owner, slug: m[2] } : undefined;
}

const TOOLS = [
  { name: "list_sessions", description: "List the user's recent Daebot chats (newest first): id, title, when, and which bot. Use it to find a chat before reading it.", properties: {}, required: [] as string[] },
  { name: "read_session", description: "Read the messages of one Daebot chat by its session_id (from list_sessions or search_chats). Returns the latest part of the conversation.", properties: { session_id: { description: "The chat's id" } }, required: ["session_id"] },
  { name: "search_chats", description: "Search all of the user's Daebot chats for a word or phrase. Returns matching chats with a short snippet each.", properties: { query: { description: "What to look for" } }, required: ["query"] },
  { name: "post_to_session", description: "Post a message into one Daebot chat as the user (the chat's bot will answer there). Only when the user asks you to send something.", properties: { session_id: { description: "The chat's id" }, text: { description: "The message to post" } }, required: ["session_id", "text"] },
  { name: "chat_read", description: "Read the latest messages of the chat this live call is bound to, including what the user typed during the call.", properties: { limit: { description: "How many recent messages to return, from 1 to 50. Default 20." } }, required: [] as string[] },
  { name: "chat_post", description: "Post into the chat this live call is bound to, as yourself (the bot). It does not start a bot turn. Use it for things better read than heard: lists, numbers, code. You may stop speaking mid-sentence to post.", properties: { text: { description: "The message to post (max 2000 characters)" } }, required: ["text"] },
  { name: "chat_post_link", description: "Drop a link into the chat this live call is bound to instead of reading the URL aloud. http or https only.", properties: { url: { description: "Absolute http or https URL" }, label: { description: "Short link text. Defaults to the site name." } }, required: ["url"] },
];

function whenText(ms: number): string { return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC"; }
const flat = (t: string): string => t.replace(/\s+/g, " ").trim();

/** The model-facing system prompt of a bot's voice agent: who it is, its DAEBOT.md, how to talk, and what the tools are for. */
export function agentPrompt(bot: AgentBot, sessionPrompt: string | undefined): string {
  const parts = [
    `You are ${bot.name}${bot.purpose ? `, ${bot.purpose.replace(/[.\s]+$/, "")}` : ""}. You are talking with your user by voice, live.`,
    bot.instructions.trim() ? `Your standing instructions (DAEBOT.md):\n${bot.instructions.trim().slice(0, 5000)}` : "",
    "How to talk: short spoken sentences, no lists, no markdown, no reading out links. Answer first, then stop. If you do not know, say so.",
    "You can read the user's Daebot chats with your tools: list_sessions, read_session, search_chats. Use them whenever the user asks what was said, decided or done in a chat. Never guess what a chat says. You can post a message into a chat with post_to_session only when the user asks you to.",
    "During this call you share a chat with the user. Use chat_read to see what they typed. Use chat_post to write things that are better read than heard (lists, numbers, code). Use chat_post_link to drop any link instead of reading it out. It's fine to stop talking mid-sentence to post, then say \"I put it in the chat.\"",
    bot.voice?.agentPrompt ? `Extra instructions for voice chat:\n${bot.voice.agentPrompt}` : "",
    sessionPrompt?.trim() ? `For this conversation specifically:\n${sessionPrompt.trim().slice(0, 3000)}` : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

export function sessionBody(secret: string, bot: AgentBot, owner: string, publicBase: string, sessionPrompt: string | undefined): Record<string, unknown> {
  const v = bot.voice ?? {};
  return {
    bot: bot.slug, name: bot.name, prompt: agentPrompt(bot, sessionPrompt),
    first_message: v.agentFirstMessage || `Hi, it's ${bot.name}. What are we working on?`,
    llm: v.agentLlm || "gemini-2.5-flash", language: v.language && /^[a-z]{2,3}$/.test(v.language) ? v.language : "en",
    voice: { ...(v.voiceId ? { voice_id: v.voiceId } : {}), ...(v.model ? { model_id: v.model } : {}), ...(v.stability !== undefined ? { stability: v.stability } : {}), ...(v.similarityBoost !== undefined ? { similarity_boost: v.similarityBoost } : {}), ...(v.speed !== undefined ? { speed: v.speed } : {}) },
    tools_base_url: `${publicBase}${TOOL_PATH.replace(/\/$/, "")}`, tools_token: toolToken(secret, owner, bot.slug), tools: TOOLS,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(data)), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(data);
}
async function readJson(req: IncomingMessage, max = 64 * 1024): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > max) return undefined; chunks.push(c as Buffer); }
  try { const j = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); return j && typeof j === "object" && !Array.isArray(j) ? j : undefined; } catch { return undefined; }
}

/** Newest lines that fit in MAX_READ_CHARS, in the same "User:/Assistant:" transcript read_session returns. */
function renderTranscript(lines: ChatLine[]): { picked: ChatLine[]; transcript: string } {
  let out = ""; const picked: ChatLine[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = `${lines[i].role === "user" ? "User" : "Assistant"}: ${flat(lines[i].text)}`;
    if (out.length + t.length > MAX_READ_CHARS) break;
    out = t + "\n" + out;
    picked.unshift(lines[i]);
  }
  return { picked, transcript: out.trim() };
}
/** limit is a string (MIND coerces every tool property to string). Missing or junk stays at the default. */
function clampLimit(raw: unknown): number {
  if (typeof raw !== "string" || !raw.trim()) return 20;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 20;
  return Math.min(50, Math.max(1, Math.trunc(n)));
}
/** Absolute http(s) only. javascript:, data:, file: and user:pass@ never become a markdown link. */
function linkPost(urlRaw: string, labelRaw: string): { ok: true; posted: string } | { ok: false; error: string } {
  const url = urlRaw.trim();
  if (!url) return { ok: false, error: "url is required" };
  if (url.length > MAX_POST_CHARS) return { ok: false, error: "url is too long" };
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, error: "url must be an absolute http or https URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "url must be an absolute http or https URL" };
  if (u.username || u.password) return { ok: false, error: "url must not contain credentials" };
  const label = labelRaw.replace(/[\[\]()\r\n]/g, "").trim().slice(0, MAX_LINK_LABEL).trim() || u.hostname || "link";
  // Parentheses would break out of the markdown link. Percent-encoding keeps the href inside the parens.
  const href = u.href.replaceAll("(", "%28").replaceAll(")", "%29");
  return { ok: true, posted: `[${label}](${href})` };
}

export function createVoiceAgent(o: VoiceAgentOptions) {
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.baseUrl.replace(/\/+$/, "");
  const now = o.now ?? (() => Date.now());
  // One live call per (owner, bot). The tool token cannot carry the chat id (that would change every call), so the binding lives here.
  const calls = new Map<string, LiveCall>();
  const callKey = (owner: string, slug: string) => `${owner}:${slug}`;
  const purgeCalls = () => { const t = now(); for (const [k, c] of calls) if (c.expiresAt <= t) calls.delete(k); };
  const liveCall = (owner: string, slug: string): LiveCall | undefined => { purgeCalls(); return calls.get(callKey(owner, slug)); };
  const bindCall = (owner: string, slug: string, chatId: string, maxSeconds: number | undefined) => {
    const t = now();
    const sec = typeof maxSeconds === "number" && maxSeconds > 0 ? maxSeconds : 900;
    calls.set(callKey(owner, slug), { chatId, startedAt: t, expiresAt: t + sec * 1000 + 60_000 });
  };
  const clearCall = (owner: string, slug: string) => { calls.delete(callKey(owner, slug)); };

  async function mind(key: string, bot: string | undefined, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
    const r = await f(`${base}${path}`, { method: init.method ?? "GET", headers: { "X-API-Key": key, ...(bot ? { "X-Daebot-Bot": bot } : {}), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}), signal: AbortSignal.timeout(60_000) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  const fail = (res: ServerResponse, st: number, b: any) => {
    if (st === 402) return json(res, 402, { error: b?.error ?? "insufficient_credits", message: typeof b?.message === "string" ? b.message.slice(0, 300) : "Not enough MIND credits for voice chat.", ...(b?.scope ? { scope: b.scope } : {}) });
    if (st === 401 || st === 403) return json(res, 401, { error: "mind_key_rejected", message: "Your MIND key was not accepted for voice. Sign in again." });
    if (st === 404 || st === 503) return json(res, 503, { error: "voice_unavailable", message: "Voice chat is not switched on yet." });
    return json(res, 502, { error: "voice_failed", message: "Voice chat could not start. Try again." });
  };

  /** Authenticated (signed-in user) routes: /voice/agent/llms, /voice/agent/session, /voice/agent/finish. */
  async function handle(req: IncomingMessage, res: ServerResponse, path: string, p: Principal): Promise<void> {
    const key = o.keyFor(p);
    if (!key) return json(res, 503, { error: "voice_unavailable", message: "Voice needs a MIND key. Sign in with your MIND account." });
    try {
      if (path === "/voice/agent/llms") {
        if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
        const r = await mind(key, undefined, "/audio/agent/llms");
        return r.status === 200 ? json(res, 200, r.body) : fail(res, r.status, r.body);
      }
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      const b = await readJson(req);
      if (!b) return json(res, 400, { error: "invalid JSON" });
      const slug = typeof b.bot === "string" ? b.bot : "";
      const bot = o.botOf(p, slug);
      if (!bot) return json(res, 404, { error: "not_found", message: "no such bot" });
      if (path === "/voice/agent/session") {
        const pub = o.publicBase();
        if (!pub) return json(res, 503, { error: "voice_unavailable", message: "This deployment has no public address for voice tools." });
        // A named chat must already belong to this user. Checked before MIND so a bad id does not start a billed call.
        const requested = typeof b.chat === "string" ? b.chat.trim().slice(0, 200) : "";
        if (requested && o.tools.read(p.id, requested) === undefined) return json(res, 404, { error: "not_found", message: "no such chat" });
        const sp = typeof b.prompt === "string" ? b.prompt : undefined;
        const r = await mind(key, bot.slug, "/audio/agent/session", { method: "POST", body: sessionBody(o.secret, bot, p.id, pub, sp) });
        if (r.status !== 200) return fail(res, r.status, r.body);
        const { signed_url: signedUrl, session, max_seconds: maxSeconds, first_message: firstMessage } = r.body;
        if (typeof signedUrl !== "string" || !/^wss:\/\/api\.elevenlabs\.io\//.test(signedUrl)) return json(res, 502, { error: "voice_failed", message: "Voice chat could not start. Try again." });
        let chatId = requested || undefined;
        if (!chatId && o.openCallChat) chatId = await o.openCallChat(p, bot) || undefined;
        if (chatId) bindCall(p.id, bot.slug, chatId, typeof maxSeconds === "number" ? maxSeconds : undefined);
        return json(res, 200, { signedUrl, session, maxSeconds, firstMessage, botName: bot.name, ...(chatId ? { chatId } : {}) });
      }
      if (path === "/voice/agent/finish") {
        const cid = typeof b.conversationId === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(b.conversationId) ? b.conversationId : undefined;
        const r = await mind(key, bot.slug, "/audio/agent/finish", { method: "POST", body: { bot: bot.slug, ...(cid ? { conversation_id: cid } : {}) } });
        if (r.status === 202) return json(res, 202, { pending: true });
        if (r.status !== 200) return fail(res, r.status, r.body);
        const lines: { role: "user" | "agent"; text: string }[] = [];
        for (const t of Array.isArray(r.body.transcript) ? r.body.transcript : []) {
          const text = typeof t?.text === "string" ? t.text.trim() : "";
          if (!text) continue;
          const role = t.role === "user" ? "user" : "agent";
          const last = lines[lines.length - 1];
          if (last && last.role === role) last.text += `\n\n${text}`; else lines.push({ role, text });
        }
        const bound = liveCall(p.id, bot.slug);
        const sessionId = lines.length ? await o.saveTranscript(p, bot, lines, bound?.chatId) : undefined;
        // Keep the binding when the transcript did not land, so a retry of finish still appends into the same chat.
        if (bound && (!lines.length || sessionId)) clearCall(p.id, bot.slug);
        return json(res, 200, { seconds: r.body.seconds ?? 0, creditsUsed: r.body.credits_used ?? 0, lines: lines.length, ...(sessionId ? { sessionId } : {}) });
      }
      return json(res, 404, { error: "not found" });
    } catch { return json(res, 502, { error: "voice_failed", message: "The voice service could not be reached." }); }
  }

  /** The agent's server tools. ElevenLabs calls these; the bearer token says which owner and bot the call is for. */
  async function tool(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const auth = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ""));
    const who = auth ? checkToolToken(o.secret, auth[1]) : undefined;
    if (!who || !o.principalOf(who.owner)) { req.resume(); return json(res, 401, { error: "unauthorized" }); }
    const name = path.slice(TOOL_PATH.length);
    const b = await readJson(req);
    if (!b) return json(res, 400, { error: "invalid JSON" });
    const T = o.tools;
    const str = (k: string, n: number): string => (typeof b[k] === "string" ? (b[k] as string).slice(0, n) : "");
    if (name === "list_sessions") {
      const rows = T.list(who.owner).sort((a, c) => c.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS_LISTED);
      return json(res, 200, { sessions: rows.map((s) => ({ session_id: s.id, title: s.title || "Untitled", when: whenText(s.updatedAt), ...(s.bot ? { bot: s.bot } : {}) })) });
    }
    if (name === "read_session") {
      const id = str("session_id", 200);
      const lines = id ? T.read(who.owner, id) : undefined;
      if (!lines) return json(res, 200, { error: "No such chat. Use list_sessions or search_chats to find its id." });
      const view = renderTranscript(lines);
      return json(res, 200, { session_id: id, messages: view.picked.length, total_messages: lines.length, transcript: view.transcript });
    }
    if (name === "search_chats") {
      const q = flat(str("query", 200)).toLowerCase();
      if (!q) return json(res, 200, { error: "query is required" });
      const hits: { session_id: string; title: string; when: string; snippet: string }[] = [];
      for (const s of T.list(who.owner).sort((a, c) => c.updatedAt - a.updatedAt).slice(0, 200)) {
        const lines = T.read(who.owner, s.id) ?? [];
        const hit = lines.find((l) => l.text.toLowerCase().includes(q));
        if (hit) { const t = flat(hit.text); const at = t.toLowerCase().indexOf(q); hits.push({ session_id: s.id, title: s.title || "Untitled", when: whenText(s.updatedAt), snippet: t.slice(Math.max(0, at - 80), at + 160) }); }
        if (hits.length >= 8) break;
      }
      return json(res, 200, { query: q, matches: hits });
    }
    if (name === "post_to_session") {
      const id = str("session_id", 200), text = str("text", MAX_POST_CHARS).trim();
      if (!id || !text) return json(res, 200, { error: "session_id and text are required" });
      const r = await T.post(who.owner, id, text);
      return json(res, 200, r === "sent" ? { ok: true, note: "Posted. The chat's bot will answer there." } : { ok: false, error: r === "busy" ? "That chat is busy with another reply right now." : "No such chat." });
    }
    if (name === "chat_read" || name === "chat_post" || name === "chat_post_link") {
      const call = liveCall(who.owner, who.slug);
      if (!call) return json(res, 200, { error: NO_LIVE_CHAT });
      if (name === "chat_read") {
        const lines = T.read(who.owner, call.chatId);
        if (!lines) return json(res, 200, { error: "No such chat. Use list_sessions or search_chats to find its id." });
        const view = renderTranscript(lines.slice(-clampLimit(b.limit)));
        return json(res, 200, { chat_id: call.chatId, messages: view.picked.length, total_messages: lines.length, transcript: view.transcript });
      }
      if (name === "chat_post") {
        const text = str("text", MAX_POST_CHARS).trim();
        if (!text) return json(res, 200, { error: "text is required" });
        const r = await T.say(who.owner, call.chatId, text);
        return json(res, 200, r === "sent" ? { ok: true } : { ok: false, error: "No such chat." });
      }
      const rawUrl = typeof b.url === "string" ? b.url : "";
      const posted = linkPost(rawUrl, typeof b.label === "string" ? b.label : "");
      if (!posted.ok) return json(res, 200, posted);
      const r = await T.say(who.owner, call.chatId, posted.posted);
      return json(res, 200, r === "sent" ? { ok: true, posted: posted.posted } : { ok: false, error: "No such chat." });
    }
    return json(res, 404, { error: "unknown tool" });
  }

  return { handle, tool };
}
