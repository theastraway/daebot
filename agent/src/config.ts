// loadConfig: environment first, then ~/.mindclaw/config.json (env wins). No secrets are ever
// printed or written by this module.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./types.ts";

const DEFAULTS = {
  mindBaseUrl: "https://m-i-n-d.ai/developer/v1",
  defaultModel: "anthropic/claude-sonnet-4.5",
  cheapModel: "qwen/qwen3.8-flash",
  fallback: ["qwen/qwen3.8-flash"],
  maxToolRoundsPerTurn: 25,
};

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
  return {
    mindBaseUrl: (str(env.MIND_BASE_URL) ?? str(file.mindBaseUrl) ?? DEFAULTS.mindBaseUrl).replace(/\/+$/, ""),
    mindApiKey,
    mindSessionApiKey: str(env.MIND_SESSION_API_KEY) ?? str(file.mindSessionApiKey) ?? mindApiKey,
    clientNames: nameList(env.MINDCLAW_CLIENT_NAMES, file.clientNames),
    openrouterKey: str(env.OPENROUTER_API_KEY) ?? str(file.openrouterKey) ?? "",
    models: {
      default: str(env.MINDCLAW_MODEL) ?? str(fileModels.default) ?? DEFAULTS.defaultModel,
      cheap: str(env.MINDCLAW_CHEAP_MODEL) ?? str(fileModels.cheap) ?? DEFAULTS.cheapModel,
      fallback: strList(fileModels.fallback) ?? [...DEFAULTS.fallback],
    },
    shadow: shadowEnv !== undefined ? truthy(shadowEnv) : file.shadow === true,
    kernel: kernelEnv !== undefined ? kernelEnv.trim() !== "0" : file.kernel !== false,
    maxToolRoundsPerTurn: Number.isFinite(rounds) && rounds > 0 ? Math.floor(rounds) : DEFAULTS.maxToolRoundsPerTurn,
  };
}
