// The helper hub: every helper and loop of this runtime (one owner), live. delegate and loop write to it as helpers start, use tools
// and finish; Daebot Studio reads it (GET /studio `helpers` and `loops`) so the user watches the team work. Memory only: a restart
// clears it, and finished entries fall off after an hour. Strings are clipped to one line; no tool arguments or outputs are kept.

export type HelperStatus = "queued" | "running" | "done" | "failed";

export interface HelperLive {
  id: string;
  session: string;
  title: string;
  kind: string;
  status: HelperStatus;
  startedAt: number;
  endedAt?: number;
  /** The tool the helper is using right now (or used last). */
  tool?: string;
  calls: number;
  /** Build helpers: the branch that holds their changes, and how many files changed. */
  branch?: string;
  files?: number;
  /** Loop cycles: which loop and cycle this helper belongs to. */
  loop?: string;
  cycle?: number;
  note?: string;
}

export interface LoopLive {
  id: string;
  session: string;
  goal: string;
  bar: number;
  maxCycles: number;
  cycle: number;
  phase: "study" | "build" | "grade" | "cleared" | "stopped" | "failed";
  /** Overall score per finished cycle (0-10). */
  scores: number[];
  weakest?: string;
  startedAt: number;
  endedAt?: number;
  branch?: string;
}

const one = (s: unknown, n: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const KEEP_MS = 60 * 60_000;
const MAX = 60;

export class HelperHub {
  private helpers = new Map<string, HelperLive>();
  private loops = new Map<string, LoopLive>();
  private seq = 0;
  private now: () => number;
  /** Called on every change (a gateway can push it; Studio polls). */
  onChange?: () => void;
  constructor(o: { now?: () => number } = {}) { this.now = o.now ?? Date.now; }

  private touch(): void { this.prune(); try { this.onChange?.(); } catch { /* a listener never breaks a helper */ } }
  private prune(): void {
    const t = this.now();
    for (const m of [this.helpers, this.loops] as Map<string, { endedAt?: number }>[]) {
      for (const [k, v] of m) if (v.endedAt && t - v.endedAt > KEEP_MS) m.delete(k);
      while (m.size > MAX) { const oldest = [...m].find(([, v]) => v.endedAt) ?? [...m][0]; m.delete(oldest[0]); }
    }
  }

  start(h: { session: string; title: string; kind: string; loop?: string; cycle?: number }): string {
    const id = `h${(++this.seq).toString(36)}${this.now().toString(36).slice(-4)}`;
    this.helpers.set(id, { id, session: one(h.session, 120), title: one(h.title, 80), kind: one(h.kind, 20), status: "running", startedAt: this.now(), calls: 0, ...(h.loop ? { loop: h.loop, cycle: h.cycle } : {}) });
    this.touch();
    return id;
  }
  tool(id: string, name: string): void {
    const h = this.helpers.get(id);
    if (!h || h.status !== "running") return;
    h.tool = one(name, 60); h.calls++;
    this.touch();
  }
  finish(id: string, r: { ok: boolean; branch?: string; files?: number; note?: string }): void {
    const h = this.helpers.get(id);
    if (!h) return;
    h.status = r.ok ? "done" : "failed"; h.endedAt = this.now();
    if (r.branch) h.branch = one(r.branch, 120);
    if (r.files !== undefined) h.files = r.files;
    if (r.note) h.note = one(r.note, 160);
    this.touch();
  }

  startLoop(l: { session: string; goal: string; bar: number; maxCycles: number }): string {
    const id = `l${(++this.seq).toString(36)}${this.now().toString(36).slice(-4)}`;
    this.loops.set(id, { id, session: one(l.session, 120), goal: one(l.goal, 160), bar: l.bar, maxCycles: l.maxCycles, cycle: 0, phase: "study", scores: [], startedAt: this.now() });
    this.touch();
    return id;
  }
  updateLoop(id: string, patch: Partial<Pick<LoopLive, "cycle" | "phase" | "weakest" | "branch">> & { score?: number }): void {
    const l = this.loops.get(id);
    if (!l) return;
    if (patch.cycle !== undefined) l.cycle = patch.cycle;
    if (patch.phase) { l.phase = patch.phase; if (patch.phase === "cleared" || patch.phase === "stopped" || patch.phase === "failed") l.endedAt = this.now(); }
    if (patch.weakest !== undefined) l.weakest = one(patch.weakest, 60);
    if (patch.branch) l.branch = one(patch.branch, 120);
    if (patch.score !== undefined && Number.isFinite(patch.score)) l.scores.push(Math.round(patch.score * 10) / 10);
    this.touch();
  }

  /** Newest first: running ones, then the last hour's finished ones. */
  list(): { helpers: HelperLive[]; loops: LoopLive[]; running: number } {
    this.prune();
    const order = <T extends { startedAt: number; endedAt?: number }>(a: T, b: T) => (a.endedAt ? 1 : 0) - (b.endedAt ? 1 : 0) || b.startedAt - a.startedAt;
    const helpers = [...this.helpers.values()].map((h) => ({ ...h })).sort(order);
    const loops = [...this.loops.values()].map((l) => ({ ...l, scores: [...l.scores] })).sort(order);
    return { helpers, loops, running: helpers.filter((h) => h.status === "running").length + loops.filter((l) => !l.endedAt).length };
  }
}
