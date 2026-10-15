// Shared channel machinery: conversation -> AgentSession mapping, per-conversation turn
// serialization, event draining, per-channel formatting/chunking, tier policy, rate limiting,
// and channel config loading. Original code (no third-party source copied).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentSession } from "../types.ts";

// ---------- gateway + config types ----------
export type Tier = "admin" | "staff" | "public";

// ChannelAdapter's gateway has open(surface, title). Channels also pass an identity so the runtime can
// restrict tools (the runtime's openSession takes opts.identity). A gateway that ignores the third
// argument simply opens an unrestricted session, so the gateway MUST honor it (see types.ts proposal).
export interface ChannelGateway {
  open(surface: string, title?: string, opts?: { identity?: string }): Promise<AgentSession>;
}

export type FetchLike = typeof fetch;

export interface WebhookRequestLike {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: string;
  text?: string;
}
export interface WebhookResponseLike { status: number; headers?: Record<string, string>; body?: unknown }
export type RegisterWebhookFn = (
  channel: string,
  handler: (req: WebhookRequestLike) => Promise<WebhookResponseLike>,
  opts?: { auth?: "token" | "none" },
) => void | (() => void);

export interface ChannelDeps {
  fetch?: FetchLike;
  WebSocket?: typeof WebSocket;
  registerWebhook?: RegisterWebhookFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface PolicyConfig {
  tiers?: Record<string, Tier>;          // sender id -> tier; unknown senders use defaultTier
  defaultTier?: Tier;                    // default "public"
  rateLimitPerMin?: Partial<Record<Tier, number>>; // default public 10, staff 60, admin unlimited
}

export interface TelegramConfig extends PolicyConfig {
  token: string;
  allowedChatIds?: (string | number)[];  // if non-empty, all other chats are ignored silently
  apiBase?: string;                      // default https://api.telegram.org
  pollTimeoutSec?: number;               // default 30
}
export interface DiscordConfig extends PolicyConfig {
  token: string;
  apiBase?: string;                      // default https://discord.com/api/v10
  gatewayUrl?: string;                   // override (tests); default discovered via GET /gateway/bot
  allowedChannelIds?: string[];
}
export interface IMessageConfig extends PolicyConfig {
  apiKey: string;
  apiSecret: string;
  fromNumber: string;
  webhookSecret?: string;                // shared secret Sendblue echoes in a request header
  secretHeader?: string;                 // default "sb-signing-secret" (docs do not name it; configurable)
  allowUnauthenticated?: boolean;        // explicit opt-out of the secret check (dev only)
  apiBase?: string;                      // default https://api.sendblue.co
}
export interface WebhookChannelConfig extends PolicyConfig {
  secret: string;
  secretHeader?: string;                 // default "x-mindclaw-secret"
  channelName?: string;                  // default "webhook"
  allowedCallbackHosts?: string[];       // callbackUrl must be https and (if set) on this list
}

export interface ChannelsConfig {
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
  imessage?: IMessageConfig;
  webhook?: WebhookChannelConfig;
  deps?: ChannelDeps;
}

// ---------- small utils ----------
export const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Replace any secret substrings so tokens never reach logs or error messages. */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("***");
  return out;
}

export function describeError(e: unknown, secrets: (string | undefined)[] = []): string {
  const msg = e instanceof Error ? e.message : String(e);
  return redact(msg, secrets);
}

// ---------- chunking ----------
function fenceAfter(text: string, open: string | null): string | null {
  let cur = open;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) cur = cur ? null : line.trim();
  }
  return cur;
}

/** Split text into pieces of at most `limit` chars, preferring paragraph/line/space breaks and
 *  closing + reopening ``` fences so each piece renders on its own. */
export function chunkText(text: string, limit: number): string[] {
  if (!Number.isFinite(limit) || text.length <= limit) return text.length ? [text] : [];
  if (limit < 20) limit = 20;
  const out: string[] = [];
  let rest = text;
  let reopen: string | null = null;
  while (rest.length) {
    const prefix = reopen ? reopen + "\n" : "";
    if (prefix.length + rest.length <= limit) { out.push(prefix + rest); break; }
    const avail = limit - prefix.length - 4; // room for "\n```"
    let cut = rest.lastIndexOf("\n\n", avail);
    if (cut < avail / 2) cut = rest.lastIndexOf("\n", avail);
    if (cut < avail / 2) cut = rest.lastIndexOf(" ", avail);
    if (cut < avail / 2) cut = avail;
    if (cut < 1) cut = 1;
    let piece = rest.slice(0, cut);
    const open = fenceAfter(prefix + piece, null);
    if (open) piece += "\n```";
    out.push(prefix + piece.replace(/\s+$/, ""));
    reopen = open;
    rest = rest.slice(cut).replace(/^\n+/, "").replace(/^ /, "");
  }
  return out.filter((p) => p.trim().length > 0);
}

// ---------- markdown conversion ----------
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Markdown -> Telegram HTML subset (b, i, code, pre, a). Everything else is escaped. */
export function markdownToTelegramHtml(md: string): string {
  const stash: string[] = [];
  const hold = (html: string) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = md.replace(/\u0000/g, "");
  s = s.replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, (_m, code: string) => hold(`<pre>${escHtml(code.replace(/\n$/, ""))}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => hold(`<code>${escHtml(c)}</code>`));
  s = escHtml(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`);
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>").replace(/__([^\n]+?)__/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<i>$2</i>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, "$1<i>$2</i>");
  s = s.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)] ?? "");
}

export function markdownToDiscord(md: string): string {
  return md.replace(/^#{4,6}\s+/gm, "### ");
}

/** Strip markdown to plain text for iMessage. */
export function markdownToPlain(md: string): string {
  let s = md;
  s = s.replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, (_m, code: string) => code.replace(/\n$/, ""));
  s = s.replace(/`([^`\n]+)`/g, "$1");
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/\*\*([^\n]+?)\*\*/g, "$1").replace(/__([^\n]+?)__/g, "$1");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1$2");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, "$1$2");
  s = s.replace(/^(\s*)[-*]\s+/gm, "$1- ");
  return s;
}

export type FormatKind = "telegram" | "discord" | "imessage" | "plain";
export const LIMITS = { telegram: 4096, discord: 2000, imessage: 1000 } as const;

/** Convert + chunk a markdown string into messages that fit the channel. */
export function formatForChannel(kind: FormatKind, text: string): string[] {
  if (!text.trim()) return [];
  switch (kind) {
    case "plain": return [text];
    case "discord": return chunkText(markdownToDiscord(text), LIMITS.discord);
    case "imessage": return chunkText(markdownToPlain(text), LIMITS.imessage);
    case "telegram": {
      const out: string[] = [];
      const render = (md: string, lim: number) => {
        for (const piece of chunkText(md, lim)) {
          const html = markdownToTelegramHtml(piece);
          if (html.length <= LIMITS.telegram) out.push(html);
          else if (lim > 200) render(piece, Math.floor(lim / 2));
          else out.push(html.slice(0, LIMITS.telegram));
        }
      };
      render(text, 3000);
      return out;
    }
  }
}

// ---------- confirm / gate rendering ----------
export function renderConfirm(ev: Extract<AgentEvent, { type: "confirm" }>): string {
  let args = "";
  try { args = JSON.stringify(ev.args); } catch { args = "(unprintable arguments)"; }
  if (args.length > 300) args = args.slice(0, 300) + "...";
  const what = args && args !== "{}" ? `${ev.tool} with ${args}` : ev.tool;
  return `Approval needed. I am about to run ${what}. ${ev.reason}\nReply 'send it' to approve. Anything else cancels.`;
}

export function renderGate(ev: Extract<AgentEvent, { type: "gate" }>): string {
  return `[gate ${ev.verdict.gate}] ${ev.verdict.reason}`;
}

// ---------- rate limiting ----------
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private told = new Map<string, number>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  /** true if allowed; records the hit. limit Infinity = unlimited. */
  allow(key: string, limitPerMin: number): boolean {
    if (!Number.isFinite(limitPerMin)) return true;
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= limitPerMin) { this.hits.set(key, arr); return false; }
    arr.push(t);
    this.hits.set(key, arr);
    return true;
  }
  /** true once per minute per key, so a flood gets one notice not a notice per message. */
  shouldNotify(key: string): boolean {
    const t = this.now();
    const last = this.told.get(key) ?? 0;
    if (t - last < 60_000) return false;
    this.told.set(key, t);
    return true;
  }
}

export function makeTierResolver(p: PolicyConfig): (senderId: string) => Tier {
  const tiers = p.tiers ?? {};
  const def = p.defaultTier ?? "public";
  return (id) => tiers[id] ?? def;
}

const DEFAULT_RATE: Record<Tier, number> = { public: 10, staff: 60, admin: Infinity };

// ---------- conversation hub ----------
export interface InboundMessage { conversationId: string; senderId: string; senderName?: string; text: string }
export interface HubOptions {
  surface: string;
  gateway: ChannelGateway;
  policy: PolicyConfig;
  idleMs?: number;       // default 24h
  flushAt?: number;      // default 1500
  maxSessions?: number;  // default 200
  now?: () => number;
  log?: (m: string) => void;
}
interface Entry { session: AgentSession; lastUsed: number }

export const RATE_NOTICE = "You are sending messages too fast. Please wait a minute and try again.";
export const ERROR_NOTICE = "Sorry, something went wrong handling that. Please try again.";

export class ConversationHub {
  readonly tierOf: (senderId: string) => Tier;
  private entries = new Map<string, Entry>();
  private chains = new Map<string, Promise<void>>();
  private limiter: RateLimiter;
  private now: () => number;
  private sweeper?: ReturnType<typeof setInterval>;
  private o: HubOptions;
  constructor(o: HubOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.limiter = new RateLimiter(this.now);
    this.tierOf = makeTierResolver(o.policy);
  }

  sessionCount(): number { return this.entries.size; }

  /** Handle one inbound message; resolves when the turn has been fully delivered via reply(). */
  handle(msg: InboundMessage, reply: (markdown: string) => Promise<void>, extra: { typing?: () => Promise<void> } = {}): Promise<void> {
    const text = msg.text.trim();
    if (!text) return Promise.resolve();
    const tier = this.tierOf(msg.senderId);
    const limit = this.o.policy.rateLimitPerMin?.[tier] ?? DEFAULT_RATE[tier];
    const rlKey = `${this.o.surface}:${msg.senderId}`;
    if (!this.limiter.allow(rlKey, limit)) {
      return this.limiter.shouldNotify(rlKey) ? reply(RATE_NOTICE).catch(() => {}) : Promise.resolve();
    }
    const key = `${msg.conversationId}|${tier}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.runTurn(key, tier, msg, text, reply, extra));
    const tail = run.catch(() => {});
    this.chains.set(key, tail);
    void tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
    return run;
  }

  private async runTurn(key: string, tier: Tier, msg: InboundMessage, text: string, reply: (m: string) => Promise<void>, extra: { typing?: () => Promise<void> }): Promise<void> {
    let entry = this.entries.get(key);
    try {
      if (!entry) {
        const title = `${this.o.surface}:${msg.conversationId}${msg.senderName ? " " + msg.senderName : ""}`;
        const identity = tier === "admin" ? undefined : tier;
        const session = await this.o.gateway.open(this.o.surface, title, identity ? { identity } : undefined);
        entry = { session, lastUsed: this.now() };
        this.entries.set(key, entry);
        void this.evictOverflow();
      }
      entry.lastUsed = this.now();
      await this.drain(entry.session, text, reply, extra);
      entry.lastUsed = this.now();
    } catch (e) {
      this.o.log?.(`[${this.o.surface}] turn failed: ${describeError(e)}`);
      if (entry && !this.entries.has(key)) { /* already evicted */ }
      else if (entry) { this.entries.delete(key); void entry.session.close().catch(() => {}); }
      await reply(ERROR_NOTICE).catch(() => {});
    }
  }

  private async drain(session: AgentSession, text: string, reply: (m: string) => Promise<void>, extra: { typing?: () => Promise<void> }): Promise<void> {
    const flushAt = this.o.flushAt ?? 1500;
    let buf = "";
    let sawText = false;
    const flushAll = async () => { const t = buf; buf = ""; if (t.trim()) await reply(t); };
    let typingTimer: ReturnType<typeof setInterval> | undefined;
    if (extra.typing) {
      void extra.typing().catch(() => {});
      typingTimer = setInterval(() => void extra.typing!().catch(() => {}), 4000);
      typingTimer.unref?.();
    }
    try {
      for await (const ev of session.send(text)) {
        switch (ev.type) {
          case "text":
            buf += ev.delta; sawText = true;
            while (buf.length >= flushAt) {
              let cut = buf.lastIndexOf("\n\n", flushAt);
              if (cut < flushAt / 3) cut = buf.lastIndexOf("\n", flushAt);
              if (cut < flushAt / 3) cut = buf.lastIndexOf(" ", flushAt);
              if (cut < flushAt / 3) cut = flushAt;
              const part = buf.slice(0, cut);
              buf = buf.slice(cut).replace(/^\s+/, "");
              if (part.trim()) await reply(part);
            }
            break;
          case "retract":
            buf = ""; // a gate withheld the draft: drop what has not been sent yet (retract always precedes its gate event)
            break;
          case "gate":
            if (ev.enforced) { await flushAll(); await reply(renderGate(ev)); }
            break;
          case "confirm":
            await flushAll(); await reply(renderConfirm(ev));
            break;
          case "notice":
            if (ev.level === "warn") { await flushAll(); await reply(`[notice] ${ev.text}`); }
            break;
          case "done":
            if (!sawText && ev.finalText) { buf = ev.finalText; sawText = true; }
            break;
          default: break; // toolStart/toolEnd/usage are not shown on chat channels
        }
      }
      await flushAll();
    } finally {
      if (typingTimer) clearInterval(typingTimer);
    }
  }

  /** Close sessions idle longer than idleMs. */
  async sweep(): Promise<number> {
    const idle = this.o.idleMs ?? 24 * 3600_000;
    const t = this.now();
    let n = 0;
    for (const [k, e] of [...this.entries]) {
      if (t - e.lastUsed >= idle && !this.chains.has(k)) {
        this.entries.delete(k);
        await e.session.close("channel session idle").catch(() => {});
        n++;
      }
    }
    return n;
  }

  private async evictOverflow(): Promise<void> {
    const max = this.o.maxSessions ?? 200;
    while (this.entries.size > max) {
      let oldest: [string, Entry] | undefined;
      for (const kv of this.entries) if (!this.chains.has(kv[0]) && (!oldest || kv[1].lastUsed < oldest[1].lastUsed)) oldest = kv;
      if (!oldest) return;
      this.entries.delete(oldest[0]);
      await oldest[1].session.close("channel session evicted").catch(() => {});
    }
  }

  startSweeper(everyMs = 10 * 60_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweep(), everyMs);
    this.sweeper.unref?.();
  }

  async closeAll(): Promise<void> {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = undefined; }
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => e.session.close("channel stopped").catch(() => {})));
  }
}

// ---------- config loading ----------
const csv = (v: string | undefined): string[] => (v ? v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) : []);

function tiersFromEnv(env: NodeJS.ProcessEnv, prefix: string): Record<string, Tier> {
  const t: Record<string, Tier> = {};
  for (const id of csv(env[`${prefix}_STAFF_IDS`])) t[id] = "staff";
  for (const id of csv(env[`${prefix}_ADMIN_IDS`])) t[id] = "admin"; // admin wins over staff
  return t;
}

/** Build ChannelsConfig from ~/.mindclaw/channels.json (or MINDCLAW_CHANNELS_FILE) overlaid with env.
 *  Env wins. Tokens are never logged. */
export function loadChannelsConfig(env: NodeJS.ProcessEnv = process.env, file?: string): ChannelsConfig {
  const path = file ?? env.MINDCLAW_CHANNELS_FILE ?? join(homedir(), ".mindclaw", "channels.json");
  let fromFile: ChannelsConfig = {};
  try { fromFile = JSON.parse(readFileSync(path, "utf8")) as ChannelsConfig; } catch { /* absent or invalid: env only */ }
  const cfg: ChannelsConfig = { ...fromFile };

  if (env.TELEGRAM_BOT_TOKEN) {
    const prev = cfg.telegram;
    cfg.telegram = {
      ...prev, token: env.TELEGRAM_BOT_TOKEN,
      allowedChatIds: env.TELEGRAM_ALLOWED_CHAT_IDS ? csv(env.TELEGRAM_ALLOWED_CHAT_IDS) : prev?.allowedChatIds,
      tiers: { ...prev?.tiers, ...tiersFromEnv(env, "TELEGRAM") },
    };
  }
  if (env.DISCORD_BOT_TOKEN) {
    const prev = cfg.discord;
    cfg.discord = {
      ...prev, token: env.DISCORD_BOT_TOKEN,
      allowedChannelIds: env.DISCORD_ALLOWED_CHANNEL_IDS ? csv(env.DISCORD_ALLOWED_CHANNEL_IDS) : prev?.allowedChannelIds,
      tiers: { ...prev?.tiers, ...tiersFromEnv(env, "DISCORD") },
    };
  }
  if (env.SENDBLUE_API_KEY && env.SENDBLUE_API_SECRET && env.SENDBLUE_FROM_NUMBER) {
    const prev = cfg.imessage;
    cfg.imessage = {
      ...prev, apiKey: env.SENDBLUE_API_KEY, apiSecret: env.SENDBLUE_API_SECRET, fromNumber: env.SENDBLUE_FROM_NUMBER,
      webhookSecret: env.SENDBLUE_WEBHOOK_SECRET ?? prev?.webhookSecret,
      secretHeader: env.SENDBLUE_WEBHOOK_SECRET_HEADER ?? prev?.secretHeader,
      tiers: {
        ...prev?.tiers,
        ...Object.fromEntries(csv(env.SENDBLUE_STAFF_NUMBERS).map((n) => [n, "staff" as Tier])),
        ...Object.fromEntries(csv(env.SENDBLUE_ADMIN_NUMBERS).map((n) => [n, "admin" as Tier])),
      },
    };
  }
  if (env.MINDCLAW_WEBHOOK_SECRET) {
    const prev = cfg.webhook;
    cfg.webhook = {
      ...prev, secret: env.MINDCLAW_WEBHOOK_SECRET,
      tiers: { ...prev?.tiers, ...tiersFromEnv(env, "MINDCLAW_WEBHOOK") },
    };
  }
  return cfg;
}

/** Resolve the webhook registrar: injected, or the gateway's registerWebhook (lazy import). */
export async function resolveRegisterWebhook(deps: ChannelDeps | undefined): Promise<RegisterWebhookFn> {
  if (deps?.registerWebhook) return deps.registerWebhook;
  const mod = (await import("../gateway/index.ts")) as { registerWebhook?: RegisterWebhookFn };
  if (typeof mod.registerWebhook !== "function") throw new Error("gateway does not export registerWebhook");
  return mod.registerWebhook;
}

/** Normalize a gateway webhook request (rawBody/text/Buffer/object body) into text + parsed JSON. */
export function readWebhookBody(req: WebhookRequestLike): { raw: string; json: unknown } {
  let raw = "";
  if (typeof req.rawBody === "string") raw = req.rawBody;
  else if (typeof req.text === "string") raw = req.text;
  else if (Buffer.isBuffer(req.body)) raw = req.body.toString("utf8");
  else if (typeof req.body === "string") raw = req.body;
  else if (req.body !== undefined && req.body !== null) raw = JSON.stringify(req.body);
  let json: unknown;
  try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
  if (json === undefined && req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) json = req.body;
  return { raw, json };
}

export function headerValue(headers: WebhookRequestLike["headers"], name: string): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  }
  return "";
}

import { createHash, timingSafeEqual } from "node:crypto";
/** Constant-time string compare (hash first so lengths do not leak). */
export function secretsEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
