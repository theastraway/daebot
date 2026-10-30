// Routines of one bot, persisted next to its DAEBOT.md: DATA_DIR/bots/<owner>/<botId>/routines.json (0600, atomic rename).
// One RoutineHub per process serves every owner; a RoutineBook is ONE bot of ONE owner, so another owner's routine id is simply unknown.
// The built-in Heartbeat exists on every bot (created on first read), can be turned off or re-timed, and cannot be deleted.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TimingError, checkFilter, describeTiming, filterWords, nextRun, parseTiming, validTz } from "./clock.ts";
import type { ActiveFilter } from "./clock.ts";
import { TRIGGER_TYPES, checkTrigger as validateTrigger, describeTrigger, isGithub } from "./triggers.ts";
import type { Trigger, TriggerCaps, TriggerType } from "./triggers.ts";

export { TRIGGER_TYPES };
export type { ActiveFilter, Trigger, TriggerType };

export type RoutineKind = "timed" | "trigger";
export type RunStatus = "ok" | "error" | "skipped" | "idle" | "running";

export interface RunRecord {
  at: number;
  source: string;              // "timer" | "manual" | a trigger type
  status: RunStatus;
  /** Did this run call the model? A heartbeat that found nothing changed records model:false. */
  model: boolean;
  ms: number;
  threadId?: string;
  result?: string;
}

export interface Routine {
  id: string;                  // r_<12 hex>
  name: string;
  prompt: string;
  enabled: boolean;
  kind: RoutineKind;
  timing?: { expression: string; tz: string; /** Weekdays only / active hours: applies to ANY expression. */ filter?: ActiveFilter };
  trigger?: Trigger;
  /** Polled triggers: what the last looks saw. `seen` are ids already reported, so each new item fires once. */
  tstate?: { primed: boolean; seen: string[]; nextPollAt?: number; lastPollAt?: number; error?: string };
  /** Webhook: the secret in https://<host>/hooks/<id>/<secret>. GitHub triggers: the secret GitHub signs its deliveries with. */
  secret?: string;
  /** Trigger health: when anything last reached or checked this trigger, when it last started a run, and the last problem. Polled triggers also have `tstate`. */
  health?: { checkedAt?: number; firedAt?: number; error?: string; errorAt?: number; deliveredAt?: number };
  /** Pushed triggers (GitHub): delivery ids already handled, so GitHub's redelivery of the same event never runs twice (survives restarts: saved with the routine). */
  push?: { seen: string[] };
  /** Title of the bot thread each run lands in. Default "Routine: <name>". */
  thread?: string;
  builtin?: "heartbeat";
  createdAt: number;
  updatedAt: number;
  /** Timed: the next instant a run is due. Advanced and saved BEFORE the run starts, so a restart can never fire a slot twice. */
  nextDueAt?: number;
  lastSlot?: number;
  lastRunAt?: number;
  lastStatus?: RunStatus;
  lastResult?: string;
  lastThreadId?: string;
  runs?: RunRecord[];
  /** Heartbeat only: fingerprint of the bot's threads/tasks/routines when it last looked, and counters. */
  hb?: { fp?: string; checkedAt?: number; reviews: number; idle: number };
}

export class RoutineError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export const MAX_ROUTINES_PER_BOT = 20;
export const MAX_PROMPT_BYTES = 4 * 1024;
export const DEFAULT_TZ = "America/New_York";
export const HEARTBEAT_NAME = "Heartbeat";
const RUN_KEEP = 20;
const ID_RE = /^r_[0-9a-f]{12}$/;
const BOT_RE = /^b_[0-9a-f]{12}$/;

const safeSegment = (s: string): string => { const v = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80); return v === "" || v === "." || v === ".." ? "_" : v; };
// eslint-disable-next-line no-control-regex
const oneLine = (v: unknown, max: number): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The task of the built-in heartbeat run. The cheap non-model check decides first whether it runs at all. */
export const HEARTBEAT_PROMPT = [
  "Review your own threads like a manager. The digest below came from a non-model check of your threads, tasks and routines.",
  "1. Call bot_self threads to see each thread, its last messages, run state and board tasks.",
  "2. For each item in the digest (an unanswered user message, a stalled or red task, an interrupted or failed run, a routine that errored) push it along: bot_self continue {thread, note} to resume the work, or bot_self stop {thread, question} when you need the user (one clear question, nothing else).",
  "3. Give ONE short line per thread you looked at as your final answer: thread title, state, what you did. Leave threads you did not need to touch out.",
  "4. Record what you learned with bot_self learn: what worked, what failed, a correction the user made. At most 3 lessons, each one rule you would follow next time. Skip it when you learned nothing new.",
  "Never contact anyone outside Astra, never delete anything, never guess. If a thread needs the user, stop it with the exact question.",
].join("\n");

export interface RoutineInput {
  name?: unknown; prompt?: unknown; enabled?: unknown; kind?: unknown;
  timing?: unknown; expression?: unknown; tz?: unknown;
  trigger?: unknown; thread?: unknown; filter?: unknown;
}

function newId(taken: Set<string>): string {
  for (;;) { const id = "r_" + randomBytes(6).toString("hex"); if (!taken.has(id)) return id; }
}
const newSecret = (): string => randomBytes(24).toString("base64url");

/** The webhook secret check, constant time. */
export function secretMatches(have: string | undefined, given: string): boolean {
  if (!have || !given) return false;
  const a = createHash("sha256").update(have).digest(), b = createHash("sha256").update(given).digest();
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Spreads heartbeats over the hour: a minute 0-59 derived from the bot id. */
export function heartbeatMinute(botId: string): number {
  return createHash("sha256").update(botId).digest()[0] % 60;
}

export class RoutineBook {
  readonly owner: string;
  readonly botId: string;
  private file: string;
  private dir: string;
  private routines: Routine[] = [];
  /** Lessons the bot recorded itself (bot_self learn). Recall is only attached to the bot's turns once this is above 0. */
  lessons = 0;
  private now: () => number;
  private onChange: (b: RoutineBook) => void;
  private caps: () => TriggerCaps;

  constructor(o: { dir: string; owner: string; botId: string; now?: () => number; onChange?: (b: RoutineBook) => void; caps?: () => TriggerCaps }) {
    if (!BOT_RE.test(o.botId)) throw new RoutineError(404, "no such bot");
    this.owner = o.owner;
    this.botId = o.botId;
    this.dir = join(o.dir, "bots", safeSegment(o.owner), o.botId);
    this.file = join(this.dir, "routines.json");
    this.now = o.now ?? Date.now;
    this.onChange = o.onChange ?? (() => {});
    this.caps = o.caps ?? (() => ({ desktop: false }));
    this.load();
    this.ensureHeartbeat();
  }

  private load(): void {
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8"));
      if (j && j.v === 1 && Array.isArray(j.routines)) {
        this.routines = j.routines.filter((r: any) => r && ID_RE.test(r.id) && typeof r.name === "string" && (r.kind === "timed" || r.kind === "trigger"));
        this.lessons = Number(j.lessons) > 0 ? Number(j.lessons) : 0;
      }
    } catch { /* absent or torn file = no routines yet */ }
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, owner: this.owner, botId: this.botId, lessons: this.lessons, routines: this.routines }), { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  private ensureHeartbeat(): void {
    if (this.routines.some((r) => r.builtin === "heartbeat")) return;
    const t = this.now();
    const timing = { expression: `${heartbeatMinute(this.botId)} * * * *`, tz: DEFAULT_TZ };
    // The first heartbeat comes one full cadence after the bot is first seen: no burst of model calls the moment this ships.
    this.routines.push({
      id: newId(new Set(this.routines.map((r) => r.id))), name: HEARTBEAT_NAME, prompt: HEARTBEAT_PROMPT, enabled: true, kind: "timed",
      timing, thread: HEARTBEAT_NAME, builtin: "heartbeat", createdAt: t, updatedAt: t, nextDueAt: nextRun(timing.expression, timing.tz, t), hb: { reviews: 0, idle: 0 },
    });
    try { this.save(); } catch { /* the in-memory heartbeat still runs; the next successful save writes it */ }
  }

  list(): Routine[] { return this.routines.map((r) => structuredClone(r)); }
  get(id: string): Routine | undefined { const r = ID_RE.test(id) ? this.routines.find((x) => x.id === id) : undefined; return r ? structuredClone(r) : undefined; }
  private mut(id: string): Routine {
    const r = ID_RE.test(id) ? this.routines.find((x) => x.id === id) : undefined;
    if (!r) throw new RoutineError(404, "no such routine");
    return r;
  }
  heartbeat(): Routine { return structuredClone(this.routines.find((r) => r.builtin === "heartbeat")!); }

  // ---------------------------------------------------------------- validation
  private checkPrompt(v: unknown): string {
    if (typeof v !== "string" || !v.trim()) throw new RoutineError(400, "a routine needs a prompt: the task the bot runs");
    if (Buffer.byteLength(v, "utf8") > MAX_PROMPT_BYTES) throw new RoutineError(400, `the prompt is over ${MAX_PROMPT_BYTES / 1024} KB`);
    return v.trim();
  }
  private checkName(v: unknown): string {
    const n = oneLine(v, 60);
    if (!n) throw new RoutineError(400, "a routine needs a name");
    return n;
  }
  private checkTiming(expression: unknown, tz: unknown, tzDefault: string, filter?: unknown): { expression: string; tz: string; filter?: ActiveFilter } {
    let parsed, f: ActiveFilter | undefined;
    try { parsed = parseTiming(expression); f = checkFilter(filter); } catch (e) { throw new RoutineError(400, e instanceof TimingError ? e.message : "bad timing"); }
    const z = tz === undefined || tz === null || tz === "" ? tzDefault : tz;
    if (!validTz(z)) throw new RoutineError(400, `"${String(z).slice(0, 40)}" is not a time zone name (use one like America/New_York)`);
    return { expression: parsed.text, tz: z, ...(f ? { filter: f } : {}) };
  }
  private checkTrigger(v: unknown): Trigger {
    try { return validateTrigger(v, this.caps()); } catch (e) { throw new RoutineError(400, e instanceof TimingError ? e.message : "bad trigger"); }
  }
  private timingOf(i: RoutineInput): Record<string, unknown> {
    return i.timing && typeof i.timing === "object" ? (i.timing as Record<string, unknown>) : { expression: i.expression, tz: i.tz, filter: i.filter };
  }
  private nextOf(t: { expression: string; tz: string; filter?: ActiveFilter }, after: number): number | undefined { return nextRun(t.expression, t.tz, after, t.filter); }

  // ---------------------------------------------------------------- writes
  add(input: RoutineInput, tzDefault = DEFAULT_TZ): Routine {
    if (this.routines.length >= MAX_ROUTINES_PER_BOT) throw new RoutineError(409, `a bot can have at most ${MAX_ROUTINES_PER_BOT} routines`);
    const name = this.checkName(input.name);
    if (this.routines.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new RoutineError(409, `this bot already has a routine named "${name}"`);
    const prompt = this.checkPrompt(input.prompt);
    const kind = input.kind;
    if (kind !== "timed" && kind !== "trigger") throw new RoutineError(400, 'kind must be "timed" or "trigger"');
    const t = this.now();
    const r: Routine = { id: newId(new Set(this.routines.map((x) => x.id))), name, prompt, enabled: input.enabled !== false, kind, createdAt: t, updatedAt: t };
    if (typeof input.thread === "string" && input.thread.trim()) r.thread = oneLine(input.thread, 60);
    if (kind === "timed") {
      const tm = this.timingOf(input);
      r.timing = this.checkTiming(tm.expression, tm.tz, tzDefault, tm.filter);
      if (r.enabled) r.nextDueAt = this.nextOf(r.timing, t);
    } else {
      r.trigger = this.checkTrigger(input.trigger);
      if (r.trigger.type === "webhook" || isGithub(r.trigger.type)) r.secret = newSecret();
      if (r.enabled) this.armPoll(r, t);
    }
    this.routines.push(r);
    this.save();
    this.onChange(this);
    return structuredClone(r);
  }

  update(id: string, patch: RoutineInput, tzDefault = DEFAULT_TZ): Routine {
    const r = this.mut(id);
    if (r.builtin === "heartbeat") {
      for (const k of ["name", "prompt", "kind", "trigger", "thread"] as const) if (patch[k] !== undefined) throw new RoutineError(400, `the Heartbeat is built in: you can turn it off or change its timing, nothing else (${k})`);
    }
    const t = this.now();
    if (patch.name !== undefined) {
      const name = this.checkName(patch.name);
      if (this.routines.some((x) => x.id !== r.id && x.name.toLowerCase() === name.toLowerCase())) throw new RoutineError(409, `this bot already has a routine named "${name}"`);
      r.name = name;
    }
    if (patch.prompt !== undefined) r.prompt = this.checkPrompt(patch.prompt);
    if (patch.thread !== undefined) r.thread = typeof patch.thread === "string" && patch.thread.trim() ? oneLine(patch.thread, 60) : undefined;
    if (patch.enabled !== undefined) r.enabled = patch.enabled === true;
    if (patch.kind !== undefined && patch.kind !== r.kind) {
      if (patch.kind !== "timed" && patch.kind !== "trigger") throw new RoutineError(400, 'kind must be "timed" or "trigger"');
      r.kind = patch.kind;
      if (r.kind === "timed") { delete r.trigger; delete r.secret; delete r.tstate; delete r.health; delete r.push; } else { delete r.timing; delete r.nextDueAt; }
    }
    if (r.kind === "timed") {
      const retimed = patch.timing !== undefined || patch.expression !== undefined || patch.tz !== undefined;
      if (retimed || !r.timing) {
        const tm = this.timingOf(patch);
        const keepFilter = tm.filter === undefined && patch.timing === undefined ? r.timing?.filter : tm.filter;
        r.timing = this.checkTiming(tm.expression ?? r.timing?.expression, tm.tz ?? r.timing?.tz, tzDefault, keepFilter);
      }
      // Re-timed or turned on: the next run is computed from NOW (a routine turned on never replays the time it was off).
      if (retimed || patch.enabled !== undefined || r.nextDueAt === undefined) r.nextDueAt = r.enabled ? this.nextOf(r.timing!, t) : undefined;
    } else {
      if (patch.trigger !== undefined || !r.trigger) {
        const before = r.trigger;
        r.trigger = this.checkTrigger(patch.trigger ?? r.trigger);
        if (!before || before.type !== r.trigger.type || before.every !== r.trigger.every) delete r.tstate;   // a different thing to watch: look again from scratch
        if (!before || before.type !== r.trigger.type) { delete r.health; delete r.push; }
      }
      const keepsSecret = r.trigger.type === "webhook" || isGithub(r.trigger.type);
      if (keepsSecret && !r.secret) r.secret = newSecret();
      if (!keepsSecret) delete r.secret;
      if (patch.enabled === true || !r.enabled) delete r.tstate;
      if (r.enabled) this.armPoll(r, t); else delete r.tstate;
    }
    r.updatedAt = t;
    this.save();
    this.onChange(this);
    return structuredClone(r);
  }

  /** New webhook secret; the old URL stops working at once. */
  rotateSecret(id: string): Routine {
    const r = this.mut(id);
    if (r.kind !== "trigger" || !(r.trigger?.type === "webhook" || isGithub(r.trigger?.type))) throw new RoutineError(400, "only a webhook or GitHub routine has a secret");
    r.secret = newSecret();
    r.updatedAt = this.now();
    this.save();
    return structuredClone(r);
  }

  remove(id: string): void {
    const r = this.mut(id);
    if (r.builtin === "heartbeat") throw new RoutineError(400, "the Heartbeat is built in and cannot be deleted. Turn it off instead.");
    this.routines = this.routines.filter((x) => x !== r);
    this.save();
    this.onChange(this);
  }

  // ---------------------------------------------------------------- run bookkeeping (called by the timer and the runner)
  /**
   * Claims a due slot BEFORE the run starts: advances nextDueAt from `now` (a run missed during downtime runs once, never N times)
   * and persists, so a crash or restart right after can never fire the same slot again. Returns the claimed slot, or undefined if not due.
   */
  claimSlot(id: string, now: number, jitterMs = 0): number | undefined {
    const r = this.routines.find((x) => x.id === id);
    if (!r || !r.enabled || r.kind !== "timed" || !r.timing) return undefined;
    if (r.nextDueAt === undefined) { r.nextDueAt = this.nextOf(r.timing, now); this.save(); return undefined; }
    if (now < r.nextDueAt + jitterMs) return undefined;
    const slot = r.nextDueAt;
    if (r.lastSlot !== undefined && slot <= r.lastSlot) { r.nextDueAt = this.nextOf(r.timing, Math.max(now, r.lastSlot)); this.save(); return undefined; }
    r.lastSlot = slot;
    r.nextDueAt = this.nextOf(r.timing, now);
    this.save();
    return slot;
  }

  recordRun(id: string, rec: RunRecord): void {
    const r = this.routines.find((x) => x.id === id);
    if (!r) return;
    const clean = { ...rec, ...(rec.result ? { result: rec.result.slice(0, 400) } : {}) };
    r.runs = [...(r.runs ?? []), clean].slice(-RUN_KEEP);
    r.lastRunAt = rec.at;
    r.lastStatus = rec.status;
    r.lastResult = clean.result;
    if (rec.threadId) r.lastThreadId = rec.threadId;
    this.save();
  }

  setHeartbeat(id: string, p: { fp?: string; checkedAt?: number; reviewed?: boolean; idle?: boolean }): void {
    const r = this.routines.find((x) => x.id === id);
    if (!r || r.builtin !== "heartbeat") return;
    const h = r.hb ?? { reviews: 0, idle: 0 };
    if (p.fp !== undefined) h.fp = p.fp;
    if (p.checkedAt !== undefined) h.checkedAt = p.checkedAt;
    if (p.reviewed) h.reviews++;
    if (p.idle) h.idle++;
    r.hb = h;
    this.save();
  }

  markRunning(id: string, at: number): void {
    const r = this.routines.find((x) => x.id === id);
    if (!r) return;
    r.lastStatus = "running";
    r.lastRunAt = at;
    this.save();
  }

  // ---------------------------------------------------------------- polled triggers
  /** A polled trigger that is on gets its first look at once (which only records what is already there). */
  private armPoll(r: Routine, t: number): void {
    if (r.kind !== "trigger" || !r.trigger || !r.enabled || !(r.trigger.every)) return;
    r.tstate ??= { primed: false, seen: [] };
    if (r.tstate.nextPollAt === undefined) r.tstate.nextPollAt = t;
  }
  pollState(id: string): Routine["tstate"] | undefined { return this.routines.find((x) => x.id === id)?.tstate; }
  /** Saves the outcome of one look: ids now known, when to look next, and the error if it failed. */
  setPoll(id: string, p: { primed?: boolean; seen?: string[]; at: number; error?: string }): void {
    const r = this.routines.find((x) => x.id === id);
    if (!r || r.kind !== "trigger" || !r.trigger?.every) return;
    const ts = r.tstate ?? { primed: false, seen: [] };
    if (p.primed !== undefined) ts.primed = p.primed;
    if (p.seen) ts.seen = p.seen.slice(-400);
    ts.lastPollAt = p.at;
    ts.nextPollAt = p.at + r.trigger.every * 60_000;
    if (p.error) ts.error = p.error.slice(0, 160); else delete ts.error;
    r.tstate = ts;
    this.save();
  }

  // ---------------------------------------------------------------- trigger health + pushed deliveries
  /** Records what happened at a trigger: reached/checked, fired a run, or failed. `error: null` clears the last problem. Writes only when something changed. */
  noteHealth(id: string, p: { checkedAt?: number; firedAt?: number; deliveredAt?: number; error?: string | null }): void {
    const r = this.routines.find((x) => x.id === id);
    if (!r || r.kind !== "trigger") return;
    const h = r.health ?? {};
    const before = JSON.stringify(h);
    if (p.checkedAt !== undefined) h.checkedAt = p.checkedAt;
    if (p.firedAt !== undefined) h.firedAt = p.firedAt;
    if (p.deliveredAt !== undefined) h.deliveredAt = p.deliveredAt;
    if (p.error === null) { delete h.error; delete h.errorAt; }
    else if (typeof p.error === "string") { h.error = p.error.slice(0, 160); h.errorAt = p.checkedAt ?? this.now(); }
    r.health = h;
    if (JSON.stringify(h) !== before) this.save();
  }

  /** True the first time a delivery id is seen (and remembers it); false for a repeat. */
  markDelivery(id: string, deliveryId: string): boolean {
    const r = this.routines.find((x) => x.id === id);
    if (!r) return false;
    const seen = r.push?.seen ?? [];
    if (seen.includes(deliveryId)) return false;
    r.push = { seen: [...seen, deliveryId].slice(-200) };
    this.save();
    return true;
  }

  noteLesson(): void { this.lessons++; this.save(); }
}

/** All books of the process. Absent / unreadable files simply mean "no routines yet". */
export class RoutineHub {
  readonly dir: string;
  private books = new Map<string, RoutineBook>();
  private index = new Map<string, string>();     // routine id -> book key
  private now: () => number;
  private listeners = new Set<(b: RoutineBook) => void>();
  private lastScanAt = 0;
  /** What this deployment can detect; the gateway sets desktop:true when it runs on the user's own computer. */
  readonly caps: TriggerCaps = { desktop: false };

  constructor(dir: string, o: { now?: () => number } = {}) {
    this.dir = dir;
    this.now = o.now ?? Date.now;
  }

  private key(owner: string, botId: string): string { return `${owner}\u0000${botId}`; }

  book(owner: string, botId: string): RoutineBook {
    const k = this.key(owner, botId);
    let b = this.books.get(k);
    if (!b) {
      b = new RoutineBook({ dir: this.dir, owner, botId, now: this.now, onChange: (x) => this.reindex(x), caps: () => this.caps });
      this.books.set(k, b);
      this.reindex(b);
    }
    return b;
  }

  private reindex(b: RoutineBook): void {
    const k = this.key(b.owner, b.botId);
    for (const [rid, bk] of this.index) if (bk === k) this.index.delete(rid);
    for (const r of b.list()) this.index.set(r.id, k);
    for (const l of this.listeners) l(b);
  }

  onChange(fn: (b: RoutineBook) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** The book holding a routine id (a webhook arrives with an id only). */
  find(routineId: string): { book: RoutineBook; routine: Routine } | undefined {
    const k = this.index.get(routineId);
    const b = k ? this.books.get(k) : undefined;
    const r = b?.get(routineId);
    return b && r ? { book: b, routine: r } : undefined;
  }

  /** Every book loaded so far (the timer walks these). */
  all(): RoutineBook[] { return [...this.books.values()]; }

  /** Forgets a deleted bot's book (its folder, routines.json with it, is removed by the bot store). */
  drop(owner: string, botId: string): void {
    const k = this.key(owner, botId);
    this.books.delete(k);
    for (const [rid, bk] of this.index) if (bk === k) this.index.delete(rid);
  }

  /** Loads (and so gives a heartbeat to) the books of every bot folder on disk. `ownerOk` maps a folder name to a live owner id, or undefined to skip it. */
  scan(ownerOk: (seg: string) => string | undefined): RoutineBook[] {
    const out: RoutineBook[] = [];
    const root = join(this.dir, "bots");
    let owners: string[] = [];
    try { owners = readdirSync(root); } catch { return out; }
    this.lastScanAt = this.now();
    for (const seg of owners) {
      const owner = ownerOk(seg);
      if (!owner) continue;
      let ids: string[] = [];
      try {
        const j = JSON.parse(readFileSync(join(root, seg, "bots.json"), "utf8"));
        ids = j && j.bots && typeof j.bots === "object" ? Object.keys(j.bots).filter((id) => BOT_RE.test(id) && existsSync(join(root, seg))) : [];
      } catch { continue; }
      for (const id of ids) { try { out.push(this.book(owner, id)); } catch { /* unreadable bot: skip */ } }
    }
    return out;
  }
  get scannedAt(): number { return this.lastScanAt; }
}

export function describeRoutine(r: Routine): string {
  if (r.kind === "timed" && r.timing) return describeTiming(r.timing.expression, r.timing.tz) + filterWords(r.timing.filter);
  return r.trigger ? describeTrigger(r.trigger) : "";
}
