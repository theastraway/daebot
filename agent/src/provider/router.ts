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
  policy?: Record<ModelTier, TierSpec>;
  mode?: RouterMode;
}

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
  const floor = input.floor ?? "reflex";
  const ceiling = input.ceiling ?? "frontier";
  const c = classifyTurn(input);
  const tier = clampTier(higherTier(c.tier, floor), floor, ceiling);
  const spec = policy[tier];
  const effort = c.effort ?? spec.effort;
  const clamped = tier !== c.tier ? ` (clamped from ${c.tier} to the ${tierIndex(c.tier) > tierIndex(ceiling) ? "ceiling" : "floor"})` : "";
  return { tier, model: spec.model, ...(effort ? { effort } : {}), reason: `${c.reason}${clamped}`, source: "rules", applied: mode === "enforce" };
}

/** Rolls the digest forward with what the turn that just ended looked like. */
export function nextDigest(prev: TurnDigest | undefined, turn: { failedCalls: number; blocks: number; unverified: boolean; repeatHits: number; contextTokens?: number }): TurnDigest {
  const bad = turn.failedCalls > 0 || turn.blocks > 0 || turn.unverified || turn.repeatHits > 0;
  return { ...turn, badStreak: bad ? (prev?.badStreak ?? 0) + 1 : 0 };
}
