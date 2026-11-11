import type { Config, Provider } from "../types.ts";
import { createOpenRouterProvider } from "./openrouter.ts";
import { MindCredits, createMindProvider } from "./mind.ts";
import { warmVisionCapabilities } from "./vision.ts";

export interface MindBillingWiring {
  /** The key this runtime bills to (live, so a rotated OAuth key is picked up). Default: cfg.mindApiKey. */
  getKey?: () => string;
  /** Tier + credits cache shared with the gateway. Default: a private one. */
  credits?: MindCredits;
}

/** DAEBOT_BILLING=mind -> every call goes through MIND with that runtime's own MIND key; otherwise OpenRouter with our key (unchanged). */
export function createProvider(cfg: Config, fetchImpl?: typeof fetch, mind?: MindBillingWiring): Provider {
  if (!fetchImpl) void warmVisionCapabilities(); // production only: tests inject fetch and never touch the network
  if (cfg.billing === "mind") {
    return createMindProvider(cfg, {
      getKey: mind?.getKey ?? (() => cfg.mindApiKey),
      credits: mind?.credits ?? new MindCredits({ mindBaseUrl: cfg.mindBaseUrl, fetchImpl }),
      fetchImpl,
    });
  }
  return createOpenRouterProvider(cfg, fetchImpl ?? fetch);
}

/** Tags every model call of one bot's sessions with the bot's slug (X-Daebot-Bot; the slug is the bot's identity on every device, its id is not) so MIND can apply that bot's spend cap and ledger its spend. */
export function withBot(provider: Provider, slug: string): Provider {
  return { ...provider, name: provider.name, stream: (req) => provider.stream({ ...req, bot: slug }) };
}

export function pickModel(cfg: Config, hint: "default" | "cheap"): string {
  return hint === "cheap" ? cfg.models.cheap : cfg.models.default;
}

export { createOpenRouterProvider, toWireMessages, ProviderHttpError } from "./openrouter.ts";
export { MindBillingError, MindCredits, createMindProvider } from "./mind.ts";
