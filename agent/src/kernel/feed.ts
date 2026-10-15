import type { Gate, TurnState } from "../types.ts";
import { effectiveClass } from "../tool-class.ts";

const PUBLIC_INTENT = /\b(post|share|tweet|feed)\b/gi;
const NEGATORS = new Set(["not", "never", "no", "without", "dont", "cant", "wont"]);

function negated(before: string): boolean {
  const words = before.toLowerCase().replace(/[\u2018\u2019]/g, "'").split(/\s+/).filter(Boolean).slice(-3);
  return words.some((w) => {
    const bare = w.replace(/[^a-z']/g, "");
    return NEGATORS.has(bare.replace(/'/g, "")) || /n't$/.test(bare);
  });
}

// True when the user message contains post/share/tweet/feed that is not negated within the 3 words before it.
export function publicAllowed(s: TurnState): boolean {
  const msg = s.userMessage ?? "";
  for (const m of msg.matchAll(PUBLIC_INTENT)) {
    if (!negated(msg.slice(0, m.index))) return true;
  }
  return false;
}

export const feedGate: Gate = {
  name: "feed",
  preTool(s, call, tool) {
    if (effectiveClass(tool, call.args) !== "public" || publicAllowed(s)) return undefined;
    return {
      gate: "feed",
      action: "block",
      reason: `${call.name} publishes publicly and the user did not say post/share/tweet/feed: save it as a private entry instead`,
    };
  },
};
