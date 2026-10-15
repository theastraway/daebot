import { isAbsolute, resolve } from "node:path";
import type { ToolResult } from "../types.ts";

export const ok = (output: string, meta?: Record<string, unknown>): ToolResult => ({ ok: true, output, ...(meta ? { meta } : {}) });
export const fail = (message: string): ToolResult => ({ ok: false, output: message });

export function resolvePath(cwd: string, p: unknown): string | undefined {
  if (typeof p !== "string" || p === "") return undefined;
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n...[truncated ${text.length - max} chars]...\n${text.slice(text.length - tail)}`;
}

export function errMsg(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") return `not found: ${err.path ?? ""}`.trim();
  if (err?.code === "EISDIR") return `is a directory: ${err.path ?? ""}`.trim();
  if (err?.code === "EACCES") return `permission denied: ${err.path ?? ""}`.trim();
  return String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300);
}

// Glob -> RegExp. Supports **, *, ?, {a,b}, [abc]. Matches against forward-slash relative paths.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  let braces = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") { braces++; re += "(?:"; }
    else if (c === "}" && braces > 0) { braces--; re += ")"; }
    else if (c === "," && braces > 0) re += "|";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end > i) { re += glob.slice(i, end + 1); i = end; } else re += "\\[";
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`^${re}$`);
}
