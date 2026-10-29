import type { Tool } from "../types.ts";
import { bashTool } from "./bash.ts";
import { processTool } from "./process.ts";
import { terminalTool } from "./terminal.ts";
import { editFileTool, globTool, grepTool, readFileTool, writeFileTool } from "./fs.ts";
import { createDecideTool } from "./decide.ts";
import { createWebFetchTool } from "./web.ts";
import { computerToolSupported, createComputerTool } from "./computer.ts";
import { appToolSupported, createAppTool } from "./app.ts";
import { appleCalendarTool } from "./apple-calendar.ts";

/** decisionKey: the server's OpenRouter key. Without one the `decide` tool is simply not offered.
 *  computer: screen control, on by default only on Windows (the hosted allowlist never lets it through).
 *  app: background UI Automation, same rule. */
export function createBuiltinTools(opts: { fetchImpl?: typeof fetch; decisionKey?: string; computer?: boolean; app?: boolean } = {}): Tool[] {
  // appleCalendarTool: offered per turn, only to a client that listed the apple_calendar capability (the loop filters it). It runs nothing on this host.
  const tools = [readFileTool, writeFileTool, editFileTool, globTool, grepTool, bashTool, processTool, terminalTool, createWebFetchTool(opts.fetchImpl), appleCalendarTool];
  // app (background UI Automation) is offered with, and listed before, the screen tool: Windows desktop app only.
  if (opts.app ?? appToolSupported()) tools.push(createAppTool());
  if (opts.computer ?? computerToolSupported()) tools.push(createComputerTool());
  if (opts.decisionKey) tools.push(createDecideTool({ fetchImpl: opts.fetchImpl, apiKey: opts.decisionKey }));
  return tools;
}

export { createProcessTool, ProcessRegistry } from "./process.ts";
export { createTerminalTool, TerminalRegistry } from "./terminal.ts";
export { readFileTool, writeFileTool, editFileTool, globTool, grepTool, bashTool };
export { createWebFetchTool, htmlToText } from "./web.ts";
export { createComputerTool, computerToolSupported } from "./computer.ts";
export { createAppTool, appToolSupported } from "./app.ts";
export { createDecideTool, DECISION_MODELS, DECISIONS_URL } from "./decide.ts";
export { createAppleCalendarTool, appleCalendarTool } from "./apple-calendar.ts";
