// Discord adapter: raw Gateway (v10) websocket over Node's global WebSocket + REST. Original code.
// Protocol reference: https://discord.com/developers/docs/events/gateway (Hello/Identify/Heartbeat/Resume, close codes)
// and https://discord.com/developers/docs/topics/rate-limits (429 + retry_after).
import type { ChannelAdapter } from "../types.ts";
import { ConversationHub, describeError, formatForChannel, sleepReal } from "./common.ts";
import type { ChannelDeps, ChannelGateway, DiscordConfig } from "./common.ts";

// GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15, privileged: enable in the dev portal)
export const DISCORD_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const NO_RESUME_CLOSE = new Set([4007, 4009]);

interface DcUser { id: string; bot?: boolean; username?: string }
export interface DcMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: DcUser;
  mentions?: DcUser[];
  referenced_message?: { author?: DcUser } | null;
}
interface Frame { op: number; d?: any; s?: number | null; t?: string | null }

export class DiscordAdapter implements ChannelAdapter {
  readonly name = "discord";
  private cfg: DiscordConfig;
  private deps: ChannelDeps;
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private api: string;
  private hub?: ConversationHub;
  private running = false;
  private ws?: WebSocket;
  private gatewayUrl = "";
  private resumeUrl = "";
  private sessionId = "";
  private seq: number | null = null;
  private botId = "";
  private acked = true;
  private hbFirst?: ReturnType<typeof setTimeout>;
  private hbTimer?: ReturnType<typeof setInterval>;
  private readyResolve?: () => void;
  private readyReject?: (e: Error) => void;
  private reconnectAttempts = 0;

  constructor(cfg: DiscordConfig, deps: ChannelDeps = {}) {
    this.cfg = cfg; this.deps = deps;
    this.f = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? sleepReal;
    this.api = cfg.apiBase ?? "https://discord.com/api/v10";
  }

  private err(e: unknown) { return describeError(e, [this.cfg.token]); }
  private log(m: string) { this.deps.log?.(`[discord] ${m}`); }

  async start(gateway: ChannelGateway): Promise<void> {
    if (this.running) return;
    const WS = this.deps.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) throw new Error("discord: global WebSocket is unavailable (Node >= 22 required)");
    this.hub = new ConversationHub({ surface: "discord", gateway, policy: this.cfg, log: (m) => this.deps.log?.(m), now: this.deps.now });
    this.hub.startSweeper();
    this.gatewayUrl = this.cfg.gatewayUrl ?? (await this.discoverGateway());
    this.running = true;
    const ready = new Promise<void>((res, rej) => { this.readyResolve = res; this.readyReject = rej; });
    this.connect();
    await ready;
  }

  private async discoverGateway(): Promise<string> {
    try {
      const r = await this.rest("GET", "/gateway/bot");
      const j = (await r.json()) as { url?: string };
      if (j.url) return j.url;
    } catch (e) { this.log(`gateway discovery failed, using default: ${this.err(e)}`); }
    return "wss://gateway.discord.gg";
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopHeartbeat();
    try { this.ws?.close(1000); } catch { /* already closed */ }
    this.ws = undefined;
    this.readyReject?.(new Error("stopped"));
    await this.hub?.closeAll();
  }

  // ---------- gateway ----------
  private connect(): void {
    const WS = this.deps.WebSocket ?? (globalThis as { WebSocket: typeof WebSocket }).WebSocket;
    const base = this.sessionId && this.resumeUrl ? this.resumeUrl : this.gatewayUrl;
    const url = base.includes("?") ? base : `${base.replace(/\/$/, "")}/?v=10&encoding=json`;
    const ws = new WS(url);
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      let frame: Frame;
      try { frame = JSON.parse(String(ev.data)) as Frame; } catch { return; }
      this.onFrame(ws, frame);
    };
    ws.onclose = (ev: CloseEvent) => { if (this.ws === ws) void this.onClose(ev.code); };
    ws.onerror = () => { /* close follows; reconnect handled in onclose */ };
  }

  private send(ws: WebSocket, frame: Frame): void {
    try { ws.send(JSON.stringify(frame)); } catch (e) { this.log(`send failed: ${this.err(e)}`); }
  }

  private onFrame(ws: WebSocket, fr: Frame): void {
    if (typeof fr.s === "number") this.seq = fr.s;
    switch (fr.op) {
      case 10: { // Hello
        this.startHeartbeat(ws, Number(fr.d?.heartbeat_interval) || 41_250);
        if (this.sessionId && this.seq !== null) {
          this.send(ws, { op: 6, d: { token: this.cfg.token, session_id: this.sessionId, seq: this.seq } });
        } else this.identify(ws);
        break;
      }
      case 11: this.acked = true; break;
      case 1: this.send(ws, { op: 1, d: this.seq }); break;
      case 7: this.dropSocket(ws, 4000); break; // server asked us to reconnect: resume
      case 9: { // Invalid Session; d = resumable?
        if (fr.d === true) {
          this.send(ws, { op: 6, d: { token: this.cfg.token, session_id: this.sessionId, seq: this.seq } });
        } else {
          this.sessionId = ""; this.seq = null;
          void this.sleep(1000 + Math.floor(Math.random() * 4000)).then(() => { if (this.running && this.ws === ws) this.identify(ws); });
        }
        break;
      }
      case 0: this.onDispatch(fr); break;
      default: break;
    }
  }

  private identify(ws: WebSocket): void {
    this.send(ws, { op: 2, d: { token: this.cfg.token, intents: DISCORD_INTENTS, properties: { os: process.platform, browser: "mindclaw", device: "mindclaw" } } });
  }

  private onDispatch(fr: Frame): void {
    if (fr.t === "READY") {
      this.sessionId = String(fr.d?.session_id ?? "");
      this.resumeUrl = String(fr.d?.resume_gateway_url ?? "");
      this.botId = String(fr.d?.user?.id ?? "");
      this.reconnectAttempts = 0;
      this.readyResolve?.(); this.readyResolve = undefined;
    } else if (fr.t === "RESUMED") {
      this.reconnectAttempts = 0;
    } else if (fr.t === "MESSAGE_CREATE") {
      void this.dispatchMessage(fr.d as DcMessage);
    }
  }

  private startHeartbeat(ws: WebSocket, interval: number): void {
    this.stopHeartbeat();
    this.acked = true;
    const beat = () => {
      if (this.ws !== ws) return;
      if (!this.acked) { this.log("heartbeat not acknowledged; reconnecting"); this.dropSocket(ws, 4000); return; }
      this.acked = false;
      this.send(ws, { op: 1, d: this.seq });
    };
    this.hbFirst = setTimeout(() => { beat(); this.hbTimer = setInterval(beat, interval); this.hbTimer.unref?.(); }, Math.floor(interval * Math.random()));
    this.hbFirst.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.hbFirst) clearTimeout(this.hbFirst);
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbFirst = this.hbTimer = undefined;
  }

  /** Close the socket without clearing session state (non-1000 code keeps the session resumable). */
  private dropSocket(ws: WebSocket, code: number): void {
    try { ws.close(code); } catch { /* ignore */ }
    if (this.ws === ws) void this.onClose(code);
  }

  private async onClose(code: number): Promise<void> {
    this.stopHeartbeat();
    const ws = this.ws; this.ws = undefined; void ws;
    if (!this.running) return;
    if (FATAL_CLOSE.has(code)) {
      this.running = false;
      const m = `fatal gateway close ${code}`;
      this.log(m);
      this.readyReject?.(new Error(`discord: ${m}`));
      return;
    }
    if (NO_RESUME_CLOSE.has(code)) { this.sessionId = ""; this.seq = null; }
    const wait = Math.min(1000 * 2 ** this.reconnectAttempts++, 30_000);
    await this.sleep(wait);
    if (this.running && !this.ws) this.connect();
  }

  // ---------- messages ----------
  dispatchMessage(m: DcMessage): Promise<void> | undefined {
    if (!m || m.author?.bot || m.author?.id === this.botId) return;
    let text = m.content ?? "";
    if (m.guild_id) {
      if (this.cfg.allowedChannelIds?.length && !this.cfg.allowedChannelIds.includes(m.channel_id)) return;
      const mentioned = m.mentions?.some((u) => u.id === this.botId) || m.referenced_message?.author?.id === this.botId;
      if (!mentioned) return;
      text = text.replace(new RegExp(`<@!?${this.botId}>`, "g"), "").trim();
    }
    if (!text.trim()) return;
    return this.hub!.handle(
      { conversationId: `dc:${m.channel_id}`, senderId: m.author.id, senderName: m.author.username, text },
      (md) => this.sendText(m.channel_id, md),
      { typing: () => this.rest("POST", `/channels/${m.channel_id}/typing`).then(() => {}) },
    ).catch((e) => this.log(`turn error: ${this.err(e)}`));
  }

  private async sendText(channelId: string, markdown: string): Promise<void> {
    for (const content of formatForChannel("discord", markdown)) {
      await this.rest("POST", `/channels/${channelId}/messages`, { content, allowed_mentions: { parse: [] } });
    }
  }

  /** REST call with 429 retry_after handling. */
  private async rest(method: string, path: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await this.f(`${this.api}${path}`, {
        method,
        headers: { authorization: `Bot ${this.cfg.token}`, "content-type": "application/json", "user-agent": "DiscordBot (https://m-i-n-d.ai, 0.1)" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status !== 429) {
        if (!res.ok && res.status !== 204) throw new Error(`discord ${method} ${path}: HTTP ${res.status}`);
        return res;
      }
      let secs = Number(res.headers.get("retry-after")) || 0;
      try { const j = (await res.json()) as { retry_after?: number }; if (j.retry_after) secs = j.retry_after; } catch { /* header only */ }
      await this.sleep(Math.ceil((secs || 1) * 1000));
    }
    throw new Error(`discord ${method} ${path}: rate limited too many times`);
  }
}
