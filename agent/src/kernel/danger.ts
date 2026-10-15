import type { Confirmation, Gate, TurnState } from "../types.ts";
import { effectiveClass } from "../tool-class.ts";
import { callSignature } from "./util.ts";

export const ACTION_PHRASE =
  /\b(send it|do it|do it now|go ahead|yes,? (run|send|do|delete|merge|deploy) (it|that)|run it now|approved?: ?(send|do|run)|confirm(ed)?)\b/i;

export function hasActionPhrase(msg: string): boolean {
  return ACTION_PHRASE.test(msg ?? "");
}

// Loop calls this when a new user message arrives (s.userMessageIndex already updated).
// Grants only confirmations proposed on an EARLIER user message, and only on an explicit action phrase.
export function grantIfAffirmed(s: TurnState, userMessage: string): Confirmation[] {
  const granted: Confirmation[] = [];
  if (!hasActionPhrase(userMessage)) return granted;
  for (const c of s.confirmations) {
    if (c.grantedAtUserMsg === undefined && s.userMessageIndex > c.proposedAtUserMsg) {
      c.grantedAtUserMsg = s.userMessageIndex;
      granted.push(c);
    }
  }
  return granted;
}

function describe(name: string, args: Record<string, unknown>): string {
  let a = JSON.stringify(args);
  if (a.length > 160) a = a.slice(0, 157) + "...";
  return `${name} ${a}`;
}

export const dangerGate: Gate = {
  name: "danger",
  preTool(s, call, tool) {
    const cls = effectiveClass(tool, call.args);
    if (cls !== "outward" && cls !== "irreversible") return undefined;
    const sig = callSignature(call.name, call.args);
    const mine = s.confirmations.filter((c) => c.forCallSignature === sig);
    // Approvals are single-use: an unused, validly granted confirmation lets exactly one call through.
    const usable = mine.find((c) => !c.used && c.grantedAtUserMsg !== undefined && c.grantedAtUserMsg > c.proposedAtUserMsg);
    if (usable) { usable.used = true; return undefined; }
    if (!mine.some((c) => c.grantedAtUserMsg === undefined)) {
      s.confirmations.push({ forCallSignature: sig, proposedAtUserMsg: s.userMessageIndex });
    }
    return {
      gate: "danger",
      action: "needs-confirmation",
      reason: `${cls} action needs your explicit go: ${describe(call.name, call.args)}. Reply 'send it' or 'do it' to run exactly this.`,
    };
  },
};
