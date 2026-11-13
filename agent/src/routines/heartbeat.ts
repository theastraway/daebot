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
  /** Items that wait on the user (a stopped thread with its question). `hash` changes when the item changed: same hash = already surfaced, stay quiet. */
  waiting: WaitingItem[];
}
export interface WaitingItem { key: string; hash: string; line: string }

const h12 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** What the Heartbeat should actually bring up: everything that is not waiting on the user, plus waiting items that are new or changed since they were last surfaced. */
export function freshAttention(p: Probe, surfaced: Record<string, string> | undefined): string[] {
  const waitingLines = new Set(p.waiting.map((w) => w.line));
  const stale = new Set(p.waiting.filter((w) => surfaced?.[w.key] === w.hash).map((w) => w.line));
  return p.attention.filter((a) => !waitingLines.has(a) || !stale.has(a));
}
/** The surfaced map to remember after a look: every waiting item as it is now (items that left the board are forgotten, so a re-stop surfaces again). */
export const surfacedNow = (p: Probe): Record<string, string> => Object.fromEntries(p.waiting.map((w) => [w.key, w.hash]));

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
  const waiting: WaitingItem[] = [];
  const parts: string[] = [];
  for (const t of human) parts.push(`t:${t.id}:${t.updatedAt}`);
  for (const b of a.board) {
    if (!ids.has(b.sessionId)) continue;
    parts.push(`b:${b.sessionId}:${b.id}:${b.status}`);
    if (b.status === "stopped") {
      const line = `Thread "${title.get(b.sessionId)}" is stopped, waiting on the user${b.question ? `: ${b.question.slice(0, 120)}` : ""}`;
      attention.push(line);
      waiting.push({ key: `${b.sessionId}:${b.id}`, hash: h12(`${b.status}|${b.question ?? ""}|${b.title}`), line });
      parts.push(`w:${b.sessionId}:${b.id}:${waiting[waiting.length - 1].hash}`);
    }
    else if (b.status === "not_started") attention.push(`Thread "${title.get(b.sessionId)}": task "${b.title.slice(0, 80)}" has not started`);
    else if (b.status === "in_progress" && a.now - b.updatedAt > STALL_MS) attention.push(`Thread "${title.get(b.sessionId)}": task "${b.title.slice(0, 80)}" looks stalled (no change for ${Math.round((a.now - b.updatedAt) / 60000)} min)`);
  }
  for (const r of a.routines) {
    parts.push(`r:${r.id}:${r.updatedAt}:${r.enabled ? 1 : 0}`);
    if (r.lastStatus === "error" && r.lastRunAt) { parts.push(`re:${r.id}:${r.lastRunAt}`); attention.push(`Routine "${r.name}" failed on its last run${r.lastResult ? `: ${r.lastResult.slice(0, 120)}` : ""}`); }
  }
  // Items that need the manager (not ones that only wait on the user) get looked at again every 6 hours even when nothing else moved.
  const waitingLines = new Set(waiting.map((w) => w.line));
  if (attention.some((x) => !waitingLines.has(x))) parts.push(`bucket:${Math.floor(a.now / BUCKET_MS)}`);
  return { fp: createHash("sha256").update(parts.sort().join("\n")).digest("hex").slice(0, 24), attention, threads: human.length, waiting };
}
