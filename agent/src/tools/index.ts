import type { Tool } from "../types.ts";
import { bashTool } from "./bash.ts";
import { editFileTool, globTool, grepTool, readFileTool, writeFileTool } from "./fs.ts";
import { createWebFetchTool } from "./web.ts";

export function createBuiltinTools(opts: { fetchImpl?: typeof fetch } = {}): Tool[] {
  return [readFileTool, writeFileTool, editFileTool, globTool, grepTool, bashTool, createWebFetchTool(opts.fetchImpl)];
}

export { readFileTool, writeFileTool, editFileTool, globTool, grepTool, bashTool };
export { createWebFetchTool, htmlToText } from "./web.ts";
