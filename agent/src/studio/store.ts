// Studio state of ONE owner, on disk: the counters a bot publishes for its island ("applications 389") and the staged pipelines of
// departments (style, design, system, build, review in the Altair "design studio" screenshot). Written only by the studio tools
// (studio_counter, studio_pipeline) that the model calls, so every string is clipped to one line and nothing here is trusted as
// instructions. One JSON file per owner under DATA_DIR/studio, 0600, read once and rewritten on every change.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_COUNTERS = 3;
export const MAX_STAGES = 8;
export const MAX_LOG = 30;
export const STAGE_STATUSES = ["todo", "running", "done", "failed"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export interface Counter { name: string; value: number; note?: string; at: number }
export interface Stage { name: string; skill?: string; bot?: string; status: StageStatus; at: number; note?: string }
export interface LogEntry { at: number; stage: string; status: StageStatus; by: string; skill?: string; note?: string }
export interface Pipeline { department: string; stages: Stage[]; log: LogEntry[]; createdAt: number; updatedAt: number }
interface File { v: 1; counters: Record<string, Counter[]>; pipelines: Record<string, Pipeline> }

// eslint-disable-next-line no-control-regex
const oneLine = (v: unknown, max: number): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const seg = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "_";
const slug = (s: string): string => oneLine(s, 48).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export class StudioError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

export class StudioStore {
  private file: string;
  private data: File;
  private now: () => number;
  constructor(o: { dir: string; owner: string; now?: () => number }) {
    this.file = join(o.dir, `${seg(o.owner)}.json`);
    this.now = o.now ?? (() => Date.now());
    this.data = this.read();
  }
  private read(): File {
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8"));
      if (j && j.v === 1 && typeof j === "object") return { v: 1, counters: j.counters && typeof j.counters === "object" ? j.counters : {}, pipelines: j.pipelines && typeof j.pipelines === "object" ? j.pipelines : {} };
    } catch { /* fresh */ }
    return { v: 1, counters: {}, pipelines: {} };
  }
  private save(): void {
    const dir = join(this.file, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  // ---- counters ----
  counters(botId: string): Counter[] { return [...(this.data.counters[botId] ?? [])]; }
  allCounters(): Record<string, Counter[]> { const out: Record<string, Counter[]> = {}; for (const [k, v] of Object.entries(this.data.counters)) out[k] = [...v]; return out; }
  /** Sets one named counter of a bot (at most MAX_COUNTERS per bot; a new name beyond that is refused). `value` null removes it. */
  setCounter(botId: string, name: unknown, value: unknown, note?: unknown): Counter[] {
    const n = oneLine(name, 32);
    if (!n) throw new StudioError("bad_name", "the counter needs a short name");
    const list = this.data.counters[botId] ?? [];
    const i = list.findIndex((c) => c.name.toLowerCase() === n.toLowerCase());
    if (value === null) { if (i >= 0) list.splice(i, 1); this.data.counters[botId] = list; this.save(); return [...list]; }
    const v = typeof value === "number" ? value : Number(String(value ?? "").replace(/[,\s]/g, ""));
    if (!Number.isFinite(v)) throw new StudioError("bad_value", "the counter value must be a number");
    const c: Counter = { name: n, value: Math.round(v * 100) / 100, at: this.now(), ...(oneLine(note, 80) ? { note: oneLine(note, 80) } : {}) };
    if (i >= 0) list[i] = c;
    else if (list.length >= MAX_COUNTERS) throw new StudioError("too_many", `a bot shows at most ${MAX_COUNTERS} counters; remove one (value null) or reuse a name: ${list.map((x) => x.name).join(", ")}`);
    else list.push(c);
    this.data.counters[botId] = list;
    this.save();
    return [...list];
  }

  // ---- pipelines ----
  pipeline(department: string): Pipeline | undefined { const p = this.data.pipelines[slug(department)]; return p ? structuredClone(p) : undefined; }
  pipelines(): Record<string, Pipeline> { return structuredClone(this.data.pipelines); }
  /** Defines (or replaces) a department's staged pipeline. Stages reset to todo; the log keeps the definition line. */
  define(department: unknown, stages: unknown, by: string): Pipeline {
    const d = slug(String(department ?? ""));
    if (!d) throw new StudioError("bad_department", "the pipeline needs a department name");
    if (!Array.isArray(stages) || !stages.length) throw new StudioError("bad_stages", "stages must be a list like [{name, skill?, bot?}]");
    if (stages.length > MAX_STAGES) throw new StudioError("bad_stages", `at most ${MAX_STAGES} stages`);
    const now = this.now();
    const seen = new Set<string>();
    const list: Stage[] = [];
    for (const raw of stages) {
      const s = (raw && typeof raw === "object" ? raw : { name: raw }) as Record<string, unknown>;
      const name = oneLine(s.name, 40);
      if (!name) throw new StudioError("bad_stages", "every stage needs a name");
      if (seen.has(name.toLowerCase())) throw new StudioError("bad_stages", `stage "${name}" is listed twice`);
      seen.add(name.toLowerCase());
      list.push({ name, status: "todo", at: now, ...(oneLine(s.skill, 48) ? { skill: oneLine(s.skill, 48).toLowerCase() } : {}), ...(oneLine(s.bot, 32) ? { bot: oneLine(s.bot, 32).toLowerCase() } : {}) });
    }
    const prev = this.data.pipelines[d];
    const p: Pipeline = { department: d, stages: list, log: [...(prev?.log ?? []), { at: now, stage: "(pipeline)", status: "todo" as const, by: oneLine(by, 32), note: `defined ${list.length} stages: ${list.map((s) => s.name).join(" → ")}` }].slice(-MAX_LOG), createdAt: prev?.createdAt ?? now, updatedAt: now };
    this.data.pipelines[d] = p;
    this.save();
    return structuredClone(p);
  }
  /** Moves one stage (by name or 1-based number) to a status and logs it. Starting a stage marks earlier todo stages done only if told (strict by default: it just sets that stage). */
  advance(department: unknown, stage: unknown, status: unknown, by: string, note?: unknown): Pipeline {
    const d = slug(String(department ?? ""));
    const p = this.data.pipelines[d];
    if (!p) throw new StudioError("no_pipeline", `no pipeline for "${d}": define one first (action define)`);
    const st = String(status ?? "").toLowerCase() as StageStatus;
    if (!STAGE_STATUSES.includes(st)) throw new StudioError("bad_status", `status must be one of ${STAGE_STATUSES.join(", ")}`);
    const key = oneLine(stage, 40);
    const idx = /^\d+$/.test(key) ? Number(key) - 1 : p.stages.findIndex((s) => s.name.toLowerCase() === key.toLowerCase());
    const s = p.stages[idx];
    if (!s) throw new StudioError("no_stage", `no stage "${key}"; the stages are ${p.stages.map((x, i) => `${i + 1} ${x.name}`).join(", ")}`);
    const now = this.now();
    s.status = st; s.at = now;
    const nt = oneLine(note, 160);
    if (nt) s.note = nt; else delete s.note;
    p.log = [...p.log, { at: now, stage: s.name, status: st, by: oneLine(by, 32), ...(s.skill ? { skill: s.skill } : {}), ...(nt ? { note: nt } : {}) }].slice(-MAX_LOG);
    p.updatedAt = now;
    this.save();
    return structuredClone(p);
  }
  remove(department: unknown): boolean {
    const d = slug(String(department ?? ""));
    if (!this.data.pipelines[d]) return false;
    delete this.data.pipelines[d];
    this.save();
    return true;
  }
}

/** Where a pipeline stands: the current stage (first not done), how many are done, and the whole list for the island. */
export function pipelineSummary(p: Pipeline): { stage: number; of: number; done: number; current?: string; status: StageStatus; marks: StageStatus[] } {
  const done = p.stages.filter((s) => s.status === "done").length;
  const cur = p.stages.findIndex((s) => s.status !== "done");
  const current = cur >= 0 ? p.stages[cur] : undefined;
  return { stage: cur >= 0 ? cur + 1 : p.stages.length, of: p.stages.length, done, ...(current ? { current: current.name } : {}), status: current ? current.status : "done", marks: p.stages.map((s) => s.status) };
}
