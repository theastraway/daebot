// Hosted side of session sync (daebot.live). Header-authenticated per user (X-MIND-Key), so a signed-in desktop app mirrors its
// sessions into the user's own hosted store and pulls back whatever the phone or the web wrote. Every read and write is scoped to ONE
// owner: another user's session id is "forbidden", never merged into.
import type { SessionStore, StoredSession } from "../persist.ts";
import type { BotsApi } from "../bots/types.ts";
import { homeSig, mergeRecords, recordSig } from "./merge.ts";
import { MAX_RECORD_BYTES, NOT_SYNCED_SURFACES, fromWire, toWire } from "./wire.ts";
import type { WireRecord } from "./wire.ts";
import { TombstoneBook } from "./tombstones.ts";
import { botMigration, inferHome, migrationDecision } from "./home.ts";
import type { HomeCtx, HomeWhy, MigrateWhy } from "./home.ts";
import { CLOUD_ENV, isLocalHome } from "../env.ts";
import type { EnvBy, EnvTag } from "../env.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SyncRow { id: string; touchedAt: number; updatedAt: number; sig: string; title: string; /** Where the session lives (a device that has the same transcript adopts it without fetching the record). */ env?: EnvTag; /** When the home was last decided and by whom (the latest decision wins on every device). */ envAt?: number; envBy?: EnvBy; /** The session was deleted (a tombstone): the device deletes its copy. */ deleted?: true }
export type PushStatus = "ok" | "same" | "busy" | "forbidden" | "invalid" | "nobot" | "toolarge" | "error" | "deleted";
export interface PushResult { id: string; status: PushStatus; sig?: string }

export interface MigrationReport {
  owner: string; scanned: number;
  moved: { id: string; title: string; from: string; why: MigrateWhy }[];
  kept: { id: string; title: string; why: MigrateWhy }[];
  botsOff: { slug: string; why: string }[];
  botsKept: { slug: string; why: string }[];
  skippedBusy: string[];
}

export interface SyncServiceDeps {
  store: SessionStore;
  /** This owner's bots (a slug names the bot on the wire). */
  bots(owner: string): BotsApi | undefined;
  /** True while a turn of this session is running in this process (its in-memory copy would overwrite a merge). */
  isBusy(id: string): boolean;
  /** The identity tier this owner's sessions run at here (a tier never travels in a sync). */
  tierOf(owner: string): string;
  /** Deletes a session of this owner for good (closes a live copy, removes the record and its photos). false = unknown here. */
  deleteSession?(owner: string, id: string): Promise<boolean>;
  /** Where deletes are remembered (default: in memory only). */
  tombstones?: TombstoneBook;
  /** The owner's computers and servers (merged) and the computer each Remote bot runs on: what a session's home is worked out from. */
  homeCtx?(owner: string): HomeCtx;
  /** Where the one-time "put auto-stamped computers back on MIND Cloud" pass leaves its marker (one file per owner), so it never runs twice. Absent = runs when asked. */
  migrationDir?: string;
  /** Called after a merge wrote a session: a live idle copy must be reloaded from the store. */
  afterWrite?(owner: string, id: string): Promise<void>;
  now?: () => number;
}

export class SyncService {
  private touched = new Map<string, number>();
  private last = 0;
  private chains = new Map<string, Promise<unknown>>();
  private deps: SyncServiceDeps;
  readonly tombs: TombstoneBook;

  constructor(deps: SyncServiceDeps) {
    this.deps = deps;
    this.tombs = deps.tombstones ?? new TombstoneBook();
    deps.store.subscribe?.((rec) => this.noteSaved(rec));
    // Any delete of a stored session (the web, the phone, a bot being deleted, a device's own delete) leaves a tombstone for every other device.
    deps.store.subscribeRemove?.((id, owner) => { this.tombs.mark(owner ?? "owner", id, this.tick()); });
  }

  private tick(): number {
    const t = Math.max((this.deps.now ?? Date.now)(), this.last + 1);
    this.last = t;
    return t;
  }

  /** Every save (a hosted turn, a rename, a push) moves the session's server-side change time. */
  noteSaved(rec: Pick<StoredSession, "id">): void {
    this.touched.set(rec.id, this.tick());
    if (this.touched.size > 20000) { const first = this.touched.keys().next().value; if (first !== undefined) this.touched.delete(first); }
  }

  /** Sessions of one owner changed after `since` (server time), oldest first. `more` = ask again with the last touchedAt. */
  list(owner: string, since: number, limit = 200): { now: number; rows: SyncRow[]; more: boolean } {
    const mine = this.deps.store.list().filter((m) => (m.owner ?? "owner") === owner && !NOT_SYNCED_SURFACES.has(m.surface));
    const cands = mine.map((m) => ({ m, at: this.touched.get(m.id) ?? m.updatedAt })).filter((x) => x.at > since).sort((a, b) => a.at - b.at);
    const dead = this.tombs.since(owner, since).map((t) => ({ tomb: true as const, id: t.id, at: t.at }));
    const all: ({ tomb?: false; m: (typeof mine)[number]; at: number; id: string } | { tomb: true; id: string; at: number })[] = [
      ...cands.filter((c) => !this.tombs.has(owner, c.m.id)).map((c) => ({ m: c.m, at: c.at, id: c.m.id })),
      ...dead,
    ].sort((a, b) => a.at - b.at);
    const rows: SyncRow[] = [];
    for (const x of all.slice(0, limit)) {
      if (x.tomb) { rows.push({ id: x.id, touchedAt: x.at, updatedAt: x.at, sig: "", title: "", deleted: true }); continue; }
      const rec = this.deps.store.loadShared ? this.deps.store.loadShared(x.id) : this.deps.store.load(x.id);
      if (!rec) continue;
      rows.push({ id: x.id, touchedAt: x.at, updatedAt: rec.updatedAt, sig: recordSig(rec), title: rec.title, ...(rec.env ? { env: rec.env, ...(rec.envAt ? { envAt: rec.envAt } : {}), ...(rec.envBy ? { envBy: rec.envBy } : {}) } : {}) });
    }
    return { now: this.tick(), rows, more: all.length > limit };
  }

  /** A device deleted this session: it is removed here too, and a tombstone stops any other device from bringing it back. */
  async remove(owner: string, id: string): Promise<"ok" | "forbidden"> {
    const rec = this.deps.store.meta?.(id) ?? this.deps.store.load(id);
    if (rec && (rec.owner ?? "owner") !== owner) return "forbidden";
    if (rec) {
      if (this.deps.deleteSession) await this.deps.deleteSession(owner, id);
      else await this.deps.store.remove?.(id);
    }
    this.tombs.mark(owner, id, this.tick());
    return "ok";
  }

  async get(owner: string, id: string): Promise<WireRecord | undefined> {
    const rec = this.deps.store.load(id);
    if (!rec || (rec.owner ?? "owner") !== owner) return undefined;
    const w = toWire(rec, this.deps.bots(owner));
    if (w || (!rec.bot && !rec.peer)) return w;
    try { await this.deps.bots(owner)?.list(); } catch { /* MIND unreachable */ }
    return toWire(rec, this.deps.bots(owner));
  }

  /**
   * Gives every session of these owners (all of them when none are named) that has no home MIND Cloud, the standard. Idempotent: a session that has a
   * home is never touched. Runs at start and then on a timer, so any session that slips in untagged is fixed. (It never infers a computer.)
   */
  async backfillHomes(owners?: string[], _o: { recheckCloud?: boolean } = {}): Promise<{ owner: string; scanned: number; assigned: number; byHome: Record<string, number>; byWhy: Partial<Record<HomeWhy, number>> }[]> {
    const metas = this.deps.store.list().filter((m) => !NOT_SYNCED_SURFACES.has(m.surface));
    const want = owners ? new Set(owners) : undefined;
    const ids = [...new Set(metas.map((m) => m.owner ?? "owner"))].filter((o) => !want || want.has(o));
    const out: { owner: string; scanned: number; assigned: number; byHome: Record<string, number>; byWhy: Partial<Record<HomeWhy, number>> }[] = [];
    for (const owner of ids) {
      const sum = { owner, scanned: 0, assigned: 0, byHome: {} as Record<string, number>, byWhy: {} as Partial<Record<HomeWhy, number>> };
      for (const m of metas) {
        if ((m.owner ?? "owner") !== owner) continue;
        sum.scanned++;
        if (m.env) continue;
        if (this.deps.isBusy(m.id)) continue; // its live copy would write the old record back; the next pass gets it
        const rec = this.deps.store.load(m.id);
        if (!rec || rec.env) continue;
        const g = inferHome(rec);
        await this.deps.store.save({ ...rec, env: g.env, envAt: this.tick(), envBy: "default" }, { origin: "sync" });
        await this.deps.afterWrite?.(owner, rec.id).catch(() => {});
        sum.assigned++;
        sum.byHome[g.env.name] = (sum.byHome[g.env.name] ?? 0) + 1;
        sum.byWhy[g.why] = (sum.byWhy[g.why] ?? 0) + 1;
      }
      out.push(sum);
    }
    return out;
  }

  private migrationFile(owner: string): string | undefined {
    return this.deps.migrationDir ? join(this.deps.migrationDir, `env-cloud-v1-${owner.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)}.json`) : undefined;
  }

  /**
   * The one-time pass that puts every session and bot that was STAMPED onto a computer (not chosen) back on MIND Cloud. Kept as they are: a home the
   * person chose (envBy user), a server, a bot whose Remote the person turned on (and its threads), a legacy Remote bot whose threads needed the
   * computer's tools. Never loses history: only the home stamp (env, envAt, envBy) of a record is rewritten, and every device adopts it because the
   * migration is the latest decision (envAt). Writes a marker per owner so it runs once; `force` ignores the marker.
   */
  async migrateToCloud(owners?: string[], o: { force?: boolean; dryRun?: boolean } = {}): Promise<MigrationReport[]> {
    const metas = this.deps.store.list().filter((m) => !NOT_SYNCED_SURFACES.has(m.surface));
    const want = owners ? new Set(owners) : undefined;
    const ids = [...new Set(metas.map((m) => m.owner ?? "owner"))].filter((x) => !want || want.has(x));
    const out: MigrationReport[] = [];
    for (const owner of ids) {
      const mf = this.migrationFile(owner);
      if (!o.force && !o.dryRun && mf && existsSync(mf)) continue;
      const rep: MigrationReport = { owner, scanned: 0, moved: [], kept: [], botsOff: [], botsKept: [], skippedBusy: [] };
      const bots = this.deps.bots(owner);
      try { await bots?.list(); } catch { /* MIND unreachable: the bots we hold locally are enough */ }
      const recs = metas.filter((m) => (m.owner ?? "owner") === owner).map((m) => this.deps.store.load(m.id)).filter((r): r is StoredSession => !!r);
      // 1. bots: Remote that nobody chose goes off.
      for (const b of bots?.snapshot() ?? []) {
        const v = botMigration(b, recs.filter((r) => r.bot === b.id));
        if (v.why === "not-remote") continue;
        if (!v.off) { rep.botsKept.push({ slug: b.slug, why: v.why }); continue; }
        rep.botsOff.push({ slug: b.slug, why: v.why });
        if (!o.dryRun) bots?.setRemote?.(b.id, false, { by: "auto", note: "Moved to MIND Cloud: Run on a computer had been turned on automatically, not by you. Turn it on again if you want this bot on a computer.", at: this.tick() });
      }
      // 2. sessions: a stamped computer goes to MIND Cloud.
      for (const rec of recs) {
        rep.scanned++;
        const v = migrationDecision(rec, rec.bot ? bots?.get(rec.bot) : undefined);
        if (!v.move) { if (isLocalHome(rec.env)) rep.kept.push({ id: rec.id, title: rec.title, why: v.why }); continue; }
        if (this.deps.isBusy(rec.id)) { rep.skippedBusy.push(rec.id); continue; }
        rep.moved.push({ id: rec.id, title: rec.title, from: rec.env!.name, why: v.why });
        if (o.dryRun) continue;
        // Re-read right before writing: a turn or another device may have saved since the scan. Only the home stamp changes.
        const cur = this.deps.store.load(rec.id) ?? rec;
        await this.deps.store.save({ ...cur, env: CLOUD_ENV, envAt: this.tick(), envBy: "auto" }, { origin: "sync" });
        await this.deps.afterWrite?.(owner, rec.id).catch(() => {});
      }
      if (!o.dryRun && mf) { try { mkdirSync(this.deps.migrationDir!, { recursive: true, mode: 0o700 }); const tmp = `${mf}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify({ at: Date.now(), moved: rep.moved.length, botsOff: rep.botsOff.map((x) => x.slug) }), { mode: 0o600 }); renameSync(tmp, mf); } catch { /* the next start tries again; the pass is idempotent */ } }
      out.push(rep);
    }
    return out;
  }

  /** Merges incoming wire records into this owner's store. One push at a time per owner (a merge is read-modify-write). */
  push(owner: string, records: unknown[], pusher?: EnvTag): Promise<PushResult[]> {
    const prev = this.chains.get(owner) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.pushLocked(owner, records, pusher));
    this.chains.set(owner, run.catch(() => {}));
    return run;
  }

  private async pushLocked(owner: string, records: unknown[], pusher?: EnvTag): Promise<PushResult[]> {
    const out: PushResult[] = [];
    let bots = this.deps.bots(owner);
    let reconciled = false;
    for (const raw of records.slice(0, 50)) {
      const id = typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id : "";
      try {
        if (id && this.tombs.has(owner, id)) { out.push({ id, status: "deleted" }); continue; }
        if (id && JSON.stringify(raw).length > MAX_RECORD_BYTES) { out.push({ id, status: "toolarge" }); continue; }
        let m = fromWire(raw, bots, owner, this.deps.tierOf(owner));
        if (!m.ok && m.reason === "nobot" && !reconciled && bots) {
          reconciled = true;
          try { await bots.list(); } catch { /* MIND unreachable: the thread waits for a later push */ }
          bots = this.deps.bots(owner);
          m = fromWire(raw, bots, owner, this.deps.tierOf(owner));
        }
        if (!m.ok) { out.push({ id, status: m.reason === "nobot" ? "nobot" : "invalid" }); continue; }
        const rec = m.rec;
        if (this.deps.isBusy(rec.id)) { out.push({ id: rec.id, status: "busy" }); continue; }
        const existing = this.deps.store.load(rec.id);
        if (existing && (existing.owner ?? "owner") !== owner) { out.push({ id: rec.id, status: "forbidden" }); continue; }
        const merged = mergeRecords(existing, rec);
        // Every session ends up with a home, and it is MIND Cloud unless the person chose a computer. A record nobody tagged is MIND Cloud; so is a NEW
        // record an older desktop build stamped with its own computer without the person's say (no decision recorded): never auto-stamped onto a computer.
        if (!merged.env) { merged.env = inferHome(merged).env; merged.envAt = this.tick(); merged.envBy = "default"; }
        else if (!existing && merged.env.kind === "machine" && !merged.envBy && !merged.envAt) { merged.env = CLOUD_ENV; merged.envAt = this.tick(); merged.envBy = "default"; }
        if (existing && recordSig(merged) === recordSig(existing) && merged.history.length === existing.history.length && homeSig(merged) === homeSig(existing)) {
          out.push({ id: rec.id, status: "same", sig: recordSig(existing) });
          continue;
        }
        await this.deps.store.save(merged, { origin: "sync" });
        await this.deps.afterWrite?.(owner, rec.id).catch(() => {});
        out.push({ id: rec.id, status: "ok", sig: recordSig(merged) });
      } catch {
        out.push({ id, status: "error" });
      }
    }
    return out;
  }
}
