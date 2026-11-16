// The model policy table: which tier runs what, and which model each tier is today. A readable table on purpose (Arch-Router's
// lesson: a policy people can read and change beats a learned black box): the operator overrides any tier's model with env
// DAEBOT_TIER_<NAME> (DAEBOT_TIER_CODER=qwen/qwen3-coder-next) or a JSON file at DAEBOT_ROUTING_POLICY. Prices here are
// OpenRouter list prices (USD per 1M tokens, in/out) read on Nov 15, 2026 and used only for the eval's cost estimates.
import type { Effort, ModelTier } from "../types.ts";

export interface TierSpec {
  tier: ModelTier;
  model: string;
  /** What the tier is for, in one line (shown on the proof card and in the policy dump). */
  use: string;
  /** Default reasoning effort for the tier's model (undefined = send none). */
  effort?: Effort;
  /** USD per 1M input / output tokens, for estimates only. */
  priceIn: number;
  priceOut: number;
}

export const TIER_ORDER: readonly ModelTier[] = ["local", "reflex", "light", "coder", "reasoner", "frontier"];

export const DEFAULT_POLICY: Record<ModelTier, TierSpec> = {
  local:    { tier: "local",    model: "ollama/qwen3.8-flash-next:125b-mlx", use: "the user's own machine (desktop and self-host only): free chat and lookups", priceIn: 0, priceOut: 0 },
  reflex:   { tier: "reflex",   model: "qwen/qwen3.7-flash",     use: "compaction, reflection, reply suggestions, classifying", effort: "low", priceIn: 0.03, priceOut: 0.13 },
  light:    { tier: "light",    model: "qwen/qwen3.8-flash",     use: "chat, lookups, MIND reads, small edits of text", priceIn: 0.15, priceOut: 0.47 },
  coder:    { tier: "coder",    model: "qwen/qwen3-coder-next",  use: "trivial and small builds: one module, a clear fix, tests exist", priceIn: 0.12, priceOut: 0.80 },
  reasoner: { tier: "reasoner", model: "deepseek/deepseek-v4-pro", use: "standard builds, debugging, review, multi-file changes", effort: "high", priceIn: 0.90, priceOut: 1.50 },
  frontier: { tier: "frontier", model: "anthropic/claude-fable-5.2", use: "large builds, Gate 1 plans, adversarial verification, repeated failures", effort: "medium", priceIn: 8, priceOut: 40 },
};

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;

/** The policy in force: defaults, then the JSON file, then per-tier env overrides. Bad values are ignored (the default stays). */
export function loadPolicy(env: Record<string, string | undefined> = process.env, readFile?: (p: string) => string): Record<ModelTier, TierSpec> {
  const out: Record<ModelTier, TierSpec> = { ...DEFAULT_POLICY };
  const file = (env.DAEBOT_ROUTING_POLICY ?? "").trim();
  if (file && readFile) {
    try {
      const j = JSON.parse(readFile(file)) as Record<string, Partial<TierSpec>>;
      for (const t of TIER_ORDER) {
        const v = j?.[t];
        if (!v || typeof v !== "object") continue;
        out[t] = { ...out[t], ...(typeof v.model === "string" && MODEL_RE.test(v.model) ? { model: v.model } : {}), ...(typeof v.use === "string" ? { use: v.use.slice(0, 200) } : {}), ...(v.effort === "low" || v.effort === "medium" || v.effort === "high" ? { effort: v.effort } : {}) };
      }
    } catch { /* a broken file keeps the defaults */ }
  }
  for (const t of TIER_ORDER) {
    const m = (env[`DAEBOT_TIER_${t.toUpperCase()}`] ?? "").trim();
    if (m && MODEL_RE.test(m)) out[t] = { ...out[t], model: m };
  }
  return out;
}

export const tierIndex = (t: ModelTier): number => TIER_ORDER.indexOf(t);
export const higherTier = (a: ModelTier, b: ModelTier): ModelTier => (tierIndex(a) >= tierIndex(b) ? a : b);

/** The policy as a short text block (the proof card's tooltip, the policy endpoint, logs). */
export function describePolicy(p: Record<ModelTier, TierSpec>): string {
  return TIER_ORDER.map((t) => `${t}: ${p[t].model}${p[t].effort ? ` (effort ${p[t].effort})` : ""}: ${p[t].use}`).join("\n");
}
