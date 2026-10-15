// iMessage adapter via Sendblue. Original code. Sources (official Sendblue docs, read 2026-10-15):
//  - Send:    POST {apiBase}/api/send-message, headers `sb-api-key-id` + `sb-api-secret-key`, JSON body
//             { number, from_number (REQUIRED, E.164), content (<=18996 chars) }
//             https://docs.sendblue.com/api/resources/messages/methods/send/  (examples use https://api.sendblue.co;
//             the webhook guide uses https://api.sendblue.com, so apiBase is configurable)
//  - Receive: Sendblue POSTs JSON to the account's `receive` webhook. Payload fields used: content, is_outbound,
//             number (the END USER, E.164), to_number (our line), message_handle (dedupe key), group_id.
//             https://docs.sendblue.com/getting-started/webhooks/
//  - Auth:    the docs say a configured webhook secret is "included in the webhook request headers" but do NOT name
//             the header. Default here is `sb-signing-secret`; set secretHeader to match your account. Verified with
//             a constant-time compare. Without a secret the adapter refuses to start (unless allowUnauthenticated).
import type { ChannelAdapter } from "../types.ts";
import {
  ConversationHub, describeError, formatForChannel, headerValue, readWebhookBody, resolveRegisterWebhook, secretsEqual,
} from "./common.ts";
import type { ChannelDeps, ChannelGateway, IMessageConfig, WebhookRequestLike, WebhookResponseLike } from "./common.ts";

interface SendblueInbound {
  content?: string; is_outbound?: boolean; number?: string; to_number?: string; message_handle?: string; group_id?: string;
}

export class IMessageAdapter implements ChannelAdapter {
  readonly name = "imessage";
  private cfg: IMessageConfig;
  private deps: ChannelDeps;
  private f: typeof fetch;
  private hub?: ConversationHub;
  private unregister?: () => void;
  private seen = new Set<string>();
  readonly pending = new Set<Promise<void>>(); // in-flight turns (tests await these)

  constructor(cfg: IMessageConfig, deps: ChannelDeps = {}) {
    this.cfg = cfg; this.deps = deps; this.f = deps.fetch ?? fetch;
  }

  private err(e: unknown) { return describeError(e, [this.cfg.apiKey, this.cfg.apiSecret, this.cfg.webhookSecret]); }
  private log(m: string) { this.deps.log?.(`[imessage] ${m}`); }

  async start(gateway: ChannelGateway): Promise<void> {
    if (!this.cfg.webhookSecret && !this.cfg.allowUnauthenticated) {
      throw new Error("imessage: webhookSecret is required (set SENDBLUE_WEBHOOK_SECRET) or allowUnauthenticated:true for dev");
    }
    this.hub = new ConversationHub({ surface: "imessage", gateway, policy: this.cfg, log: (m) => this.deps.log?.(m), now: this.deps.now });
    this.hub.startSweeper();
    const register = await resolveRegisterWebhook(this.deps);
    const un = register("imessage", (req) => this.handleWebhook(req), { auth: "none" });
    if (typeof un === "function") this.unregister = un;
  }

  async stop(): Promise<void> {
    this.unregister?.(); this.unregister = undefined;
    await Promise.allSettled([...this.pending]);
    await this.hub?.closeAll();
  }

  /** Webhook entry point (exposed for tests). */
  async handleWebhook(req: WebhookRequestLike): Promise<WebhookResponseLike> {
    if (req.method.toUpperCase() !== "POST") return { status: 405, body: { error: "method not allowed" } };
    if (!this.cfg.allowUnauthenticated) {
      const got = headerValue(req.headers, this.cfg.secretHeader ?? "sb-signing-secret");
      if (!secretsEqual(got, this.cfg.webhookSecret ?? "")) return { status: 401, body: { error: "unauthorized" } };
    }
    const { json } = readWebhookBody(req);
    const p = (json ?? {}) as SendblueInbound;
    if (p.is_outbound === true) return { status: 200, body: { ok: true, ignored: "outbound" } };
    if (p.group_id) return { status: 200, body: { ok: true, ignored: "group" } };
    const sender = typeof p.number === "string" ? p.number : "";
    const text = typeof p.content === "string" ? p.content : "";
    if (!sender || !text.trim()) return { status: 200, body: { ok: true, ignored: "empty" } };
    if (p.message_handle) {
      if (this.seen.has(p.message_handle)) return { status: 200, body: { ok: true, duplicate: true } };
      this.seen.add(p.message_handle);
      if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value as string);
    }
    // Acknowledge fast; the turn runs in the background and replies via the REST API.
    const turn: Promise<void> = this.hub!
      .handle({ conversationId: `im:${sender}`, senderId: sender, text }, (md) => this.sendText(sender, md))
      .catch((e) => this.log(`turn error: ${this.err(e)}`))
      .finally(() => this.pending.delete(turn));
    this.pending.add(turn);
    return { status: 200, body: { ok: true } };
  }

  private async sendText(to: string, markdown: string): Promise<void> {
    for (const content of formatForChannel("imessage", markdown)) {
      const res = await this.f(`${this.cfg.apiBase ?? "https://api.sendblue.co"}/api/send-message`, {
        method: "POST",
        headers: { "content-type": "application/json", "sb-api-key-id": this.cfg.apiKey, "sb-api-secret-key": this.cfg.apiSecret },
        body: JSON.stringify({ number: to, from_number: this.cfg.fromNumber, content }),
      });
      if (!res.ok) throw new Error(`sendblue send-message: HTTP ${res.status}`);
    }
  }
}
