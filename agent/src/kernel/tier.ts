import type { Gate, Tool, ToolClass } from "../types.ts";
import { effectiveClass } from "../tool-class.ts";
import { coderAllows } from "./coder.ts";
import type { CoderGrant } from "./coder.ts";

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

export function tierAllows(tier: Tier, tool: Pick<Tool, "spec" | "class" | "classFor" | "mcp">, args?: Record<string, unknown>, coder?: CoderGrant): boolean {
  const allowed = CLASSES[tier];
  if (!allowed) return true;
  // Per-user coder grant (DAEBOT_CODERS): a staff user may run the listed GitHub write tools, only on repos matching their own globs.
  if (tier === "staff" && coder && tool.mcp && coderAllows(coder, tool, args)) return true;
  // mind_sessions: the user's own Agent Sessions (their Grok bots). Reads are plain reads; a reply is outward but stays inside the user's own MIND,
  // and the tool itself refuses any session the user does not own. The confirmation gate still asks before every reply.
  if (tool.spec.name === "mind_sessions") return tier === "staff"; // a public identity never reads the owner's agent sessions
  if (tier === "public" && (tool.spec.name === "bash" || tool.spec.name === "process" || tool.spec.name === "terminal" || tool.spec.name === "simulator" || tool.spec.name === "browser" || tool.spec.name === "decide")) return false; // decide spends the server's money; simulator is the owner's Mac
  // bot_manage deletes only the user's OWN bot (local, their own data) and always asks first (irreversible class), so staff may reach it.
  if (tier === "staff" && tool.spec.name === "bot_manage") return true;
  // With no args (listing) judge by the loosest class the tool can take: static class, then classFor({}) is not trusted.
  return allowed.includes(args === undefined ? tool.class : effectiveClass(tool, args));
}

export function createTierGate(tier: Tier, coder?: CoderGrant): Gate {
  return {
    name: "tier",
    preTool(_s, call, tool) {
      if (tierAllows(tier, tool, call.args, coder)) return undefined;
      return { gate: "tier", action: "block", reason: `${call.name} is not available to ${tier} identities` };
    },
  };
}
