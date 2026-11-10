// Routine sync across devices (daebot.live, the desktop app, the phone). Routine definitions and their run records (status, start, duration,
// result, the thread each run landed in) travel like sessions do: last writer wins on the definition, run records are unioned, and a delete leaves
// a tombstone so an offline device cannot bring a deleted routine back.
//   * A routine is keyed by its id (the same on every device) and filed under its bot's SLUG on the wire ("main" = the plain Daebot), because bot
//     ids are local to each side.
//   * The device that MADE a routine runs it. A copy that arrives by sync is `foreign`: shown, editable, deletable, never run (nothing fires twice).
//   * Secrets, polling state and the built-in Heartbeat (each device has its own) never travel.
import type { Routine, RoutineBook, RoutineHub, RunRecord } from "../routines/store.ts";
import { MAIN_BOT_ID } from "../routines/store.ts";
import type { BotsApi } from "../bots/types.ts";
import type { SyncHttp } from "./http.ts";
import { TombstoneBook } from "./tombstones.ts";

export const MAIN_SLUG = "main";
export const MAX_ROUTINES_PER_PUSH = 100;

export interface WireRoutine {
  id: string;
  botSlug: string;
  name: string;
  prompt: string;
  enabled: boolean;
  kind: "timed" | "trigger";
  timing?: Routine["timing"];
  trigger?: Routine["trigger"];
  thread?: string;
  createdAt: number;
  updatedAt: number;
  runs: RunRecord[];
  lastRunAt?: number;
  lastStatus?: Routine["lastStatus"];
  lastResult?: string;
  lastThreadId?: string;
}

export function toWireRoutine(r: Routine, botSlug: string): WireRoutine {
  return {
    id: r.id, botSlug, name: r.name, prompt: r.prompt, enabled: r.enabled, kind: r.kind,
    ...(r.timing ? { timing: r.timing } : {}), ...(r.trigger ? { trigger: r.trigger } : {}), ...(r.thread ? { thread: r.thread } : {}),
    createdAt: r.createdAt, updatedAt: r.updatedAt, runs: r.runs ?? [],
    ...(r.lastRunAt !== undefined ? { lastRunAt: r.lastRunAt } : {}), ...(r.lastStatus ? { lastStatus: r.lastStatus } : {}),
    ...(r.lastResult ? { lastResult: r.lastResult } : {}), ...(r.lastThreadId ? { lastThreadId: r.lastThreadId } : {}),
  };
}

/** Equal sigs = nothing to exchange. Changes with the definition (updatedAt) and with every run. */
export function routineSig(r: Pick<Routine, "updatedAt" | "lastRunAt" | "lastStatus" | "runs">): string {
  const last = r.runs?.length ? r.runs[r.runs.length - 1] : undefined;
  return `${r.updatedAt}:${r.lastRunAt ?? 0}:${r.lastStatus ?? ""}:${r.runs?.length ?? 0}:${last ? `${last.at}${last.status}` : ""}`;
}

export function validWireRoutine(v: unknown): v is WireRoutine {
  const r = v as Partial<WireRoutine> | null;
  return !!r && typeof r === "object" && typeof r.id === "string" && typeof r.botSlug === "string" && r.botSlug.length > 0 && r.botSlug.length <= 80
    && typeof r.name === "string" && typeof r.prompt === "string" && typeof r.enabled === "boolean" && (r.kind === "timed" || r.kind === "trigger")
    && typeof r.createdAt === "number" && typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) && Array.isArray(r.runs) && r.runs.length <= 200;
}

/** A bot slug on the wire -> this side's bot id ("main" -> the plain Daebot's book). undefined = this side does not know that bot (yet). */
export function botIdOfSlug(slug: string, bots: BotsApi | undefined): string | undefined {
  if (slug === MAIN_SLUG) return MAIN_BOT_ID;
  return bots?.bySlug(slug)?.id;
}
export function slugOfBotId(botId: string, bots: BotsApi | undefined): string | undefined {
  if (botId === MAIN_BOT_ID) return MAIN_SLUG;
  return bots?.get(botId)?.slug;
}

export type RoutinePushStatus = "ok" | "same" | "deleted" | "nobot" | "invalid" | "error";
export interface RoutinePushResult { id: string; status: RoutinePushStatus; sig?: string }
export interface RoutineSyncList { now: number; routines: WireRoutine[]; tombs: { id: string; at: number }[] }

/** The routines (non-heartbeat) of one owner across all their books, with each one's wire form. */
function ownerBooks(hub: RoutineHub, owner: string): RoutineBook[] { return hub.all().filter((b) => b.owner === owner); }

// ------------------------------------------------------------------ hosted side

export interface RoutineSyncServiceDeps {
  hub: RoutineHub;
  bots(owner: string): BotsApi | undefined;
  /** Folder name -> live owner id (loads the books on disk the runner has not seen yet). */
  ownerOk(seg: string): string | undefined;
  tombstones?: TombstoneBook;
  now?: () => number;
}

export class RoutineSyncService {
  private d: RoutineSyncServiceDeps;
  readonly tombs: TombstoneBook;
  private seen = new Map<string, { sig: string; at: number }>();
  private last = 0;
  private chains = new Map<string, Promise<unknown>>();

  constructor(d: RoutineSyncServiceDeps) {
    this.d = d;
    this.tombs = d.tombstones ?? new TombstoneBook();
    // A routine deleted here (the web UI, a bot) leaves a tombstone for every other device.
    d.hub.onRemoved((owner, _bot, id) => { this.tombs.mark(owner, id, this.tick()); });
  }

  private tick(): number {
    const t = Math.max((this.d.now ?? Date.now)(), this.last + 1);
    this.last = t;
    return t;
  }

  /** Routines of one owner that changed after `since` (server time), and deletes after it. Never throws on an unknown bot: that routine is simply not listed. */
  list(owner: string, since: number): RoutineSyncList {
    if (Date.now() - this.d.hub.scannedAt > 30_000) { try { this.d.hub.scan(this.d.ownerOk); } catch { /* the runner scans again */ } }
    const bots = this.d.bots(owner);
    const routines: WireRoutine[] = [];
    for (const book of ownerBooks(this.d.hub, owner)) {
      const slug = slugOfBotId(book.botId, bots);
      if (!slug) continue;
      for (const r of book.syncable()) {
        if (this.tombs.has(owner, r.id)) continue;
        const sig = routineSig(r);
        const k = `${owner}\u0000${r.id}`;
        let s = this.seen.get(k);
        if (!s || s.sig !== sig) { s = { sig, at: this.tick() }; this.seen.set(k, s); }
        if (s.at > since) routines.push(toWireRoutine(r, slug));
      }
    }
    return { now: this.tick(), routines, tombs: this.tombs.since(owner, since) };
  }

  /** Merges routines (and applies deletes) from one device. One push at a time per owner. */
  push(owner: string, raw: unknown[], deletes: unknown[] = []): Promise<RoutinePushResult[]> {
    const prev = this.chains.get(owner) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.pushLocked(owner, raw, deletes));
    this.chains.set(owner, run.catch(() => {}));
    return run;
  }

  private async pushLocked(owner: string, raw: unknown[], deletes: unknown[]): Promise<RoutinePushResult[]> {
    const out: RoutinePushResult[] = [];
    for (const id of deletes.slice(0, 200)) {
      if (typeof id !== "string" || id.length > 40) continue;
      for (const b of ownerBooks(this.d.hub, owner)) { try { b.deleteSynced(id); } catch { /* not here */ } }
      this.tombs.mark(owner, id, this.tick());
      out.push({ id, status: "deleted" });
    }
    let bots = this.d.bots(owner);
    let reconciled = false;
    for (const w of raw.slice(0, MAX_ROUTINES_PER_PUSH)) {
      const id = typeof (w as { id?: unknown })?.id === "string" ? (w as { id: string }).id : "";
      try {
        if (id && this.tombs.has(owner, id)) { out.push({ id, status: "deleted" }); continue; }
        if (!validWireRoutine(w)) { out.push({ id, status: "invalid" }); continue; }
        let botId = botIdOfSlug(w.botSlug, bots);
        if (!botId && !reconciled && bots) {
          reconciled = true;
          try { await bots.list(); } catch { /* MIND unreachable: the routine waits for a later push */ }
          bots = this.d.bots(owner);
          botId = botIdOfSlug(w.botSlug, bots);
        }
        if (!botId) { out.push({ id, status: "nobot" }); continue; }
        const book = this.d.hub.book(owner, botId);
        const res = book.applySynced(w, true);
        if (res === "invalid") { out.push({ id, status: "invalid" }); continue; }
        const now = book.get(w.id);
        out.push({ id, status: res === "same" ? "same" : "ok", ...(now ? { sig: routineSig(now) } : {}) });
      } catch { out.push({ id, status: "error" }); }
    }
    return out;
  }

  /** A device deleted this routine. */
  remove(owner: string, id: string): "ok" {
    for (const b of ownerBooks(this.d.hub, owner)) { try { b.deleteSynced(id); } catch { /* not here */ } }
    this.tombs.mark(owner, id, this.tick());
    return "ok";
  }
}

// ------------------------------------------------------------------ device side

export interface RoutineSyncAgentDeps {
  http: SyncHttp;
  hub(): RoutineHub | undefined;
  owner: string;
  bots(): BotsApi | undefined;
  tombstones: TombstoneBook;
  log?: (line: string) => void;
}

export class RoutineSyncAgent {
  private d: RoutineSyncAgentDeps;
  private cursor = 0;
  private synced = new Map<string, string>(); // routine id -> sig last agreed with the server
  private hooked?: RoutineHub;
  private lastFull = 0;
  readonly stats = { pulled: 0, pushed: 0, deleted: 0 };

  constructor(d: RoutineSyncAgentDeps) { this.d = d; }

  /** Starts remembering this device's deletes (a restart or an offline stretch must not lose them). */
  attach(): void {
    const hub = this.d.hub();
    if (!hub || this.hooked === hub) return;
    this.hooked = hub;
    hub.onRemoved((owner, _bot, id) => {
      if (owner !== this.d.owner) return;
      this.d.tombstones.mark(owner, id);
      this.d.tombstones.addPending(id);
      this.synced.delete(id);
    });
  }

  private async flushDeletes(): Promise<void> {
    for (const id of this.d.tombstones.pending()) {
      try {
        await this.d.http.json<{ ok: boolean }>("DELETE", `/api/sync/routines/${encodeURIComponent(id)}`);
        this.d.tombstones.clearPending(id);
        this.stats.deleted++;
      } catch (e) {
        const st = (e as { status?: number }).status;
        if (st === 403 || st === 404) this.d.tombstones.clearPending(id); else throw e;
      }
    }
  }

  /** One pull + push. Called from the session sync round; a failure is thrown to it (and retried next round). */
  async round(full = false): Promise<void> {
    this.attach();
    const hub = this.d.hub();
    if (!hub) return;
    const owner = this.d.owner;
    // ---- pull
    if (full || Date.now() - this.lastFull > 10 * 60_000) { this.cursor = 0; this.lastFull = Date.now(); }
    let bots = this.d.bots();
    const r = await this.d.http.json<RoutineSyncList>("GET", `/api/sync/routines?since=${this.cursor}`);
    for (const w of r.routines) {
      if (!validWireRoutine(w)) continue;
      if (this.d.tombstones.has(owner, w.id)) continue; // deleted here: the delete is (being) sent
      let botId = botIdOfSlug(w.botSlug, bots);
      if (!botId && bots) { try { await bots.list(); } catch { /* MIND unreachable */ } bots = this.d.bots(); botId = botIdOfSlug(w.botSlug, bots); }
      if (!botId) continue;
      try {
        const book = hub.book(owner, botId);
        const res = book.applySynced(w, true);
        if (res === "created" || res === "updated") this.stats.pulled++;
        const mine = book.get(w.id);
        if (mine && routineSig(mine) === routineSig(w as unknown as Routine)) this.synced.set(w.id, routineSig(mine));
      } catch { /* an unreadable book: skip it */ }
    }
    for (const t of r.tombs) {
      if (this.d.tombstones.has(owner, t.id)) continue;
      this.d.tombstones.mark(owner, t.id);
      for (const b of hub.all()) if (b.owner === owner) { try { if (b.deleteSynced(t.id)) this.stats.deleted++; } catch { /* gone already */ } }
    }
    this.cursor = Math.max(this.cursor, r.now);
    // ---- push
    await this.flushDeletes();
    bots = this.d.bots();
    const batch: WireRoutine[] = [];
    for (const b of hub.all()) {
      if (b.owner !== owner) continue;
      const slug = slugOfBotId(b.botId, bots);
      if (!slug) continue;
      for (const x of b.syncable()) {
        if (this.d.tombstones.has(owner, x.id)) continue;
        if (this.synced.get(x.id) === routineSig(x)) continue;
        batch.push(toWireRoutine(x, slug));
      }
    }
    for (let i = 0; i < batch.length; i += 50) {
      const part = batch.slice(i, i + 50);
      const res = await this.d.http.json<{ results: RoutinePushResult[] }>("POST", "/api/sync/routines", { routines: part });
      for (const x of res.results) {
        if (x.status === "ok" || x.status === "same") {
          const sent = part.find((p) => p.id === x.id);
          let mine: Routine | undefined;
          for (const b of hub.all()) if (b.owner === owner) mine ??= b.get(x.id);
          if (mine && x.sig && routineSig(mine) === x.sig) this.synced.set(x.id, x.sig);
          else if (mine && sent && routineSig(mine) === routineSig(sent as unknown as Routine)) this.synced.set(x.id, routineSig(mine));
          if (x.status === "ok") this.stats.pushed++;
        } else if (x.status === "deleted") {
          for (const b of hub.all()) if (b.owner === owner) { try { b.deleteSynced(x.id); } catch { /* gone */ } }
          this.d.tombstones.mark(owner, x.id);
        }
      }
    }
  }
}
