// Hosted side of session sync (daebot.live). Header-authenticated per user (X-MIND-Key), so a signed-in desktop app mirrors its
// sessions into the user's own hosted store and pulls back whatever the phone or the web wrote. Every read and write is scoped to ONE
// owner: another user's session id is "forbidden", never merged into.
import type { SessionStore, StoredSession } from "../persist.ts";
import type { BotsApi } from "../bots/types.ts";
import { homeSig, mergeRecords, recordSig } from "./merge.ts";
import { MAX_RECORD_BYTES, NOT_SYNCED_SURFACES, fromWire, toWire } from "./wire.ts";
import type { WireRecord } from "./wire.ts";
import { TombstoneBook } from "./tombstones.ts";
import { inferHome, readEvidence } from "./home.ts";
import type { HomeCtx, HomeWhy } from "./home.ts";
import type { EnvTag } from "../env.ts";

export interface SyncRow { id: string; touchedAt: number; updatedAt: number; sig: string; title: string; /** Where the session lives (a device that has the same transcript adopts it without fetching the record). */ env?: EnvTag; /** The session was deleted (a tombstone): the device deletes its copy. */ deleted?: true }
export type PushStatus = "ok" | "same" | "busy" | "forbidden" | "invalid" | "nobot" | "toolarge" | "error" | "deleted";
export interface PushResult { id: string; status: PushStatus; sig?: string }

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
      rows.push({ id: x.id, touchedAt: x.at, updatedAt: rec.updatedAt, sig: recordSig(rec), title: rec.title, ...(rec.env ? { env: rec.env } : {}) });
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

  private homeCtx(owner: string): HomeCtx { return this.deps.homeCtx?.(owner) ?? { groups: [] }; }

  /**
   * Gives every session of these owners (all of them when none are named) that has no home the one its record proves, else MIND Cloud.
   * Idempotent: a session that has a home is never touched. Runs at start and then on a timer, so any session that slips in untagged is fixed.
   */
  async backfillHomes(owners?: string[], o: { recheckCloud?: boolean } = {}): Promise<{ owner: string; scanned: number; assigned: number; byHome: Record<string, number>; byWhy: Partial<Record<HomeWhy, number>> }[]> {
    const metas = this.deps.store.list().filter((m) => !NOT_SYNCED_SURFACES.has(m.surface));
    const want = owners ? new Set(owners) : undefined;
    const ids = [...new Set(metas.map((m) => m.owner ?? "owner"))].filter((o) => !want || want.has(o));
    const out: { owner: string; scanned: number; assigned: number; byHome: Record<string, number>; byWhy: Partial<Record<HomeWhy, number>> }[] = [];
    for (const owner of ids) {
      const sum = { owner, scanned: 0, assigned: 0, byHome: {} as Record<string, number>, byWhy: {} as Partial<Record<HomeWhy, number>> };
      const ctx = this.homeCtx(owner);
      for (const m of metas) {
        if ((m.owner ?? "owner") !== owner) continue;
        sum.scanned++;
        // A session stamped MIND Cloud is only re-read on the start-up pass, and only moved by proof (a tool that cannot run on daebot.live returned ok).
        if (m.env && !(o.recheckCloud && m.env.kind === "cloud")) continue;
        if (this.deps.isBusy(m.id)) continue; // its live copy would write the old record back; the next pass gets it
        const rec = this.deps.store.load(m.id);
        if (!rec) continue;
        if (rec.env && (rec.env.kind !== "cloud" || !readEvidence(rec).localTool)) continue;
        const g = inferHome({ ...rec, env: undefined }, ctx);
        if (g.env.kind === "cloud" && rec.env) continue;
        await this.deps.store.save({ ...rec, env: g.env }, { origin: "sync" });
        await this.deps.afterWrite?.(owner, rec.id).catch(() => {});
        sum.assigned++;
        sum.byHome[g.env.name] = (sum.byHome[g.env.name] ?? 0) + 1;
        sum.byWhy[g.why] = (sum.byWhy[g.why] ?? 0) + 1;
      }
      out.push(sum);
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
        // Every session ends up with a home: a record nobody tagged gets the device that pushed it (if it is new here) or what its own history shows.
        if (!merged.env) merged.env = inferHome(merged, { ...this.homeCtx(owner), pusher: existing ? undefined : pusher }).env;
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
