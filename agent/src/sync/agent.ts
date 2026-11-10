// Device side of session sync (the desktop app's local gateway). It mirrors this device's saved sessions to the signed-in user's
// store on daebot.live and pulls back what the phone or the web wrote, so a chat started on the Mac shows on the iPhone and the
// other way round. Transport: the user's own MIND key in X-MIND-Key (the same identity the desktop already signs in with).
// Rules: append-only transcripts merged by message id, last-writer-wins for the rest (see merge.ts). A session that is mid-turn
// is never overwritten; it is picked up on the next round.
import type { SessionStore, StoredSession } from "../persist.ts";
import type { BotsApi } from "../bots/types.ts";
import { mergeRecords, recordSig } from "./merge.ts";
import { NOT_SYNCED_SURFACES, fromWire, toWire } from "./wire.ts";
import type { WireRecord } from "./wire.ts";
import { SyncHttp } from "./http.ts";
import type { PushResult, SyncRow } from "./service.ts";

export const SYNC_OWNER = "owner";

export interface SyncAgentDeps {
  baseUrl: string;
  key: string;
  store: SessionStore;
  bots(): BotsApi | undefined;
  isBusy(id: string): boolean;
  /** A session was rewritten from the other side: reload a live idle copy. */
  afterWrite?(id: string): Promise<void>;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  fullEveryMs?: number;
  log?: (line: string) => void;
}

export interface SyncStatus { enabled: true; url: string; lastOkAt: number; lastError: string; pulled: number; pushed: number; dirty: number; rounds: number }

export class SyncAgent {
  private http: SyncHttp;
  private deps: SyncAgentDeps;
  private cursor = 0;
  private synced = new Map<string, string>(); // id -> sig last agreed with the server
  private dirty = new Set<string>();
  private retries = new Map<string, number>();
  private retryPull = new Set<string>();
  private timer?: NodeJS.Timeout;
  private kickTimer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private fails = 0;
  private lastFull = 0;
  private stopped = false;
  private unsub?: () => void;
  readonly status: SyncStatus;

  constructor(deps: SyncAgentDeps) {
    this.deps = deps;
    this.http = new SyncHttp({ baseUrl: deps.baseUrl, key: deps.key, fetchImpl: deps.fetchImpl });
    this.status = { enabled: true, url: this.http.url, lastOkAt: 0, lastError: "", pulled: 0, pushed: 0, dirty: 0, rounds: 0 };
  }

  start(): void {
    this.stopped = false;
    this.unsub = this.deps.store.subscribe?.((rec) => this.noteSaved(rec));
    const loop = () => {
      if (this.stopped) return;
      const full = Date.now() - this.lastFull > (this.deps.fullEveryMs ?? 10 * 60_000);
      this.round(full).finally(() => {
        if (this.stopped) return;
        const base = this.deps.intervalMs ?? 5000;
        this.timer = setTimeout(loop, Math.min(60_000, base * 2 ** Math.min(this.fails, 4)));
        this.timer.unref?.();
      });
    };
    loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.unsub?.();
  }

  /** A save on this device: send it soon (debounced), unless it is exactly what the server already has. */
  noteSaved(rec: StoredSession): void {
    if (NOT_SYNCED_SURFACES.has(rec.surface)) return;
    if ((rec.owner ?? SYNC_OWNER) !== SYNC_OWNER) return;
    if (this.synced.get(rec.id) === recordSig(rec)) return;
    this.dirty.add(rec.id);
    this.status.dirty = this.dirty.size;
    if (this.kickTimer || this.stopped) return;
    this.kickTimer = setTimeout(() => { this.kickTimer = undefined; void this.round(false); }, 1200);
    this.kickTimer.unref?.();
  }

  /** One pull + push round. Rounds never overlap. */
  round(full = false): Promise<void> {
    if (this.running) return this.running;
    this.running = this.roundOnce(full).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async roundOnce(full: boolean): Promise<void> {
    try {
      await this.pull(full);
      await this.flush();
      if (this.retryPull.size) await this.pull(false);
      this.fails = 0;
      this.status.lastOkAt = Date.now();
      this.status.lastError = "";
      this.status.rounds++;
      if (full) this.lastFull = Date.now();
    } catch (e) {
      this.fails++;
      const msg = String((e as Error)?.message ?? e).slice(0, 160);
      if (msg !== this.status.lastError) this.deps.log?.(`sync: ${msg}`);
      this.status.lastError = msg;
    }
    this.status.dirty = this.dirty.size;
  }

  private bots(): BotsApi | undefined { return this.deps.bots(); }

  /** Brings one session up to date from the server right now (a remote job needs the thread as it is on the other device). */
  async pullSession(id: string): Promise<void> {
    if (this.running) await this.running.catch(() => {});
    await this.pullRow(id, undefined);
  }

  private async pull(full: boolean): Promise<void> {
    let since = full ? 0 : this.cursor;
    const seen = new Set<string>();
    for (let page = 0; page < 200; page++) {
      const r = await this.http.json<{ now: number; rows: SyncRow[]; more: boolean }>("GET", `/api/sync/sessions?since=${since}&limit=200`);
      for (const row of r.rows) { seen.add(row.id); await this.pullRow(row.id, row.sig); }
      if (r.rows.length) { since = r.rows[r.rows.length - 1].touchedAt; this.cursor = Math.max(this.cursor, since); }
      if (!r.more) break;
    }
    for (const id of [...this.retryPull]) { this.retryPull.delete(id); await this.pullRow(id, undefined); }
    if (full) for (const m of this.deps.store.list()) if (!seen.has(m.id) && !NOT_SYNCED_SURFACES.has(m.surface) && (m.owner ?? SYNC_OWNER) === SYNC_OWNER) this.dirty.add(m.id);
  }

  private async pullRow(id: string, remoteSig: string | undefined): Promise<void> {
    const local = this.deps.store.load(id);
    if (local && (local.owner ?? SYNC_OWNER) !== SYNC_OWNER) return;
    if (local && remoteSig && recordSig(local) === remoteSig) { this.synced.set(id, remoteSig); this.dirty.delete(id); return; }
    if (this.deps.isBusy(id)) { this.retryPull.add(id); return; }
    let w: WireRecord;
    try { w = (await this.http.json<{ session: WireRecord }>("GET", `/api/sync/sessions/${encodeURIComponent(id)}`)).session; } catch (e) {
      if ((e as { status?: number }).status === 404) return;
      throw e;
    }
    let m = fromWire(w, this.bots(), SYNC_OWNER, "admin");
    if (!m.ok && m.reason === "nobot") {
      try { await this.bots()?.list(); } catch { /* MIND unreachable */ }
      m = fromWire(w, this.bots(), SYNC_OWNER, "admin");
    }
    if (!m.ok) { if (m.reason === "nobot") this.retryAfter(id); return; }
    const merged = mergeRecords(local, m.rec);
    const changed = !local || recordSig(merged) !== recordSig(local) || merged.history.length !== local.history.length;
    this.synced.set(id, recordSig(merged));
    if (changed) {
      await this.deps.store.save(merged);
      this.status.pulled++;
      await this.deps.afterWrite?.(id).catch(() => {});
    }
    if (recordSig(merged) !== recordSig(m.rec) || merged.history.length !== m.rec.history.length) this.dirty.add(id); else this.dirty.delete(id);
  }

  private retryAfter(id: string): void {
    const n = (this.retries.get(id) ?? 0) + 1;
    this.retries.set(id, n);
    if (n < 6) this.retryPull.add(id);
  }

  private async flush(): Promise<void> {
    if (!this.dirty.size) return;
    const ids = [...this.dirty];
    let batch: WireRecord[] = [];
    let bytes = 0;
    const send = async () => {
      if (!batch.length) return;
      const sent = batch;
      batch = []; bytes = 0;
      const r = await this.http.json<{ results: PushResult[] }>("POST", "/api/sync/sessions", { records: sent });
      for (const x of r.results) {
        if (x.status === "ok" || x.status === "same") {
          const local = this.deps.store.load(x.id);
          if (local && x.sig && recordSig(local) === x.sig) this.synced.set(x.id, x.sig);
          this.dirty.delete(x.id);
          this.retries.delete(x.id);
          if (x.status === "ok") this.status.pushed++;
          if (x.status === "ok" && x.sig && local && recordSig(local) !== x.sig) this.retryPull.add(x.id); // the server merged in more than we sent
        } else if (x.status === "busy" || x.status === "nobot" || x.status === "error") {
          const n = (this.retries.get(x.id) ?? 0) + 1;
          this.retries.set(x.id, n);
          if (n >= 8) this.dirty.delete(x.id);
        } else {
          this.dirty.delete(x.id); // forbidden, invalid, toolarge: never going to be accepted as it is
        }
      }
    };
    for (const id of ids) {
      const rec = this.deps.store.load(id);
      if (!rec) { this.dirty.delete(id); continue; }
      let w = toWire(rec, this.bots());
      if (!w && (rec.bot || rec.peer) && !NOT_SYNCED_SURFACES.has(rec.surface)) {
        try { await this.bots()?.list(); } catch { /* MIND unreachable */ }
        w = toWire(rec, this.bots());
      }
      if (!w) { if (NOT_SYNCED_SURFACES.has(rec.surface)) this.dirty.delete(id); continue; }
      const size = JSON.stringify(w).length;
      if (size > 6 * 1024 * 1024) { this.dirty.delete(id); continue; }
      if (batch.length >= 5 || bytes + size > 3 * 1024 * 1024) await send();
      batch.push(w); bytes += size;
    }
    await send();
    this.status.dirty = this.dirty.size;
  }
}
