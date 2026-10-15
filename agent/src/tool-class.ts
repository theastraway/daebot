// One place to read a tool's class for a specific call: `classFor?.(args) ?? class`.
import type { Tool, ToolClass } from "./types.ts";

export function effectiveClass(tool: Pick<Tool, "class" | "classFor">, args: Record<string, unknown> | undefined): ToolClass {
  if (tool.classFor) {
    try { return tool.classFor(args ?? {}) ?? tool.class; } catch { /* fall through to the static class */ }
  }
  return tool.class;
}
