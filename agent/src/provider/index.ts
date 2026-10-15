import type { Config, Provider } from "../types.ts";
import { createOpenRouterProvider } from "./openrouter.ts";

export function createProvider(cfg: Config, fetchImpl?: typeof fetch): Provider {
  return createOpenRouterProvider(cfg, fetchImpl ?? fetch);
}

export function pickModel(cfg: Config, hint: "default" | "cheap"): string {
  return hint === "cheap" ? cfg.models.cheap : cfg.models.default;
}

export { createOpenRouterProvider, toWireMessages, ProviderHttpError } from "./openrouter.ts";
