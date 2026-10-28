// Server-owned runs. A chat turn is started by a request but is not owned by it: the run lives here, keeps going when the
// client disconnects (app closed, tab closed, phone locked, another session opened), and any number of clients can
// attach to it by session id and resume from a sequence number. Only an explicit abort (manager.abort) stops it.
// The visible transcript is persisted separately by the runtime (history + a "running" mark, checkpointed during the turn);
// this registry only holds the live, replayable event feed of the latest turn per session, in memory (single instance).
import type { AgentEvent, HistoryEvent, PhotoRef } from "../types.ts";

export interface RunEvent { seq: number; ev: HistoryEvent }
export type RunStatus = "running" | "done";

export class Run {
  readonly events: RunEvent[] = [];
  readonly listeners = new Set<(e: RunEvent) => void>();
  status: RunStatus = "running";
  endedAt = 0;
  readonly id: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly userText: string;
  readonly userPhotos: PhotoRef[] | undefined;
  constructor(id: string, sessionId: string, startedAt: number, userText: string, userPhotos?: PhotoRef[]) {
    this.id = id; this.sessionId = sessionId; this.startedAt = startedAt; this.userText = userText; this.userPhotos = userPhotos;
  }
  publish(ev: HistoryEvent): void {
    const e: RunEvent = { seq: this.events.length + 1, ev };
    this.events.push(e);
    for (const l of [...this.listeners]) l(e);
  }
  finish(): void {
    if (this.status === "done") return;
    this.status = "done";
    this.endedAt = Date.now();
    for (const l of [...this.listeners]) l({ seq: -1, ev: { type: "done", finalText: "" } as AgentEvent });
    this.listeners.clear();
  }
}

/** How long a finished run stays replayable (a client that reconnects just after the end still gets the tail). */
export const RUN_KEEP_MS = 10 * 60 * 1000;

export class RunRegistry {
  private runs = new Map<string, Run>();
  start(sessionId: string, userText: string, userPhotos?: PhotoRef[]): Run {
    this.sweep();
    const run = new Run(`run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, sessionId, Date.now(), userText, userPhotos);
    this.runs.set(sessionId, run);
    return run;
  }
  get(sessionId: string): Run | undefined { return this.runs.get(sessionId); }
  active(sessionId: string): Run | undefined { const r = this.runs.get(sessionId); return r && r.status === "running" ? r : undefined; }
  drop(sessionId: string): void { this.runs.delete(sessionId); }
  sweep(now = Date.now()): void {
    for (const [k, r] of this.runs) if (r.status === "done" && now - r.endedAt > RUN_KEEP_MS) this.runs.delete(k);
  }
}
