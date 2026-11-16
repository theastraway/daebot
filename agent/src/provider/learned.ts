// The learned part of the router, v0: a table fitted from the route log (DATA_DIR/routing/<owner>.jsonl), where every human turn's
// decision and proof are appended (no message text: a class label and a hash). For each (class, tier) with enough samples it holds
// the observed rate of verified answers and the mean cost; the router consults it to lift a class whose cheap tier keeps failing, or
// to drop a class whose expensive tier never had to be. It is deliberately a small Bayesian table, not a model: the data it needs
// (outcomes per tier) is what the shadow router has been logging since Phase 1b, and the table says when it has enough.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ModelTier, RouteDecision, TurnProof } from "../types.ts";
import { TIER_ORDER, tierIndex } from "./policy.ts";

export interface RouteLogRow {
  at: number;
  /** sha256 prefix of the message: lets a repeat be matched without keeping the text. */
  h: string;
  /** The classifier's class (the reason's first clause). */
  cls: string;
  tier: ModelTier;
  applied: boolean;
  model?: string;
  verified: boolean;
  failed: number;
  blocked: number;
  calls: number;
  costUsd?: number;
  /** Tokens the turn spent (every model call of the turn), when the provider reported them. */
  tokensIn?: number;
  tokensOut?: number;
  /** The session the turn belongs to (an id, never text). */
  session?: string;
}

export interface TierCost { turns: number; costUsd: number; tokensIn: number; tokensOut: number; verified: number }
export interface CostSummary {
  turns: number;
  costUsd: number;
  /** What the same turns would have cost on the frontier tier (tokens at frontier prices; without tokens, cost scaled by the output price ratio). */
  frontierUsd: number;
  /** Turns that could be priced for the counterfactual. */
  known: number;
  byTier: Record<string, TierCost>;
}

export const MIN_SAMPLES = 30;
export const classOf = (d: RouteDecision): string => d.reason.split(/[:;(]/)[0].trim().toLowerCase().slice(0, 60);
export const hashOf = (message: string): string => createHash("sha256").update(message).digest("hex").slice(0, 12);

export function routeLogPath(dataDir: string, owner: string): string {
  return join(dataDir, "routing", `${owner.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "_"}.jsonl`);
}

/** Appends one row. Never throws (a logging failure never touches a turn). */
export function appendRouteLog(file: string, row: RouteLogRow): void {
  try { mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 }); appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 }); } catch { /* best effort */ }
}

export function rowFor(message: string, d: RouteDecision, p: TurnProof, costUsd?: number, extra?: { tokensIn?: number; tokensOut?: number; session?: string }): RouteLogRow {
  return {
    at: p.at, h: hashOf(message), cls: classOf(d), tier: d.tier, applied: d.applied, ...(p.model ? { model: p.model } : {}), verified: p.verified, failed: p.failed, blocked: p.blocked, calls: p.calls, ...(costUsd !== undefined ? { costUsd } : {}),
    ...(extra?.tokensIn ? { tokensIn: extra.tokensIn } : {}), ...(extra?.tokensOut ? { tokensOut: extra.tokensOut } : {}), ...(extra?.session ? { session: extra.session } : {}),
  };
}

/** Parses route log text into rows, skipping anything malformed. */
export function parseRouteLog(text: string): RouteLogRow[] {
  const out: RouteLogRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line) as RouteLogRow; if (r && typeof r === "object" && typeof r.at === "number" && typeof r.tier === "string") out.push(r); } catch { /* skip */ }
  }
  return out;
}

/**
 * The token team's bill: turns and cost per tier (the tier the router chose; in shadow mode the configured model still ran), and the
 * all-frontier counterfactual the Altair "token team" screenshot shows ("$14.86 vs $93 all-Opus"). `since` keeps turns at or after it,
 * `session` keeps one session's. Prices are USD per 1M tokens, from the policy table.
 */
export function costSummary(text: string, o: { policy: Record<string, { model?: string; priceIn: number; priceOut: number }>; since?: number; session?: string; frontier?: string }): CostSummary {
  const fkey = o.frontier ?? "frontier";
  const fp = o.policy[fkey] ?? { priceIn: 0, priceOut: 0 };
  const sum: CostSummary = { turns: 0, costUsd: 0, frontierUsd: 0, known: 0, byTier: {} };
  for (const r of parseRouteLog(text)) {
    if (o.since !== undefined && r.at < o.since) continue;
    if (o.session !== undefined && r.session !== o.session) continue;
    const key = r.applied ? r.tier : (r.model && modelTier(o.policy, r.model)) || "light";
    const t = sum.byTier[key] ?? (sum.byTier[key] = { turns: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, verified: 0 });
    const cost = Number(r.costUsd) || 0;
    t.turns++; t.costUsd += cost; t.tokensIn += r.tokensIn || 0; t.tokensOut += r.tokensOut || 0; if (r.verified) t.verified++;
    sum.turns++; sum.costUsd += cost;
    if (r.tokensIn || r.tokensOut) { sum.frontierUsd += ((r.tokensIn || 0) * fp.priceIn + (r.tokensOut || 0) * fp.priceOut) / 1e6; sum.known++; }
    else if (cost > 0) { const tp = o.policy[key]; const base = tp && tp.priceOut > 0 ? tp.priceOut : fp.priceOut; sum.frontierUsd += cost * (fp.priceOut / base); sum.known++; }
  }
  const r4 = (n: number): number => Number(n.toFixed(4));
  sum.costUsd = r4(sum.costUsd); sum.frontierUsd = r4(sum.frontierUsd);
  for (const t of Object.values(sum.byTier)) t.costUsd = r4(t.costUsd);
  return sum;
}

/** The tier whose configured model this is, if any (shadow rows ran the configured model, not the router's pick). */
export function modelTier(policy: Record<string, { model?: string }>, model: string): string | undefined {
  for (const [tier, p] of Object.entries(policy)) if (p.model === model) return tier;
  return undefined;
}

export interface CellStat { n: number; verified: number; cost: number }
export type LearnedTable = Map<string, Map<ModelTier, CellStat>>;

/** Reads the log into (class -> tier -> stats). Only APPLIED rows count: in shadow mode the proof belongs to the configured model, not the decision. */
export function fitTable(text: string): LearnedTable {
  const t: LearnedTable = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: RouteLogRow;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || !r.applied || !r.cls || !TIER_ORDER.includes(r.tier)) continue;
    let byTier = t.get(r.cls);
    if (!byTier) { byTier = new Map(); t.set(r.cls, byTier); }
    const c = byTier.get(r.tier) ?? { n: 0, verified: 0, cost: 0 };
    c.n++; if (r.verified) c.verified++; c.cost += r.costUsd ?? 0;
    byTier.set(r.tier, c);
  }
  return t;
}

export function loadTable(file: string): LearnedTable {
  try { return fitTable(readFileSync(file, "utf8")); } catch { return new Map(); }
}

/**
 * What the table says about a class on a tier, with Laplace smoothing. `enough` = at least MIN_SAMPLES on that cell.
 * The router uses it as follows: a class whose chosen tier verifies under 60% with enough samples moves one tier up; a class whose
 * tier verifies over 95% with enough samples AND whose tier below also verifies over 90% with enough samples moves one tier down.
 */
export function adviseTier(t: LearnedTable, cls: string, tier: ModelTier): { tier: ModelTier; why?: string } {
  const byTier = t.get(cls);
  if (!byTier) return { tier };
  const rate = (x: ModelTier): { r: number; enough: boolean } => { const c = byTier.get(x); const n = c?.n ?? 0; return { r: (1 + (c?.verified ?? 0)) / (2 + n), enough: n >= MIN_SAMPLES }; };
  const here = rate(tier);
  const i = tierIndex(tier);
  if (here.enough && here.r < 0.6 && i < TIER_ORDER.length - 1) return { tier: TIER_ORDER[i + 1], why: `learned: ${cls} verified ${(here.r * 100).toFixed(0)}% on ${tier}` };
  if (i > 1) {
    const below = rate(TIER_ORDER[i - 1]);
    if (here.enough && here.r > 0.95 && below.enough && below.r > 0.9) return { tier: TIER_ORDER[i - 1], why: `learned: ${cls} verifies ${(below.r * 100).toFixed(0)}% one tier down` };
  }
  return { tier };
}

/** The table as text (GET /routing shows it): class, tier, n, verified rate, mean cost. */
export function describeTable(t: LearnedTable): string[] {
  const out: string[] = [];
  for (const [cls, byTier] of t) for (const [tier, c] of byTier) out.push(`${cls} on ${tier}: n=${c.n}, verified ${((c.verified / Math.max(1, c.n)) * 100).toFixed(0)}%, mean cost $${(c.cost / Math.max(1, c.n)).toFixed(4)}${c.n >= MIN_SAMPLES ? "" : " (not enough yet)"}`);
  return out;
}
