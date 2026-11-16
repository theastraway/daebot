// Labelled user turns for the router eval: what tier a careful engineer would pick, and why. Pure data. The offline run measures
// the rules router against these; the live run (later) replays them on fixed-model arms and the router arm and compares cost per
// completed task. Add a row when the router gets a real message wrong.
import type { ModelTier } from "../../types.ts";
import type { TurnDigest } from "../../provider/router.ts";

export interface RouterScenario { id: string; message: string; expect: ModelTier; canBuild?: boolean; digest?: Partial<TurnDigest>; why: string }

export const ROUTER_SCENARIOS: RouterScenario[] = [
  { id: "greeting", message: "hey, how's it going?", expect: "light", why: "a greeting never needs reasoning" },
  { id: "lookup", message: "what's the weather in Austin tomorrow", expect: "light", why: "a lookup is a tool call and a sentence" },
  { id: "mind-read", message: "what did I decide about the Kerner retainer last week", expect: "light", why: "a MIND read" },
  { id: "typo", message: "fix the typo in the README heading", expect: "coder", canBuild: true, why: "trivial change: one file" },
  { id: "small-fix", message: "the failing test in test/core/config.test.ts is a wrong default, fix it", expect: "coder", canBuild: true, why: "small: one module, test exists" },
  { id: "rename", message: "rename the helper oneLine to singleLine across the learn module", expect: "coder", canBuild: true, why: "small mechanical change" },
  { id: "feature", message: "implement a /routing endpoint on the gateway that returns the policy table", expect: "reasoner", canBuild: true, why: "standard: new behaviour across files" },
  { id: "security", message: "add a login endpoint that sets the session cookie", expect: "reasoner", canBuild: true, why: "security trigger forces standard" },
  { id: "debug", message: "the deploy is crashing with ECONNRESET on boot, why does it happen only on Render", expect: "reasoner", canBuild: true, why: "debugging" },
  { id: "debug-no-tools", message: "why is my React effect running twice in dev", expect: "reasoner", canBuild: false, why: "debugging without build tools still needs reasoning" },
  { id: "review", message: "review this diff for silent failures before I merge", expect: "reasoner", canBuild: true, why: "a review is a search for what is wrong" },
  { id: "large", message: "build the new billing subsystem end to end: plans, invoices, Stripe webhooks, and the admin screens", expect: "frontier", canBuild: true, why: "large: a plan first, on the strongest model" },
  { id: "migration", message: "migrate the sessions store from JSON files to SQLite with a rollback path", expect: "frontier", canBuild: true, why: "migration is large" },
  { id: "plan", message: "plan out how we should re-architect the gateway into services, with trade-offs", expect: "reasoner", canBuild: false, why: "planning with no build tools: reasoner" },
  { id: "stuck", message: "try the fix again", expect: "frontier", canBuild: true, digest: { badStreak: 2, failedCalls: 2, blocks: 0, unverified: true, repeatHits: 1 }, why: "two bad turns in a row: escalate at the turn boundary" },
  { id: "chat-code-question", message: "what does a TypeScript discriminated union look like", expect: "light", canBuild: false, why: "a code question, not code work" },
  { id: "long-essay", message: "write a thorough comparison of the three pricing strategies we discussed, with the trade-offs for each customer segment, and a recommendation. " + "Cover churn, upsell, support load, and margin. ".repeat(20), expect: "reasoner", why: "a long reasoning ask with no code" },
];
