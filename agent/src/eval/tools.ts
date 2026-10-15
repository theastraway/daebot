// Fake tools with the same names, classes and receipt kinds as the real ones. They never touch disk,
// network or MIND; they record every execution and return scripted output.
import type { Tool, ToolClass, ToolResult } from "../types.ts";
import type { ExecRecord, ToolOutput } from "./types.ts";

export interface ExecLog { records: ExecRecord[]; turn: number }

interface Def { name: string; cls: ToolClass; receipt?: "mind" | "surface"; fallback: string }

const DEFS: Def[] = [
  { name: "mind_context", cls: "read", receipt: "mind", fallback: "boot context loaded" },
  { name: "mind_query", cls: "read", receipt: "mind", fallback: "no matching entries" },
  { name: "mind_crm", cls: "read", receipt: "mind", fallback: "no contacts" },
  { name: "mind_agents", cls: "read", receipt: "mind", fallback: "no agents" },
  { name: "mind_sense", cls: "read", receipt: "mind", fallback: "state: calm" },
  { name: "mind_remember", cls: "write", fallback: "saved" },
  { name: "mind_folders", cls: "write", fallback: "folder updated" },
  { name: "mind_feed_post", cls: "public", fallback: "posted publicly" },
  { name: "send_email", cls: "outward", fallback: "email queued" },
  { name: "render_env_set", cls: "irreversible", fallback: "env var set" },
  { name: "write_file", cls: "write", fallback: "wrote file" },
  { name: "edit_file", cls: "write", fallback: "edited file" },
  { name: "bash", cls: "write", receipt: "surface", fallback: "exit 0" },
  { name: "read_file", cls: "read", receipt: "surface", fallback: "file contents" },
  { name: "glob", cls: "read", receipt: "surface", fallback: "no files" },
  { name: "grep", cls: "read", receipt: "surface", fallback: "no matches" },
  { name: "web_fetch", cls: "read", receipt: "surface", fallback: "page text" },
];

function toResult(o: string | ToolResult): ToolResult {
  return typeof o === "string" ? { ok: true, output: o } : o;
}

export function createFakeTools(log: ExecLog, outputs: Partial<Record<string, ToolOutput>> = {}): Tool[] {
  const counts = new Map<string, number>();
  return DEFS.map((d) => ({
    class: d.cls,
    receipt: d.receipt,
    spec: { name: d.name, description: `fake ${d.name}`, parameters: { type: "object", properties: {}, additionalProperties: true } },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const n = (counts.get(d.name) ?? 0) + 1;
      counts.set(d.name, n);
      const o = outputs[d.name];
      const res = toResult(typeof o === "function" ? o(args, n) : o ?? d.fallback);
      log.records.push({ tool: d.name, args, turn: log.turn, order: log.records.length, ok: res.ok });
      return res;
    },
  }));
}

// Output helper: first matching [pattern, output] wins on the query/question text, else `otherwise`.
export function byQuery(table: Array<[RegExp, string]>, otherwise = "no matching entries"): (args: Record<string, unknown>) => string {
  return (args) => {
    const q = String(args.query ?? args.question ?? args.q ?? "");
    for (const [re, out] of table) if (re.test(q)) return out;
    return otherwise;
  };
}
