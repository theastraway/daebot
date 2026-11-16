// Offline router eval: tier accuracy of the rules router on the labelled scenarios, plus a cost estimate per arm from the policy's
// list prices (a fixed-tier arm vs the router) under a flat token assumption. Run: node src/eval/router/run.ts
import { classifyTurn, routeTurn } from "../../provider/router.ts";
import { DEFAULT_POLICY, TIER_ORDER } from "../../provider/policy.ts";
import type { ModelTier } from "../../types.ts";
import { ROUTER_SCENARIOS } from "./scenarios.ts";
import type { RouterScenario } from "./scenarios.ts";

export interface RouterEvalResult { total: number; correct: number; accuracy: number; misses: { id: string; expect: ModelTier; got: ModelTier; reason: string }[]; costPerTurnUsd: Record<string, number> }

const digestOf = (s: RouterScenario) => (s.digest ? { failedCalls: 0, blocks: 0, unverified: false, repeatHits: 0, badStreak: 0, ...s.digest } : undefined);

/** Accuracy of the rules router against the labels; `tokens` is the flat per-turn assumption for the cost columns (in, out). */
export function evaluateRouter(scenarios: RouterScenario[] = ROUTER_SCENARIOS, tokens = { in: 12_000, out: 1_500 }): RouterEvalResult {
  const misses: RouterEvalResult["misses"] = [];
  let correct = 0;
  const costOf = (tier: ModelTier) => (DEFAULT_POLICY[tier].priceIn * tokens.in + DEFAULT_POLICY[tier].priceOut * tokens.out) / 1_000_000;
  let routerCost = 0;
  for (const s of scenarios) {
    const c = classifyTurn({ message: s.message, digest: digestOf(s), canBuild: s.canBuild ?? true });
    const r = routeTurn({ message: s.message, digest: digestOf(s), canBuild: s.canBuild ?? true, mode: "shadow", policy: DEFAULT_POLICY })!;
    routerCost += costOf(r.tier);
    if (c.tier === s.expect) correct++; else misses.push({ id: s.id, expect: s.expect, got: c.tier, reason: c.reason });
  }
  const costPerTurnUsd: Record<string, number> = { router: routerCost / scenarios.length };
  for (const t of TIER_ORDER) costPerTurnUsd[`fixed:${t}`] = costOf(t);
  return { total: scenarios.length, correct, accuracy: scenarios.length ? correct / scenarios.length : 0, misses, costPerTurnUsd };
}

export function renderRouterEval(r: RouterEvalResult): string {
  const lines = [`router eval: ${r.correct}/${r.total} tiers right (${(r.accuracy * 100).toFixed(0)}%)`];
  for (const m of r.misses) lines.push(`  miss ${m.id}: expected ${m.expect}, got ${m.got} (${m.reason})`);
  lines.push("estimated cost per turn (USD, 12k in / 1.5k out):");
  for (const [k, v] of Object.entries(r.costPerTurnUsd)) lines.push(`  ${k.padEnd(16)} $${v.toFixed(4)}`);
  return lines.join("\n");
}

if (process.argv[1] && /run\.ts$/.test(process.argv[1])) {
  const r = evaluateRouter();
  process.stdout.write(renderRouterEval(r) + "\n");
  process.exit(r.misses.length ? 1 : 0);
}
