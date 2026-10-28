// loadConfig: environment first, then ~/.mindclaw/config.json (env wins). No secrets are ever
// printed or written by this module.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.ts";

const DEFAULTS = {
  mindBaseUrl: "https://m-i-n-d.ai/developer/v1",
  defaultModel: "qwen/qwen3.8-flash",
  cheapModel: "qwen/qwen3.8-flash",
  fallback: ["deepseek/deepseek-v4-flash"],
  maxToolRoundsPerTurn: 25,
  contextWindow: 128_000,
  compactAt: 0.6,
  // Explorer (free tier) model when DAEBOT_BILLING=mind. On MIND's free list (mindapp /llm-models, tier "free") and, per OpenRouter's
  // live model metadata (supported_parameters), one of the free models that supports tool calling, which the agent loop needs.
  // 262k context; the other free picks are smaller, vision/omni variants, or have no tool support.
  freeModel: "nvidia/nemotron-3-super-120b-a12b:free",
  // view_photo (src/tools/photo.ts). The chat model is text-first and answers an image with nothing, so photos are read by a
  // dedicated vision model. Measured live through MIND on a 1024x700 estimate: gemini-2.5-flash-lite read every line item exactly
  // in 2.4s for $0.000087; claude-haiku-5.5 was exact too in 8.1s for $0.00018. Explorer (free) users get the free gemma.
  visionModel: "google/gemini-2.5-flash-lite",
  visionFallback: ["anthropic/claude-haiku-5.5"],
  visionFreeModel: "google/gemma-4-31b-it:free",
};

function posInt(v: string | undefined): number | undefined {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 1000 ? Math.floor(n) : undefined;
}

function fraction(v: string | undefined): number | undefined {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0.1 && n <= 0.95 ? n : undefined;
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINDCLAW_CONFIG || join(env.HOME || homedir(), ".mindclaw", "config.json");
}

function readFileConfig(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  return out.length ? out : undefined;
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
}

function nameList(envVal: string | undefined, fileVal: unknown): string[] {
  if (envVal !== undefined && envVal.trim() !== "") return envVal.split(",").map((x) => x.trim()).filter(Boolean);
  return strList(fileVal) ?? [];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = readFileConfig(configFilePath(env));
  const fileModels = (file.models && typeof file.models === "object" ? file.models : {}) as Record<string, unknown>;

  const shadowEnv = env.MINDCLAW_SHADOW;
  const kernelEnv = env.MINDCLAW_KERNEL;
  const rounds = Number(env.MINDCLAW_MAX_TOOL_ROUNDS ?? file.maxToolRoundsPerTurn);

  const mindApiKey = str(env.MIND_API_KEY) ?? str(file.mindApiKey) ?? "";
  const visionFallback = nameList(env.DAEBOT_VISION_FALLBACK, undefined);
  return {
    mindBaseUrl: (str(env.MIND_BASE_URL) ?? str(file.mindBaseUrl) ?? DEFAULTS.mindBaseUrl).replace(/\/+$/, ""),
    mindApiKey,
    ...(str(env.MIND_BACKEND_URL) ?? str(file.mindBackendUrl) ? { mindBackendUrl: (str(env.MIND_BACKEND_URL) ?? str(file.mindBackendUrl))!.replace(/\/+$/, "") } : {}),
    mindSessionApiKey: str(env.MIND_SESSION_API_KEY) ?? str(file.mindSessionApiKey) ?? mindApiKey,
    clientNames: nameList(env.MINDCLAW_CLIENT_NAMES, file.clientNames),
    openrouterKey: str(env.OPENROUTER_API_KEY) ?? str(file.openrouterKey) ?? "",
    billing: (str(env.DAEBOT_BILLING) ?? str(file.billing) ?? "").toLowerCase() === "mind" ? "mind" : "openrouter",
    freeModel: str(env.DAEBOT_FREE_MODEL) ?? str(file.freeModel) ?? DEFAULTS.freeModel,
    vision: {
      model: str(env.DAEBOT_VISION_MODEL) ?? DEFAULTS.visionModel,
      fallback: visionFallback.length ? visionFallback : [...DEFAULTS.visionFallback],
      freeModel: str(env.DAEBOT_VISION_FREE_MODEL) ?? DEFAULTS.visionFreeModel,
    },
    models: {
      // The main model comes from the environment only (MINDCLAW_MODEL); a stray config file never picks it.
      default: str(env.MINDCLAW_MODEL) ?? DEFAULTS.defaultModel,
      cheap: str(env.MINDCLAW_CHEAP_MODEL) ?? str(fileModels.cheap) ?? DEFAULTS.cheapModel,
      fallback: strList(fileModels.fallback) ?? [...DEFAULTS.fallback],
    },
    shadow: shadowEnv !== undefined ? truthy(shadowEnv) : file.shadow === true,
    kernel: kernelEnv !== undefined ? kernelEnv.trim() !== "0" : file.kernel !== false,
    maxToolRoundsPerTurn: Number.isFinite(rounds) && rounds > 0 ? Math.floor(rounds) : DEFAULTS.maxToolRoundsPerTurn,
    contextWindow: posInt(env.MINDCLAW_CONTEXT_WINDOW) ?? DEFAULTS.contextWindow,
    compactAt: fraction(env.MINDCLAW_COMPACT_AT) ?? DEFAULTS.compactAt,
  };
}
