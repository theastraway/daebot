import type { Gate, Tool } from "../types.ts";

const BOOT_TOOLS = new Set(["mind_context", "mind_sense", "mind_profile"]);

export function isBootTool(name: string): boolean {
  return BOOT_TOOLS.has(name);
}

export function allowedBeforeBoot(tools: Tool[]): Tool[] {
  return tools.filter((t) => BOOT_TOOLS.has(t.spec.name));
}

export const bootGate: Gate = {
  name: "boot",
  preTool(s, call) {
    if (s.booted || BOOT_TOOLS.has(call.name)) return undefined;
    return { gate: "boot", action: "block", reason: "boot first: call mind_context" };
  },
};
