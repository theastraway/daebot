// Generic JSON webhook channel. POST {conversationId, sender, text, callbackUrl?} with the shared secret header.
// Without callbackUrl the reply is returned in the HTTP response; with callbackUrl the call returns 202 and the
// reply is POSTed to that https URL as {conversationId, text, parts}. Original code.
import type { ChannelAdapter } from "../types.ts";
import { ConversationHub, describeError, headerValue, readWebhookBody, resolveRegisterWebhook, secretsEqual } from "./common.ts";
import type { ChannelDeps, ChannelGateway, WebhookChannelConfig, WebhookRequestLike, WebhookResponseLike } from "./common.ts";

export class WebhookAdapter implements ChannelAdapter {
  readonly name = "webhook";
  private cfg: WebhookChannelConfig;
  private deps: ChannelDeps;
  private f: typeof fetch;
  private hub?: ConversationHub;
  private unregister?: () => void;
  readonly pending = new Set<Promise<void>>();

  constructor(cfg: WebhookChannelConfig, deps: ChannelDeps = {}) {
    this.cfg = cfg; this.deps = deps; this.f = deps.fetch ?? fetch;
  }

  async start(gateway: ChannelGateway): Promise<void> {
    if (!this.cfg.secret) throw new Error("webhook channel: secret is required");
    this.hub = new ConversationHub({ surface: "webhook", gateway, policy: this.cfg, log: (m) => this.deps.log?.(m), now: this.deps.now });
    this.hub.startSweeper();
    const register = await resolveRegisterWebhook(this.deps);
    const un = register(this.cfg.channelName ?? "webhook", (req) => this.handleWebhook(req), { auth: "none" });
    if (typeof un === "function") this.unregister = un;
  }

  async stop(): Promise<void> {
    this.unregister?.(); this.unregister = undefined;
    await Promise.allSettled([...this.pending]);
    await this.hub?.closeAll();
  }

  private callbackOk(raw: string): URL | null {
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== "https:") return null;
    const hosts = this.cfg.allowedCallbackHosts;
    if (hosts && hosts.length && !hosts.includes(u.hostname)) return null;
    return u;
  }

  async handleWebhook(req: WebhookRequestLike): Promise<WebhookResponseLike> {
    if (req.method.toUpperCase() !== "POST") return { status: 405, body: { error: "method not allowed" } };
    if (!secretsEqual(headerValue(req.headers, this.cfg.secretHeader ?? "x-mindclaw-secret"), this.cfg.secret)) {
      return { status: 401, body: { error: "unauthorized" } };
    }
    const { json } = readWebhookBody(req);
    const b = (json ?? {}) as { conversationId?: unknown; sender?: unknown; text?: unknown; callbackUrl?: unknown };
    if (typeof b.conversationId !== "string" || typeof b.sender !== "string" || typeof b.text !== "string" || !b.conversationId || !b.sender || !b.text.trim()) {
      return { status: 400, body: { error: "expected JSON {conversationId, sender, text}" } };
    }
    const conversationId = b.conversationId;
    const msg = { conversationId: `wh:${conversationId}`, senderId: b.sender, text: b.text };
    const parts: string[] = [];
    const collect = async (md: string) => { parts.push(md); };

    if (typeof b.callbackUrl === "string") {
      const url = this.callbackOk(b.callbackUrl);
      if (!url) return { status: 400, body: { error: "callbackUrl must be https and on the allowed host list" } };
      const turn: Promise<void> = this.hub!.handle(msg, collect)
        .then(() => this.f(url.toString(), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId, text: parts.join("\n\n"), parts }),
        }).then(() => {}))
        .catch((e) => this.deps.log?.(`[webhook] callback failed: ${describeError(e, [this.cfg.secret])}`))
        .finally(() => this.pending.delete(turn));
      this.pending.add(turn);
      return { status: 202, body: { accepted: true } };
    }
    await this.hub!.handle(msg, collect);
    return { status: 200, body: { conversationId, text: parts.join("\n\n"), parts } };
  }
}
