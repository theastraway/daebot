import type { Tool } from "../types.ts";
import { bashTool } from "./bash.ts";
import { editFileTool, globTool, grepTool, readFileTool, writeFileTool } from "./fs.ts";
import { createDecideTool } from "./decide.ts";
import { createWebFetchTool } from "./web.ts";

/** decisionKey: the server's OpenRouter key. Without one the `decide` tool is simply not offered. */
export function createBuiltinTools(opts: { fetchImpl?: typeof fetch; decisionKey?: string } = {}): Tool[] {
  const tools = [readFileTool, writeFileTool, editFileTool, globTool, grepTool, bashTool, createWebFetchTool(opts.fetchImpl)];
  if (opts.decisionKey) tools.push(createDecideTool({ fetchImpl: opts.fetchImpl, apiKey: opts.decisionKey }));
  return tools;
}

export { readFileTool, writeFileTool, editFileTool, globTool, grepTool, bashTool };
export { createWebFetchTool, htmlToText } from "./web.ts";
export { createDecideTool, DECISION_MODELS, DECISIONS_URL } from "./decide.ts";
