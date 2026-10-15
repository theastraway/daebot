// Channel adapters entry point.
import type { ChannelAdapter } from "../types.ts";
import { DiscordAdapter } from "./discord.ts";
import { IMessageAdapter } from "./imessage.ts";
import { TelegramAdapter } from "./telegram.ts";
import { WebhookAdapter } from "./webhook.ts";
import { describeError } from "./common.ts";
import type { ChannelGateway, ChannelsConfig } from "./common.ts";

export type { ChannelsConfig, ChannelGateway, Tier } from "./common.ts";
export { loadChannelsConfig } from "./common.ts";

/** Returns only the adapters whose credentials are present in cfg. */
export function createChannels(cfg: ChannelsConfig): ChannelAdapter[] {
  const out: ChannelAdapter[] = [];
  const deps = cfg.deps ?? {};
  if (cfg.telegram?.token) out.push(new TelegramAdapter(cfg.telegram, deps));
  if (cfg.discord?.token) out.push(new DiscordAdapter(cfg.discord, deps));
  if (cfg.imessage?.apiKey && cfg.imessage.apiSecret && cfg.imessage.fromNumber) out.push(new IMessageAdapter(cfg.imessage, deps));
  if (cfg.webhook?.secret) out.push(new WebhookAdapter(cfg.webhook, deps));
  return out;
}

export interface StartResult { started: string[]; failed: { name: string; error: string }[] }

/** Start every adapter independently: one failing channel never blocks the others. Errors are secret-free. */
export async function startChannels(gateway: ChannelGateway, adapters: ChannelAdapter[], log?: (m: string) => void): Promise<StartResult> {
  const res: StartResult = { started: [], failed: [] };
  await Promise.all(adapters.map(async (a) => {
    try { await a.start(gateway); res.started.push(a.name); log?.(`channel started: ${a.name}`); }
    catch (e) { const error = describeError(e); res.failed.push({ name: a.name, error }); log?.(`channel failed: ${a.name}: ${error}`); }
  }));
  return res;
}

export async function stopChannels(adapters: ChannelAdapter[]): Promise<void> {
  await Promise.allSettled(adapters.map((a) => a.stop()));
}
