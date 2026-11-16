// The per-turn model router, v1: a rules pre-router over the user's message and a digest of the last turn, mapped through the policy
// table. No model call. It runs ONCE per typed user turn (never per step: per-step switching discards the prompt cache and, per the
// handoff-tax results, escalating a half-done trajectory recovers under half the gap), and it sits BELOW the floors: a bot's pinned
// model, the user's explicit pick for the chat, the free plan, a vision call. Mode: off | shadow (the decision is logged on the proof
// card, the configured model still runs) | enforce (the decision picks the model and the effort). Default shadow.
//
// Effort before model: when the rules want "more thinking" on a model that already has reasoning, raise the effort first.
// Start strong and downshift, never escalate mid-turn: a large build starts on the frontier tier; a small one on coder.
import type { Effort, ModelTier, RouteDecision } from "../types.ts";
import { higherTier, loadPolicy, tierIndex } from "./policy.ts";
import type { TierSpec } from "./policy.ts";
import { isTrivialMessage } from "../focus.ts";

export type RouterMode = "off" | "shadow" | "enforce";

export function routerMode(env: Record<string, string | undefined> = process.env): RouterMode {
  const v = (env.DAEBOT_ROUTER ?? "").trim().toLowerCase();
  if (v === "enforce" || v === "on" || v === "1") return "enforce";
  if (v === "off" || v === "0" || v === "false") return "off";
  return "shadow";
}

/** What the last turn looked like, from the loop's own records (never from message text). */
export interface TurnDigest {
  /** Tool calls that failed in the previous turn. */
  failedCalls: number;
  /** Kernel blocks in the previous turn. */
  blocks: number;
  /** The previous answer shipped with the unverified footer. */
  unverified: boolean;
  /** The repeat-call limit tripped in the previous turn. */
  repeatHits: number;
  /** Consecutive turns that went badly (reset on a good one). */
  badStreak: number;
  /** Tokens in the transcript now (compaction pressure). */
  contextTokens?: number;
  /** The tier the previous turn ran on (start strong, then downshift: a plan on the frontier hands the build down). */
  lastTier?: ModelTier;
}

export interface RouteInput {
  message: string;
  digest?: TurnDigest;
  /** The message carries an image: the vision model handles it, the router abstains. */
  hasPhoto?: boolean;
  /** The session offers build tools (bash, write_file or a GitHub write tool): without them a "build" is a conversation about code. */
  canBuild?: boolean;
  /** The highest tier this user may use (free plan: light; public tier: light; staff: reasoner; admin: frontier). */
  ceiling?: ModelTier;
  /** The lowest tier allowed (a desktop with no local model: reflex). Default reflex. */
  floor?: ModelTier;
  /** A delegating agent's tier for this piece (a handoff card): the floor for this turn. */
  hint?: ModelTier;
  /** A local model (ollama/...) that may take reflex and light work at zero spend. */
  localModel?: string;
  /** Why the ceiling is where it is, when it is not the identity (e.g. the frontier budget for today is spent). */
  ceilingReason?: string;
  policy?: Record<ModelTier, TierSpec>;
  mode?: RouterMode;
}

/** "go ahead", "do it", "proceed", "yes build it": the user approved the plan; the build moves down from the frontier. */
const APPROVAL = /^\s*(?:ok(?:ay)?|yes|yep|sure|sounds good|lgtm|approved|go|go ahead|do it|proceed|ship it|build it|make it so|let'?s (?:go|do it|build it)|please (?:go ahead|proceed|do it))\b[\s!.]*(?:(?:and|then|with|but)\b.*)?$/i;

const SECURITY = /\b(?:auth(?:entication|oriz\w+)?|login|session|password|secret|token|api ?key|permission|tier|payment|billing|stripe|checkout|refund|delete|drop table|migration|sql|shell|exec|eval|webhook|oauth|cookie|csrf|xss|injection)\b/i;
const LARGE = /\b(?:new (?:app|service|subsystem|module|product|feature set|platform)|from scratch|end[- ]to[- ]end|migrat\w+|rewrite|re-?architect\w*|across (?:repos|services|the codebase)|whole (?:app|codebase|system)|phase \d|roadmap|multi-?step|project plan|design (?:the|a) (?:system|architecture))\b/i;
const STANDARD = /\b(?:implement\w*|feature|refactor\w*|endpoint|api|schema|integration|integrate|build (?:a|an|the|me)|add (?:a|an|the) (?:tool|route|endpoint|page|screen|table|model|job|routine|command|flag|option)|several files|across files|module|library|package|deploy\w*|pipeline|ci\b|docker|kubernetes|infra\w*)\b/i;
const SMALL = /\b(?:fix(?:es|ed|ing)?|bug|typo|rename|small change|one[- ]line|quick (?:fix|change|edit)|tweak|adjust|update (?:the|a) (?:test|comment|label|copy|string|value|constant|version)|failing test|lint|typecheck|type error)\b/i;
const DEBUG = /\b(?:debug\w*|why (?:does|is|did|isn'?t|doesn'?t|won'?t)|not working|doesn'?t work|broken|crash\w*|stack ?trace|exception|error:|traceback|flaky|regression|root cause|intermittent)\b/i;
const REVIEW = /\b(?:review (?:this|the|my)? ?(?:code|diff|pr|change|changes|branch|design)|code ?review|security review|audit|verify (?:this|the)|adversarial|second opinion|find (?:bugs|problems|issues) in)\b/i;
const PLAN = /\b(?:plan (?:this|the|out|for)|make a plan|architecture|design doc|spec(?:ification)? for|break (?:this|it) down|phases|trade-?offs?|which approach|decide between)\b/i;
const CODEY = /\b(?:code|repo|repository|function|class|module|file|files|test|tests|script|bug|bugs|build|compile|deploy\w*|git|branch|commit|merge|diff|pr\b|prs\b|pull request|typescript|python|javascript|rust|go\b|sql|api|endpoint|json|yaml|docker|fix(?:es|ed|ing)?|typo|readme|lint|typecheck|refactor\w*|rename|implement\w*|feature|migration|migrate|crash\w*|config|review|version|dependency|dependencies|package|regression|release|ci\b|pipeline)\b/i;

const clampTier = (t: ModelTier, floor: ModelTier, ceiling: ModelTier): ModelTier =>
  tierIndex(t) < tierIndex(floor) ? floor : tierIndex(t) > tierIndex(ceiling) ? ceiling : t;

/** Classifies one user turn into a tier with a one-line reason. Pure; the policy maps the tier to a model. */
export function classifyTurn(input: RouteInput): { tier: ModelTier; effort?: Effort; reason: string } {
  const m = String(input.message ?? "");
  const d = input.digest;
  const stuck = !!d && (d.badStreak >= 2 || d.repeatHits > 0 || (d.unverified && d.failedCalls > 0));
  // Start strong and downshift: the plan was made on the frontier; the user's go sends the build to the reasoner (large) or coder (small).
  if (d?.lastTier === "frontier" && APPROVAL.test(m) && !stuck) return { tier: "reasoner", reason: "plan approved: downshift from the frontier to the reasoner for the build" };
  if (isTrivialMessage(m)) return { tier: "light", reason: "greeting or acknowledgement" };
  const codey = CODEY.test(m) || DEBUG.test(m);
  if (!codey) {
    if (m.length > 1200 || PLAN.test(m)) return { tier: "reasoner", reason: "long or planning ask with no code" };
    return { tier: "light", reason: "chat or lookup" };
  }
  if (!input.canBuild) {
    // Talking about code without build tools: a reasoner for debugging and review, light for the rest.
    if (DEBUG.test(m) || REVIEW.test(m) || PLAN.test(m)) return { tier: "reasoner", reason: stuck ? "debugging again after a failed turn" : "debugging, review or planning without build tools" };
    return { tier: "light", reason: "code question without build tools" };
  }
  if (LARGE.test(m) || (PLAN.test(m) && STANDARD.test(m))) return { tier: "frontier", effort: "medium", reason: "large build or a plan (Gate 1): start strong, hand the pieces down" };
  if (REVIEW.test(m)) return { tier: stuck ? "frontier" : "reasoner", effort: "high", reason: stuck ? "review after repeated failures" : "review: a search for what is wrong" };
  if (stuck) return { tier: "frontier", effort: "medium", reason: `stuck: ${d!.badStreak >= 2 ? `${d!.badStreak} bad turns in a row` : d!.repeatHits ? "repeat-call limit tripped" : "unverified answer after failures"}` };
  if (SECURITY.test(m)) return { tier: "reasoner", effort: "high", reason: "security-sensitive change: at least standard" };
  if (DEBUG.test(m)) return { tier: "reasoner", effort: "high", reason: d && d.failedCalls > 0 ? "debugging after a failed call" : "debugging" };
  if (STANDARD.test(m) && !SMALL.test(m)) return { tier: "reasoner", reason: "standard build: several files or a new behaviour" };
  if (SMALL.test(m)) return { tier: "coder", reason: "small fix: one module, tests exist" };
  if (STANDARD.test(m)) return { tier: "reasoner", reason: "standard build" };
  return { tier: "coder", reason: "code work, no size signal: coder tier, escalate at the next turn if it stalls" };
}

/** The route for one user turn: classify, clamp to floor and ceiling, map through the policy. undefined when the router is off or must abstain. */
export function routeTurn(input: RouteInput): RouteDecision | undefined {
  const mode = input.mode ?? routerMode();
  if (mode === "off" || input.hasPhoto) return undefined;
  const policy = input.policy ?? loadPolicy();
  const floor = input.hint ? higherTier(input.hint, input.floor ?? "reflex") : input.floor ?? "reflex";
  const ceiling = input.ceiling ?? "frontier";
  const c = input.hint ? { tier: input.hint, reason: `delegated piece: the handoff card asks for the ${input.hint} tier` } : classifyTurn(input);
  const tier = clampTier(higherTier(c.tier, floor), floor, ceiling);
  const spec = policy[tier];
  const effort = (c as { effort?: Effort }).effort ?? spec.effort;
  const clamped = tier !== c.tier ? ` (clamped from ${c.tier} to the ${tierIndex(c.tier) > tierIndex(ceiling) ? `ceiling${input.ceilingReason ? `: ${input.ceilingReason}` : ""}` : "floor"})` : "";
  // The local tier takes reflex and light work when a local model is there: zero spend, same answer class.
  if (input.localModel && (tier === "reflex" || tier === "light")) return { tier: "local", model: input.localModel, reason: `${c.reason}${clamped}; served locally`, source: "rules", applied: mode === "enforce" };
  return { tier, model: spec.model, ...(effort ? { effort } : {}), reason: `${c.reason}${clamped}`, source: "rules", applied: mode === "enforce" };
}

/** Rolls the digest forward with what the turn that just ended looked like. */
export function nextDigest(prev: TurnDigest | undefined, turn: { failedCalls: number; blocks: number; unverified: boolean; repeatHits: number; contextTokens?: number; lastTier?: ModelTier }): TurnDigest {
  const bad = turn.failedCalls > 0 || turn.blocks > 0 || turn.unverified || turn.repeatHits > 0;
  return { ...turn, badStreak: bad ? (prev?.badStreak ?? 0) + 1 : 0 };
}

/** A per-day budget for one tier's spend (the frontier): once spent, the router's ceiling drops to the tier below until tomorrow (UTC). */
export class TierBudget {
  readonly capUsd: number;
  private day = "";
  private spent = 0;
  private now: () => Date;
  constructor(capUsd: number, now: () => Date = () => new Date()) { this.capUsd = capUsd; this.now = now; }
  private roll(): void { const d = this.now().toISOString().slice(0, 10); if (d !== this.day) { this.day = d; this.spent = 0; } }
  add(usd: number): void { this.roll(); if (Number.isFinite(usd) && usd > 0) this.spent += usd; }
  total(): number { this.roll(); return this.spent; }
  exceeded(): boolean { this.roll(); return this.capUsd > 0 && this.spent >= this.capUsd; }
}

/** DAEBOT_FRONTIER_DAILY_USD: the frontier tier's budget per owner per day (default $5; 0 = no budget). */
export function frontierBudgetUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.DAEBOT_FRONTIER_DAILY_USD ?? "").trim();
  if (!raw) return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}
