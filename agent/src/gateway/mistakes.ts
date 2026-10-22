// Admin ledgers: the Mistake Log (/admin/mistakes) and the Task KPIs (/admin/kpis).
//   POST   /api/admin/mistakes              log a mistake (creates the TYPE when new, otherwise counts up). { batch: [...] } seeds many.
//   GET    /api/admin/mistakes              summary + types (with weekly counts) + filtered occurrences
//   DELETE /api/admin/mistakes/occurrence/:id
//   POST   /api/admin/tasks                 open or update a task. { batch: [...] } seeds many.
//   GET    /api/admin/tasks                 KPIs + tasks
// Writes need the server-side secret header (x-daebot-log-key = DAEBOT_MISTAKE_LOG_KEY). Reads need that header OR an admin session.
// Storage is one JSON file under DATA_DIR/admin (the same persistent disk as chats and users). Counts are derived from the
// occurrences, never stored, so a count can not drift from the evidence behind it.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TASK_STATUSES = ["open", "done-verified", "failed", "abandoned"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
const TZ = "America/New_York";
const DAY = 86_400_000;

export interface MistakeType { id: string; name: string; definition: string; prevention: string; createdAt: string }
export interface Occurrence {
  id: string; type_id: string; when: string; agent: string; product: string; what: string; quote: string; impact: string; fix: string;
  links: string[]; source: string; source_key?: string; estimated?: boolean;
}
export interface Task {
  id: string; title: string; product: string; requested_at: string; requester: string; status: TaskStatus;
  completed_at: string | null; verified_on: string; prompts_to_satisfaction: number; repeats: number; anger_flag: boolean;
  mistake_ids: string[]; estimated: boolean; source_key?: string; session_id?: string; updated_at: string;
}
interface Shape { v: 1; types: Record<string, MistakeType>; occurrences: Occurrence[]; tasks: Task[] }

const s = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const newId = (p: string): string => p + "_" + randomBytes(6).toString("hex");
const normName = (n: string): string => n.toLowerCase().replace(/\s+/g, " ").trim();

function isoOrNow(v: unknown, now: number): string {
  if (typeof v === "string" && v.trim()) { const t = Date.parse(v.trim()); if (Number.isFinite(t)) return new Date(t).toISOString(); }
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  return new Date(now).toISOString();
}
function isoOrNull(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) { const t = Date.parse(v.trim()); if (Number.isFinite(t)) return new Date(t).toISOString(); }
  return null;
}
const strList = (v: unknown, n: number, max: number): string[] => (Array.isArray(v) ? v.map((x) => s(x, max)).filter(Boolean).slice(0, n) : typeof v === "string" && v.trim() ? [s(v, max)] : []);

/** Calendar day (YYYY-MM-DD) in Anthony's timezone. */
export function etDay(ms: number): string { return new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ }); }
/** Monday (YYYY-MM-DD) of the week a day belongs to. */
export function weekStart(day: string): string {
  const d = new Date(day + "T12:00:00Z");
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY).toISOString().slice(0, 10);
}
function lastWeeks(n: number, now: number): string[] {
  const cur = weekStart(etDay(now));
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(new Date(cur + "T12:00:00Z").getTime() - i * 7 * DAY).toISOString().slice(0, 10));
  return out;
}
const median = (xs: number[]): number => { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

export class AdminLedger {
  private path: string;
  private d: Shape = { v: 1, types: {}, occurrences: [], tasks: [] };
  private now: () => number;
  constructor(dir: string, now: () => number = Date.now) {
    this.now = now;
    this.path = join(dir, "admin", "mistake-log.json");
    if (existsSync(this.path)) {
      try { const p = JSON.parse(readFileSync(this.path, "utf8")); if (p?.v === 1) this.d = { v: 1, types: p.types ?? {}, occurrences: p.occurrences ?? [], tasks: p.tasks ?? [] }; }
      catch { throw new Error("admin/mistake-log.json is unreadable; refusing to start (move it aside to reset)."); }
    }
  }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.d), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  // ---------- mistakes
  private findType(name: string): MistakeType | undefined {
    const n = normName(name);
    return Object.values(this.d.types).find((t) => normName(t.name) === n);
  }
  /** Logs one mistake. A `what`-less call only creates or edits the type. Returns what happened. */
  logMistake(b: any): { type_id: string; type: string; occurrence_id?: string; created_type: boolean; duplicate?: boolean; count: number } {
    const name = s(b?.type ?? b?.type_name, 80);
    if (!name) throw new Error("type is required");
    let created = false;
    let t = this.findType(name);
    if (!t) {
      let id = slug(name) || newId("t");
      if (this.d.types[id]) id = newId("t");
      t = { id, name, definition: "", prevention: "", createdAt: new Date(this.now()).toISOString() };
      this.d.types[id] = t; created = true;
    }
    if (s(b.definition, 1000)) t.definition = s(b.definition, 1000);
    if (s(b.prevention ?? b.rule, 600)) t.prevention = s(b.prevention ?? b.rule, 600);
    const what = s(b.what ?? b.what_happened, 1200);
    const count = () => this.d.occurrences.filter((o) => o.type_id === t!.id).length;
    if (!what) { this.save(); return { type_id: t.id, type: t.name, created_type: created, count: count() }; }
    const sk = s(b.source_key, 200);
    if (sk) {
      const dup = this.d.occurrences.find((o) => o.source_key === sk);
      if (dup) { this.save(); return { type_id: dup.type_id, type: this.d.types[dup.type_id]?.name ?? name, occurrence_id: dup.id, created_type: created, duplicate: true, count: count() }; }
    }
    const o: Occurrence = {
      id: newId("m"), type_id: t.id, when: isoOrNow(b.when, this.now()), agent: s(b.agent, 60) || "Dae", product: s(b.product ?? b.client, 80) || "unknown",
      what, quote: s(b.quote ?? b.anthony_words, 1200), impact: s(b.impact ?? b.cost, 600), fix: s(b.fix ?? b.fix_applied, 800),
      links: strList(b.links, 10, 300), source: s(b.source, 300) || "api", estimated: b.estimated === true ? true : undefined,
    };
    if (sk) o.source_key = sk;
    this.d.occurrences.push(o);
    this.save();
    return { type_id: t.id, type: t.name, occurrence_id: o.id, created_type: created, count: count() };
  }
  logMistakeBatch(items: unknown[]): { added: number; duplicates: number; types: number } {
    let added = 0, dups = 0; const before = Object.keys(this.d.types).length;
    // one save for the whole batch
    const save = this.save.bind(this); this.save = () => {};
    try { for (const it of items) { const r = this.logMistake(it); if (r.duplicate) dups++; else if (r.occurrence_id) added++; } }
    finally { this.save = save; }
    this.save();
    return { added, duplicates: dups, types: Object.keys(this.d.types).length - before };
  }
  deleteOccurrence(id: string): boolean {
    const i = this.d.occurrences.findIndex((o) => o.id === id);
    if (i < 0) return false;
    const [o] = this.d.occurrences.splice(i, 1);
    // a type born from a test occurrence goes away with its last occurrence only when it has no definition
    const t = this.d.types[o.type_id];
    if (t && !t.definition && !t.prevention && !this.d.occurrences.some((x) => x.type_id === t.id)) delete this.d.types[t.id];
    this.save();
    return true;
  }
  deleteTask(id: string): boolean {
    const i = this.d.tasks.findIndex((t) => t.id === id);
    if (i < 0) return false;
    this.d.tasks.splice(i, 1); this.save(); return true;
  }

  mistakeView(q: URLSearchParams) {
    const now = this.now();
    const weeks = lastWeeks(12, now);
    const occ = this.d.occurrences;
    const byType = new Map<string, Occurrence[]>();
    for (const o of occ) { const a = byType.get(o.type_id); a ? a.push(o) : byType.set(o.type_id, [o]); }
    const types = Object.values(this.d.types).map((t) => {
      const os = byType.get(t.id) ?? [];
      const times = os.map((o) => Date.parse(o.when)).filter(Number.isFinite);
      const w = weeks.map(() => 0);
      for (const tm of times) { const i = weeks.indexOf(weekStart(etDay(tm))); if (i >= 0) w[i]++; }
      return {
        id: t.id, name: t.name, definition: t.definition, prevention: t.prevention, count: os.length,
        first_seen: times.length ? new Date(Math.min(...times)).toISOString() : null, last_seen: times.length ? new Date(Math.max(...times)).toISOString() : null, weekly: w,
      };
    }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const weekAgo = now - 7 * DAY;
    const total = occ.length;
    const thisWeek = occ.filter((o) => Date.parse(o.when) >= weekAgo).length;
    const top = types[0];
    // filters
    const type = q.get("type"), product = (q.get("product") ?? "").toLowerCase(), agent = (q.get("agent") ?? "").toLowerCase();
    const from = q.get("from") ? Date.parse(q.get("from")!) : NaN, to = q.get("to") ? Date.parse(q.get("to")! + "T23:59:59Z") : NaN;
    const text = (q.get("q") ?? "").toLowerCase().trim();
    const limit = Math.min(Math.max(Number(q.get("limit")) || 2000, 1), 5000);
    const occurrences = occ.filter((o) =>
      (!type || o.type_id === type) && (!product || o.product.toLowerCase() === product) && (!agent || o.agent.toLowerCase() === agent) &&
      (!Number.isFinite(from) || Date.parse(o.when) >= from) && (!Number.isFinite(to) || Date.parse(o.when) <= to) &&
      (!text || [o.what, o.quote, o.impact, o.fix, o.product, o.agent, this.d.types[o.type_id]?.name ?? ""].join(" ").toLowerCase().includes(text)))
      .sort((a, b) => Date.parse(b.when) - Date.parse(a.when)).slice(0, limit)
      .map((o) => ({ ...o, type: this.d.types[o.type_id]?.name ?? o.type_id }));
    const uniq = (xs: string[]) => [...new Set(xs)].sort((a, b) => a.localeCompare(b));
    return {
      summary: { total, this_week: thisWeek, types: types.length, top_repeat: top ? { name: top.name, count: top.count } : null, weeks },
      products: uniq(occ.map((o) => o.product)), agents: uniq(occ.map((o) => o.agent)), types, occurrences,
    };
  }

  // ---------- tasks
  upsertTask(b: any): { id: string; created: boolean } {
    const now = this.now();
    const id = s(b?.id, 60), sk = s(b?.source_key, 200);
    let t = (id && this.d.tasks.find((x) => x.id === id)) || (sk ? this.d.tasks.find((x) => x.source_key === sk) : undefined) || undefined;
    const created = !t;
    if (!t) {
      const title = s(b?.title, 300);
      if (!title) throw new Error("title is required to open a task");
      t = {
        id: id || newId("k"), title, product: "unknown", requested_at: isoOrNow(b.requested_at, now), requester: "Anthony", status: "open", completed_at: null, verified_on: "",
        prompts_to_satisfaction: 1, repeats: 0, anger_flag: false, mistake_ids: [], estimated: false, updated_at: new Date(now).toISOString(),
      };
      this.d.tasks.push(t);
    }
    if (s(b.title, 300)) t.title = s(b.title, 300);
    if (s(b.product, 80)) t.product = s(b.product, 80);
    if (s(b.requester, 60)) t.requester = s(b.requester, 60);
    if (b.requested_at !== undefined && isoOrNull(b.requested_at)) t.requested_at = isoOrNull(b.requested_at)!;
    if (b.status !== undefined) {
      if (!(TASK_STATUSES as readonly string[]).includes(b.status)) throw new Error("status must be one of " + TASK_STATUSES.join(", "));
      t.status = b.status;
      if (t.status === "open") t.completed_at = null;
      else if (!t.completed_at) t.completed_at = isoOrNull(b.completed_at) ?? new Date(now).toISOString();
    }
    if (b.completed_at !== undefined && t.status !== "open") t.completed_at = isoOrNull(b.completed_at) ?? t.completed_at;
    if (b.verified_on !== undefined) t.verified_on = s(b.verified_on, 500);
    if (Number.isFinite(Number(b.prompts_to_satisfaction)) && b.prompts_to_satisfaction !== null && b.prompts_to_satisfaction !== "") t.prompts_to_satisfaction = Math.max(0, Math.min(500, Math.round(Number(b.prompts_to_satisfaction))));
    if (Number.isFinite(Number(b.prompts_delta)) && b.prompts_delta) t.prompts_to_satisfaction = Math.max(0, t.prompts_to_satisfaction + Math.round(Number(b.prompts_delta)));
    if (Number.isFinite(Number(b.repeats)) && b.repeats !== null && b.repeats !== "") t.repeats = Math.max(0, Math.min(500, Math.round(Number(b.repeats))));
    if (b.anger_flag !== undefined) t.anger_flag = b.anger_flag === true || b.anger_flag === "true";
    if (Array.isArray(b.mistake_ids)) t.mistake_ids = [...new Set([...t.mistake_ids, ...strList(b.mistake_ids, 50, 60)])];
    if (b.estimated !== undefined) t.estimated = b.estimated === true;
    if (sk) t.source_key = sk;
    if (s(b.session_id, 80)) t.session_id = s(b.session_id, 80);
    t.updated_at = new Date(now).toISOString();
    this.save();
    return { id: t.id, created };
  }
  upsertTaskBatch(items: unknown[]): { created: number; updated: number } {
    let c = 0, u = 0;
    const save = this.save.bind(this); this.save = () => {};
    try { for (const it of items) { const r = this.upsertTask(it); r.created ? c++ : u++; } } finally { this.save = save; }
    this.save();
    return { created: c, updated: u };
  }

  taskView(q: URLSearchParams) {
    const now = this.now();
    const tasks = this.d.tasks;
    const done = tasks.filter((t) => t.status === "done-verified");
    const closed = tasks.filter((t) => t.status !== "open");
    const today = etDay(now), weekAgo = now - 7 * DAY;
    const doneAt = (t: Task) => (t.completed_at ? Date.parse(t.completed_at) : NaN);
    const prompts = done.map((t) => t.prompts_to_satisfaction);
    const stale = tasks.filter((t) => t.status === "open" && now - Date.parse(t.requested_at) > DAY);
    const weeks = lastWeeks(12, now);
    const trend = weeks.map((w) => ({ week: w, verified: 0, failed: 0, prompts_sum: 0 }));
    for (const t of closed) {
      const at = doneAt(t); if (!Number.isFinite(at)) continue;
      const row = trend[weeks.indexOf(weekStart(etDay(at)))]; if (!row) continue;
      if (t.status === "done-verified") { row.verified++; row.prompts_sum += t.prompts_to_satisfaction; } else row.failed++;
    }
    const product = (q.get("product") ?? "").toLowerCase(), status = q.get("status") ?? "", text = (q.get("q") ?? "").toLowerCase().trim();
    const limit = Math.min(Math.max(Number(q.get("limit")) || 1000, 1), 5000);
    const rows = tasks.filter((t) => (!product || t.product.toLowerCase() === product) && (!status || t.status === status) && (!text || (t.title + " " + t.product).toLowerCase().includes(text)))
      .sort((a, b) => Date.parse(b.requested_at) - Date.parse(a.requested_at)).slice(0, limit)
      .map((t) => ({ ...t, stale: t.status === "open" && now - Date.parse(t.requested_at) > DAY }));
    const avg = prompts.length ? prompts.reduce((a, b) => a + b, 0) / prompts.length : 0;
    return {
      kpis: {
        verified_today: done.filter((t) => etDay(doneAt(t)) === today).length,
        verified_week: done.filter((t) => doneAt(t) >= weekAgo).length,
        verified_all: done.length,
        total_tasks: tasks.length, closed: closed.length,
        success_rate: closed.length ? done.length / closed.length : null,
        median_prompts: median(prompts), avg_prompts: Math.round(avg * 100) / 100,
        one_prompt: done.filter((t) => t.prompts_to_satisfaction <= 1).length,
        two_prompts: done.filter((t) => t.prompts_to_satisfaction === 2).length,
        three_plus: done.filter((t) => t.prompts_to_satisfaction >= 3).length,
        angry: tasks.filter((t) => t.anger_flag).length,
        open_over_24h: stale.length, open_total: tasks.filter((t) => t.status === "open").length,
        estimated: tasks.filter((t) => t.estimated).length,
        weeks,
      },
      trend: trend.map((r) => ({ week: r.week, verified: r.verified, failed: r.failed, avg_prompts: r.verified ? Math.round((r.prompts_sum / r.verified) * 100) / 100 : 0 })),
      top_reasked: [...tasks].filter((t) => t.repeats > 0).sort((a, b) => b.repeats - a.repeats || b.prompts_to_satisfaction - a.prompts_to_satisfaction).slice(0, 10)
        .map((t) => ({ id: t.id, title: t.title, product: t.product, repeats: t.repeats, prompts: t.prompts_to_satisfaction, status: t.status })),
      stale: stale.sort((a, b) => Date.parse(a.requested_at) - Date.parse(b.requested_at)).slice(0, 25).map((t) => ({ id: t.id, title: t.title, product: t.product, requested_at: t.requested_at })),
      products: [...new Set(tasks.map((t) => t.product))].sort(), tasks: rows,
    };
  }
}
