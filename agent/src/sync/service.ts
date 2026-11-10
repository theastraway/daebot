// Hosted side of session sync (daebot.live). Header-authenticated per user (X-MIND-Key), so a signed-in desktop app mirrors its
// sessions into the user's own hosted store and pulls back whatever the phone or the web wrote. Every read and write is scoped to ONE
// owner: another user's session id is "forbidden", never merged into.
import type { SessionStore, StoredSession } from "../persist.ts";
import type { BotsApi } from "../bots/types.ts";
import { mergeRecords, recordSig } from "./merge.ts";
import { MAX_RECORD_BYTES, NOT_SYNCED_SURFACES, fromWire, toWire } from "./wire.ts";
import type { WireRecord } from "./wire.ts";

export interface SyncRow { id: string; touchedAt: number; updatedAt: number; sig: string; title: string }
export type PushStatus = "ok" | "same" | "busy" | "forbidden" | "invalid" | "nobot" | "toolarge" | "error";
export interface PushResult { id: string; status: PushStatus; sig?: string }

export interface SyncServiceDeps {
  store: SessionStore;
  /** This owner's bots (a slug names the bot on the wire). */
  bots(owner: string): BotsApi | undefined;
  /** True while a turn of this session is running in this process (its in-memory copy would overwrite a merge). */
  isBusy(id: string): boolean;
  /** The identity tier this owner's sessions run at here (a tier never travels in a sync). */
  tierOf(owner: string): string;
  /** Called after a merge wrote a session: a live idle copy must be reloaded from the store. */
  afterWrite?(owner: string, id: string): Promise<void>;
  now?: () => number;
}

export class SyncService {
  private touched = new Map<string, number>();
  private last = 0;
  private chains = new Map<string, Promise<unknown>>();
  private deps: SyncServiceDeps;

  constructor(deps: SyncServiceDeps) {
    this.deps = deps;
    deps.store.subscribe?.((rec) => this.noteSaved(rec));
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
    const rows: SyncRow[] = [];
    for (const { m, at } of cands.slice(0, limit)) {
      const rec = this.deps.store.loadShared ? this.deps.store.loadShared(m.id) : this.deps.store.load(m.id);
      if (!rec) continue;
      rows.push({ id: m.id, touchedAt: at, updatedAt: rec.updatedAt, sig: recordSig(rec), title: rec.title });
    }
    return { now: this.tick(), rows, more: cands.length > limit };
  }

  async get(owner: string, id: string): Promise<WireRecord | undefined> {
    const rec = this.deps.store.load(id);
    if (!rec || (rec.owner ?? "owner") !== owner) return undefined;
    const w = toWire(rec, this.deps.bots(owner));
    if (w || (!rec.bot && !rec.peer)) return w;
    try { await this.deps.bots(owner)?.list(); } catch { /* MIND unreachable */ }
    return toWire(rec, this.deps.bots(owner));
  }

  /** Merges incoming wire records into this owner's store. One push at a time per owner (a merge is read-modify-write). */
  push(owner: string, records: unknown[]): Promise<PushResult[]> {
    const prev = this.chains.get(owner) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.pushLocked(owner, records));
    this.chains.set(owner, run.catch(() => {}));
    return run;
  }

  private async pushLocked(owner: string, records: unknown[]): Promise<PushResult[]> {
    const out: PushResult[] = [];
    let bots = this.deps.bots(owner);
    let reconciled = false;
    for (const raw of records.slice(0, 50)) {
      const id = typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id : "";
      try {
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
        if (existing && recordSig(merged) === recordSig(existing) && merged.history.length === existing.history.length) {
          out.push({ id: rec.id, status: "same", sig: recordSig(existing) });
          continue;
        }
        await this.deps.store.save(merged);
        await this.deps.afterWrite?.(owner, rec.id).catch(() => {});
        out.push({ id: rec.id, status: "ok", sig: recordSig(merged) });
      } catch {
        out.push({ id, status: "error" });
      }
    }
    return out;
  }
}
