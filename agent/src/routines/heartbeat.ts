// The Heartbeat's cheap check. No model is involved: it reads what the gateway already knows about a bot (its threads, board rows and
// routines), boils it to a fingerprint, and lists what needs a manager's attention. The model only runs when the fingerprint moved.
import { createHash } from "node:crypto";
import type { Routine } from "./store.ts";

export interface ThreadLite { id: string; title: string; updatedAt: number; surface?: string; peer?: string }
export interface BoardLite { sessionId: string; id: string; title: string; status: string; question?: string; updatedAt: number }

export interface Probe {
  /** Changes whenever something a manager would look at changed. */
  fp: string;
  /** One line per item that needs attention. Empty = nothing is waiting. */
  attention: string[];
  threads: number;
}

export const STALL_MS = 20 * 60_000;
const BUCKET_MS = 6 * 3_600_000;

/** Threads the user talks in: not routine runs, not the heartbeat, not bot-to-bot DMs. */
export function humanThreads(rows: ThreadLite[]): ThreadLite[] {
  return rows.filter((t) => !t.peer && t.surface !== "routine");
}

export function probeBot(a: { threads: ThreadLite[]; board: BoardLite[]; routines: Routine[]; now: number }): Probe {
  const human = humanThreads(a.threads);
  const ids = new Set(human.map((t) => t.id));
  const title = new Map(human.map((t) => [t.id, t.title || "Untitled"]));
  const attention: string[] = [];
  const parts: string[] = [];
  for (const t of human) parts.push(`t:${t.id}:${t.updatedAt}`);
  for (const b of a.board) {
    if (!ids.has(b.sessionId)) continue;
    parts.push(`b:${b.sessionId}:${b.id}:${b.status}`);
    if (b.status === "stopped") attention.push(`Thread "${title.get(b.sessionId)}" is stopped, waiting on the user${b.question ? `: ${b.question.slice(0, 120)}` : ""}`);
    else if (b.status === "not_started") attention.push(`Thread "${title.get(b.sessionId)}": task "${b.title.slice(0, 80)}" has not started`);
    else if (b.status === "in_progress" && a.now - b.updatedAt > STALL_MS) attention.push(`Thread "${title.get(b.sessionId)}": task "${b.title.slice(0, 80)}" looks stalled (no change for ${Math.round((a.now - b.updatedAt) / 60000)} min)`);
  }
  for (const r of a.routines) {
    parts.push(`r:${r.id}:${r.updatedAt}:${r.enabled ? 1 : 0}`);
    if (r.lastStatus === "error" && r.lastRunAt) { parts.push(`re:${r.id}:${r.lastRunAt}`); attention.push(`Routine "${r.name}" failed on its last run${r.lastResult ? `: ${r.lastResult.slice(0, 120)}` : ""}`); }
  }
  // Items that are still waiting get looked at again every 6 hours even when nothing else moved.
  if (attention.length) parts.push(`bucket:${Math.floor(a.now / BUCKET_MS)}`);
  return { fp: createHash("sha256").update(parts.sort().join("\n")).digest("hex").slice(0, 24), attention, threads: human.length };
}
