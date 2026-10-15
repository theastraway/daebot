// Telegram adapter: Bot API long-polling over fetch. Original code.
// API reference: https://core.telegram.org/bots/api (getUpdates, sendMessage, sendChatAction, getMe).
import type { ChannelAdapter } from "../types.ts";
import { ConversationHub, describeError, formatForChannel, sleepReal } from "./common.ts";
import type { ChannelDeps, ChannelGateway, TelegramConfig } from "./common.ts";

interface TgUser { id: number; is_bot?: boolean; username?: string; first_name?: string }
interface TgEntity { type: string; offset: number; length: number; user?: TgUser }
interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TgUser;
  chat: { id: number; type: string; title?: string };
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  reply_to_message?: { from?: TgUser };
}
interface TgUpdate { update_id: number; message?: TgMessage }
interface TgResponse<T> { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } }

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram";
  private cfg: TelegramConfig;
  private deps: ChannelDeps;
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private base: string;
  private hub?: ConversationHub;
  private abort?: AbortController;
  private loop?: Promise<void>;
  private running = false;
  private botId = 0;
  private botUsername = "";
  private allowed: Set<string>;
  offset = 0; // exposed for tests

  constructor(cfg: TelegramConfig, deps: ChannelDeps = {}) {
    this.cfg = cfg;
    this.deps = deps;
    this.f = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? sleepReal;
    this.base = `${cfg.apiBase ?? "https://api.telegram.org"}/bot${cfg.token}`;
    this.allowed = new Set((cfg.allowedChatIds ?? []).map(String));
  }

  private err(e: unknown): string { return describeError(e, [this.cfg.token]); }
  private log(m: string) { this.deps.log?.(`[telegram] ${m}`); }

  private async api<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.f(`${this.base}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
    });
    let data: TgResponse<T>;
    try { data = (await res.json()) as TgResponse<T>; } catch { throw new Error(`telegram ${method}: HTTP ${res.status} (non-JSON)`); }
    if (!data.ok) {
      const e = new Error(`telegram ${method}: ${data.error_code ?? res.status} ${data.description ?? ""}`.trim()) as Error & { retryAfter?: number; code?: number };
      e.retryAfter = data.parameters?.retry_after; e.code = data.error_code ?? res.status;
      throw e;
    }
    return data.result as T;
  }

  async start(gateway: ChannelGateway): Promise<void> {
    if (this.running) return;
    const me = await this.api<TgUser>("getMe", {}).catch((e) => { throw new Error(`telegram getMe failed: ${this.err(e)}`); });
    this.botId = me.id; this.botUsername = (me.username ?? "").toLowerCase();
    this.hub = new ConversationHub({ surface: "telegram", gateway, policy: this.cfg, log: (m) => this.deps.log?.(m), now: this.deps.now });
    this.hub.startSweeper();
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop?.catch(() => {});
    await this.hub?.closeAll();
  }

  private async poll(): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      try {
        const updates = await this.api<TgUpdate[]>("getUpdates", {
          offset: this.offset, timeout: this.cfg.pollTimeoutSec ?? 30, allowed_updates: ["message"],
        }, this.abort?.signal);
        backoff = 1000;
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1); // advance before dispatch: never re-deliver
          if (u.message) this.dispatch(u.message);
        }
      } catch (e) {
        if (!this.running) return;
        const ra = (e as { retryAfter?: number }).retryAfter;
        const wait = ra ? ra * 1000 : backoff;
        this.log(`poll error (retry in ${wait}ms): ${this.err(e)}`);
        backoff = Math.min(backoff * 2, 30_000);
        await this.sleep(wait);
      }
    }
  }

  /** Decide whether to respond, extract text, and run the turn. Exposed for tests. */
  dispatch(m: TgMessage): Promise<void> | undefined {
    const raw = m.text ?? m.caption;
    if (!raw || !m.from || m.from.is_bot) return;
    const chatId = String(m.chat.id);
    if (this.allowed.size && !this.allowed.has(chatId)) return;
    let text = raw;
    const isPrivate = m.chat.type === "private";
    if (!isPrivate) {
      const ents = m.entities ?? m.caption_entities ?? [];
      const mention = ents.find((e) => {
        if (e.type === "mention") return raw.slice(e.offset, e.offset + e.length).toLowerCase() === `@${this.botUsername}`;
        return e.type === "text_mention" && e.user?.id === this.botId;
      });
      const repliedToBot = m.reply_to_message?.from?.id === this.botId;
      if (!mention && !repliedToBot) return;
      if (mention) text = (raw.slice(0, mention.offset) + raw.slice(mention.offset + mention.length)).trim();
    }
    const conv = `tg:${chatId}${m.message_thread_id ? ":" + m.message_thread_id : ""}`;
    const send = (markdown: string) => this.sendText(m.chat.id, markdown, m.message_thread_id);
    return this.hub!.handle(
      { conversationId: conv, senderId: String(m.from.id), senderName: m.from.username ?? m.from.first_name, text },
      send,
      { typing: () => this.api("sendChatAction", { chat_id: m.chat.id, action: "typing", ...(m.message_thread_id ? { message_thread_id: m.message_thread_id } : {}) }).then(() => {}) },
    ).catch((e) => this.log(`turn error: ${this.err(e)}`));
  }

  private async sendText(chatId: number, markdown: string, threadId?: number): Promise<void> {
    for (const html of formatForChannel("telegram", markdown)) {
      const base = { chat_id: chatId, ...(threadId ? { message_thread_id: threadId } : {}) };
      await this.sendOne({ ...base, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } }, html);
    }
  }

  private async sendOne(payload: Record<string, unknown>, htmlPiece: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await this.api("sendMessage", payload); return; }
      catch (e) {
        const ee = e as { retryAfter?: number; code?: number; message?: string };
        if (ee.retryAfter) { await this.sleep(ee.retryAfter * 1000); continue; }
        if (ee.code === 400 && /parse entities/i.test(ee.message ?? "") && payload.parse_mode) {
          // HTML subset rejected: resend this piece as plain text (tags stripped)
          const { parse_mode: _p, link_preview_options: _l, ...rest } = payload;
          await this.api("sendMessage", { ...rest, text: htmlPiece.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").slice(0, 4096) });
          return;
        }
        throw e;
      }
    }
  }
}
