import type { Gate, Tool, ToolClass } from "../types.ts";
import { effectiveClass } from "../tool-class.ts";

// Identity tiers. "public": read-only, no shell. "staff": read + local write, nothing that reaches a third party,
// is irreversible or publishes. "admin" (or no identity): everything.
export type Tier = "public" | "staff" | "admin";

const CLASSES: Record<Tier, ToolClass[] | undefined> = {
  public: ["read"],
  staff: ["read", "write"],
  admin: undefined,
};

export function parseTier(identity: string | undefined | null): Tier {
  if (identity === undefined || identity === null || identity === "") return "admin";
  const v = String(identity).trim().toLowerCase();
  if (v === "admin") return "admin";
  if (v === "staff") return "staff";
  return "public"; // unknown identities fail closed
}

export function tierAllows(tier: Tier, tool: Pick<Tool, "spec" | "class" | "classFor">, args?: Record<string, unknown>): boolean {
  const allowed = CLASSES[tier];
  if (!allowed) return true;
  if (tier === "public" && (tool.spec.name === "bash" || tool.spec.name === "process" || tool.spec.name === "decide")) return false; // decide spends the server's money
  // With no args (listing) judge by the loosest class the tool can take: static class, then classFor({}) is not trusted.
  return allowed.includes(args === undefined ? tool.class : effectiveClass(tool, args));
}

export function createTierGate(tier: Tier): Gate {
  return {
    name: "tier",
    preTool(_s, call, tool) {
      if (tierAllows(tier, tool, call.args)) return undefined;
      return { gate: "tier", action: "block", reason: `${call.name} is not available to ${tier} identities` };
    },
  };
}
