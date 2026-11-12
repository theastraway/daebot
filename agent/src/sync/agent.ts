// Device side of session sync (the desktop app's local gateway). It mirrors this device's saved sessions to the signed-in user's
// store on daebot.live and pulls back what the phone or the web wrote, so a chat started on the Mac shows on the iPhone and the
// other way round. Transport: the user's own MIND key in X-MIND-Key (the same identity the desktop already signs in with).
// Rules: append-only transcripts merged by message id, last-writer-wins for the rest (see merge.ts). A session that is mid-turn
// is never overwritten; it is picked up on the next round.
import type { SessionStore, StoredSession } from "../persist.ts";
import type { BotsApi } from "../bots/types.ts";
import { homeSig, mergeRecords, recordSig } from "./merge.ts";
import { defaultHome, isEnvBy, normalizeEnv } from "../env.ts";
import type { EnvBy, EnvGroup, EnvTag } from "../env.ts";
import { NOT_SYNCED_SURFACES, fromWire, toWire } from "./wire.ts";
import type { WireRecord } from "./wire.ts";
import { SyncHttp } from "./http.ts";
import { TombstoneBook } from "./tombstones.ts";
import type { PhotoStore } from "../photos.ts";
import { photoIdsIn, reconcilePhotos } from "./photos.ts";
import type { PushResult, SyncRow } from "./service.ts";
import { RoutineSyncAgent } from "./routines.ts";
import { BotSyncAgent } from "./bots.ts";
import type { SettingsStore } from "../settings.ts";
import type { RoutineHub } from "../routines/store.ts";

export const SYNC_OWNER = "owner";

export interface SyncAgentDeps {
  baseUrl: string;
  key: string;
  store: SessionStore;
  bots(): BotsApi | undefined;
  /** This device's home environment: a session this device made and daebot.live has not seen yet is stamped with it on its way up. */
  env?: EnvTag;
  /** What this device tells daebot.live about itself on every push (the server records the first device that pushed a session it had not seen). */
  device?: { id: string; name: string; kind: "machine" | "server" };
  isBusy(id: string): boolean;
  /** A session was rewritten from the other side: reload a live idle copy. */
  afterWrite?(id: string): Promise<void>;
  /** The other side deleted this session: delete it here (close a live copy, remove the record and its photos). */
  deleteLocal?(id: string): Promise<void>;
  /** This device's photo store: photos attached in a chat travel with the chat. */
  photos?(): PhotoStore | undefined;
  /** Where this device remembers its deletes (a restart or an offline stretch must not lose them). Default: in memory. */
  tombstones?: TombstoneBook;
  /** How often bots trade with the server when nothing changed here (ms). Default 15 s. */
  botEveryMs?: number;
  /** This device's per-user settings (the main Daebot's look and instructions sync with the bots). */
  settings?(): SettingsStore | undefined;
  /** This device's routines (late-bound: the hub is built after the sync agent). Present = routine definitions and run records sync too. */
  routines?(): RoutineHub | undefined;
  /** Where this device remembers its routine deletes. Default: in memory. */
  routineTombstones?: TombstoneBook;
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
  private onServer = new Set<string>(); // ids the server is known to hold (a record the server holds was not born on this device)
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
  private unsubRemove?: () => void;
  private photoSig = new Map<string, string>(); // session id -> the photo ids already traded with the server
  private applying = new Set<string>(); // deletes this agent is applying from the server (not echoed back)
  readonly tombs: TombstoneBook;
  readonly status: SyncStatus;
  /** The account's computers and servers (one per machine) and the cloud's name, as daebot.live last sent them: every device shows the same places under the same names. */
  envGroups: EnvGroup[] = [];
  cloudName?: string;
  private routineAgent?: RoutineSyncAgent;
  private routineErr = "";
  private botAgent?: BotSyncAgent;
  private botErr = "";
  private botDue = 0;

  constructor(deps: SyncAgentDeps) {
    this.deps = deps;
    this.http = new SyncHttp({ baseUrl: deps.baseUrl, key: deps.key, fetchImpl: deps.fetchImpl });
    this.tombs = deps.tombstones ?? new TombstoneBook();
    if (deps.routines) this.routineAgent = new RoutineSyncAgent({ http: this.http, hub: deps.routines, owner: SYNC_OWNER, bots: () => deps.bots(), tombstones: deps.routineTombstones ?? new TombstoneBook(), log: deps.log });
    this.botAgent = new BotSyncAgent({ http: this.http, bots: () => deps.bots(), settings: () => deps.settings?.(), log: deps.log });
    this.status = { enabled: true, url: this.http.url, lastOkAt: 0, lastError: "", pulled: 0, pushed: 0, dirty: 0, rounds: 0 };
  }

  start(): void {
    this.stopped = false;
    this.unsub = this.deps.store.subscribe?.((rec) => this.noteSaved(rec));
    this.unsubRemove = this.deps.store.subscribeRemove?.((id, owner) => this.noteRemoved(id, owner));
    if (this.tombs.pending().length) this.kick();
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
    this.unsubRemove?.();
  }

  private kick(): void {
    if (this.kickTimer || this.stopped) return;
    this.kickTimer = setTimeout(() => { this.kickTimer = undefined; void this.round(false); }, 400);
    this.kickTimer.unref?.();
  }

  /** A session was deleted on this device: remember it (so it is never pulled back) and tell the server soon. */
  noteRemoved(id: string, owner: string | undefined): void {
    if ((owner ?? SYNC_OWNER) !== SYNC_OWNER) return;
    this.tombs.mark(SYNC_OWNER, id);
    this.dirty.delete(id);
    this.synced.delete(id);
    if (this.applying.has(id)) return; // the server already knows
    this.tombs.addPending(id);
    this.kick();
  }

  private async applyRemoteDelete(id: string): Promise<void> {
    this.tombs.mark(SYNC_OWNER, id);
    this.dirty.delete(id);
    const local = this.deps.store.meta?.(id) ?? this.deps.store.load(id);
    if (!local || (local.owner ?? SYNC_OWNER) !== SYNC_OWNER) return;
    this.applying.add(id);
    try {
      if (this.deps.deleteLocal) await this.deps.deleteLocal(id);
      else await this.deps.store.remove?.(id);
      this.status.pulled++;
    } finally { this.applying.delete(id); }
  }

  /** A save on this device: send it soon (debounced), unless it is exactly what the server already has. */
  noteSaved(rec: StoredSession): void {
    if (NOT_SYNCED_SURFACES.has(rec.surface)) return;
    if ((rec.owner ?? SYNC_OWNER) !== SYNC_OWNER) return;
    if (this.tombs.has(SYNC_OWNER, rec.id)) return;
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
      await this.routineRound(full);
      await this.botRound(full);
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

  /** Routines trade after the sessions. A problem here is logged and retried next round; it never fails the session sync. */
  private async routineRound(full: boolean): Promise<void> {
    if (!this.routineAgent) return;
    try { await this.routineAgent.round(full); this.routineErr = ""; } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 160);
      if (msg !== this.routineErr) this.deps.log?.(`sync routines: ${msg}`);
      this.routineErr = msg;
    }
  }

  /** Bots (look, pin, instructions, order) and the main Daebot's look trade after the routines: every ~15 s, at once after a local edit, and on a full round. A problem is logged and retried; it never fails the session sync. */
  private async botRound(full: boolean): Promise<void> {
    if (!this.botAgent) return;
    const now = Date.now();
    if (!full && now < this.botDue) return;
    try { await this.botAgent.round(); this.botErr = ""; this.botDue = now + (this.deps.botEveryMs ?? 15_000); } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 160);
      if (msg !== this.botErr) this.deps.log?.(`sync bots: ${msg}`);
      this.botErr = msg;
      this.botDue = now + (this.deps.botEveryMs ?? 15_000);
    }
  }

  /** A bot (or the main Daebot's look) was edited here: trade it with the server at once. */
  noteBotsChanged(): void { this.botDue = 0; this.kick(); }

  get botStats(): { pushed: number; pulled: number; error: string } | undefined { return this.botAgent ? { ...this.botAgent.stats, error: this.botErr } : undefined; }

  /** Routine counters (pulled/pushed/deleted since start). */
  get routineStats(): { pulled: number; pushed: number; deleted: number; error: string } | undefined { return this.routineAgent ? { ...this.routineAgent.stats, error: this.routineErr } : undefined; }

  /** Renames an environment of this account on daebot.live (an empty name puts the automatic one back) and takes the new names right away. */
  async renameEnv(id: string, name: string): Promise<void> {
    await this.http.json("POST", "/api/sync/envs/rename", { id, name });
    const r = await this.http.json<{ envGroups?: EnvGroup[]; cloudName?: string }>("GET", "/api/sync/sessions?since=9007199254740991&limit=1"); // no rows, just the names that ride on every list answer
    if (Array.isArray(r.envGroups)) { this.envGroups = r.envGroups.filter((g) => !!normalizeEnv(g) && Array.isArray(g.members) && Array.isArray(g.keys)).slice(0, 100); this.cloudName = typeof r.cloudName === "string" ? r.cloudName : undefined; }
  }

  /** The person moved a session between MIND Cloud and a computer: send it soon (the record carries the new home and its time). */
  noteHomeChanged(id: string): void {
    this.synced.delete(id);
    this.dirty.add(id);
    this.status.dirty = this.dirty.size;
    this.kick();
  }

  /** Pushes one session to daebot.live right now: a turn that runs in MIND Cloud needs the thread as it is on this computer. A session that is not saved yet has nothing to send. */
  async pushSession(id: string): Promise<void> {
    if (this.running) await this.running.catch(() => {});
    if (!this.deps.store.load(id)) return;
    this.dirty.add(id);
    await this.round(false);
    if (this.status.lastError) throw new Error(this.status.lastError);
  }

  /**
   * Runs one user message of a session in MIND Cloud (POST /api/agent/turn on daebot.live, with this account's key) and hands every event of the turn to
   * `emit` as it streams. The cloud session is the same session (same id); when the turn ends the caller pulls the transcript back.
   */
  async cloudTurn(a: { sessionId: string; text: string; surface: string; title?: string; botSlug?: string; quote?: { id?: string; text: string }; photos?: { name: string; dataUrl: string }[] }, emit: (ev: import("../types.ts").AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    await this.http.sse("/api/agent/turn", { text: a.text, sessionId: a.sessionId, surface: a.surface, ...(a.title ? { title: a.title } : {}), ...(a.botSlug ? { bot: a.botSlug } : {}), ...(a.quote ? { quote: a.quote } : {}), ...(a.photos?.length ? { photos: a.photos } : {}) }, (o) => {
      const ev = o as { type?: string };
      if (!ev || typeof ev.type !== "string" || ev.type === "session") return;
      emit(o as import("../types.ts").AgentEvent);
    }, signal);
  }

  /** Stops a turn of this session that is running in MIND Cloud. */
  async abortCloud(id: string): Promise<void> {
    await this.http.json("POST", `/api/sync/sessions/${encodeURIComponent(id)}/abort`, {}).catch(() => {});
  }

  /** Brings one session up to date from the server right now (a remote job needs the thread as it is on the other device). */
  async pullSession(id: string): Promise<void> {
    if (this.running) await this.running.catch(() => {});
    await this.pullRow(id, undefined);
  }

  private async pull(full: boolean): Promise<void> {
    let since = full ? 0 : this.cursor;
    const seen = new Set<string>();
    for (let page = 0; page < 200; page++) {
      const r = await this.http.json<{ now: number; rows: SyncRow[]; more: boolean; envGroups?: EnvGroup[]; cloudName?: string }>("GET", `/api/sync/sessions?since=${since}&limit=200`);
      if (Array.isArray(r.envGroups)) { this.envGroups = r.envGroups.filter((g) => !!normalizeEnv(g) && Array.isArray(g.members) && Array.isArray(g.keys)).slice(0, 100); this.cloudName = typeof r.cloudName === "string" ? r.cloudName : undefined; }
      for (const row of r.rows) {
        seen.add(row.id);
        if (!row.deleted) this.onServer.add(row.id);
        if (row.deleted) { await this.applyRemoteDelete(row.id); continue; }
        await this.pullRow(row.id, row.sig, row.env ? { env: normalizeEnv(row.env), envAt: typeof row.envAt === "number" ? row.envAt : 0, envBy: isEnvBy(row.envBy) ? row.envBy : undefined } : undefined);
      }
      if (r.rows.length) { since = r.rows[r.rows.length - 1].touchedAt; this.cursor = Math.max(this.cursor, since); }
      if (!r.more) break;
    }
    for (const id of [...this.retryPull]) { this.retryPull.delete(id); await this.pullRow(id, undefined); }
    if (full) for (const m of this.deps.store.list()) if (!seen.has(m.id) && !this.tombs.has(SYNC_OWNER, m.id) && !NOT_SYNCED_SURFACES.has(m.surface) && (m.owner ?? SYNC_OWNER) === SYNC_OWNER) this.dirty.add(m.id);
  }

  private async pullRow(id: string, remoteSig: string | undefined, remoteHome?: { env?: EnvTag; envAt: number; envBy?: EnvBy }): Promise<void> {
    if (this.tombs.has(SYNC_OWNER, id)) return; // deleted here: never brought back (the delete itself is sent in flush)
    const local = this.deps.store.load(id);
    if (local && (local.owner ?? SYNC_OWNER) !== SYNC_OWNER) return;
    if (local && remoteSig && recordSig(local) === remoteSig) {
      this.synced.set(id, remoteSig); this.dirty.delete(id); this.onServer.add(id);
      // Same transcript on both sides: only the home can differ. The latest decision about it wins (the person's toggle, or the migration that put an
      // auto-stamped computer back on MIND Cloud); a copy with no home takes the server's.
      const re = remoteHome?.env;
      if (re && (!local.env || (remoteHome!.envAt > (local.envAt ?? 0) && local.env.id !== re.id)) && (local.owner ?? SYNC_OWNER) === SYNC_OWNER && !this.deps.isBusy(id)) await this.deps.store.save({ ...local, env: re, ...(remoteHome!.envAt ? { envAt: remoteHome!.envAt } : {}), ...(remoteHome!.envBy ? { envBy: remoteHome!.envBy } : {}) }, { origin: "sync" });
      await this.syncPhotos(id, local.history); return;
    }
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
    this.onServer.add(id);
    const merged = mergeRecords(local, m.rec);
    const changed = !local || recordSig(merged) !== recordSig(local) || merged.history.length !== local.history.length || homeSig(merged) !== homeSig(local);
    this.synced.set(id, recordSig(merged));
    if (changed) {
      await this.deps.store.save(merged, { origin: "sync" });
      this.status.pulled++;
      await this.deps.afterWrite?.(id).catch(() => {});
    }
    if (recordSig(merged) !== recordSig(m.rec) || merged.history.length !== m.rec.history.length || homeSig(merged) !== homeSig(m.rec)) this.dirty.add(id); else this.dirty.delete(id);
    await this.syncPhotos(id, merged.history);
  }

  /** Trades the photos of one session with the server (those the transcript names, and those only this device holds). A failure retries next round. */
  private async syncPhotos(id: string, history: StoredSession["history"]): Promise<void> {
    const photos = this.deps.photos?.();
    if (!photos) return;
    const want = photoIdsIn(history);
    const local = photos.list(id).map((p) => p.id);
    if (!want.length && !local.length) return;
    const key = [...new Set([...want, ...local])].sort().join(",");
    if (this.photoSig.get(id) === key) return;
    try {
      const r = await reconcilePhotos({ http: this.http, photos, sessionId: id, want });
      if (r.refused.length) this.deps.log?.(`sync: ${r.refused.length} photo(s) of a chat could not be copied (too large, or storage is full)`);
      this.photoSig.set(id, [...new Set([...want, ...photos.list(id).map((p) => p.id)])].sort().join(","));
    } catch (e) {
      this.retryPull.add(id); // transport trouble: look at this session again next round
      void e;
    }
  }

  /** A remote job names photos that live on daebot.live: fetch them into this device's store before the turn runs. */
  async fetchPhotos(sessionId: string, ids: string[]): Promise<void> {
    const photos = this.deps.photos?.();
    if (!photos || !ids.length) return;
    const r = await reconcilePhotos({ http: this.http, photos, sessionId, want: ids });
    const have = new Set(photos.list(sessionId).map((p) => p.id));
    const missing = ids.filter((i) => !have.has(i));
    if (missing.length) throw new Error(`could not fetch photo ${missing[0]} from daebot.live${r.refused.includes(missing[0]) ? " (too large or storage is full)" : ""}`);
  }

  private retryAfter(id: string): void {
    const n = (this.retries.get(id) ?? 0) + 1;
    this.retries.set(id, n);
    if (n < 6) this.retryPull.add(id);
  }

  private async flushDeletes(): Promise<void> {
    for (const id of this.tombs.pending()) {
      try {
        await this.http.json<{ ok: boolean }>("DELETE", `/api/sync/sessions/${encodeURIComponent(id)}`);
        this.tombs.clearPending(id);
      } catch (e) {
        const st = (e as { status?: number }).status;
        if (st === 403 || st === 404) this.tombs.clearPending(id); // not ours / not there: nothing to tell
        else throw e;
      }
    }
  }

  private async flush(): Promise<void> {
    await this.flushDeletes();
    if (!this.dirty.size) return;
    const ids = [...this.dirty];
    let batch: WireRecord[] = [];
    let bytes = 0;
    const send = async () => {
      if (!batch.length) return;
      const sent = batch;
      batch = []; bytes = 0;
      const r = await this.http.json<{ results: PushResult[] }>("POST", "/api/sync/sessions", { records: sent, ...(this.deps.device ? { device: this.deps.device } : {}) });
      for (const x of r.results) {
        if (x.status === "ok" || x.status === "same") {
          const local = this.deps.store.load(x.id);
          if (local && x.sig && recordSig(local) === x.sig) this.synced.set(x.id, x.sig);
          this.dirty.delete(x.id);
          this.retries.delete(x.id);
          if (x.status === "ok") this.status.pushed++;
          if (local) await this.syncPhotos(x.id, local.history);
          if (x.status === "ok" && x.sig && local && recordSig(local) !== x.sig) this.retryPull.add(x.id); // the server merged in more than we sent
        } else if (x.status === "deleted") {
          await this.applyRemoteDelete(x.id).catch(() => {});
          this.retries.delete(x.id);
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
      if (this.tombs.has(SYNC_OWNER, id)) { this.dirty.delete(id); continue; }
      const rec = this.deps.store.load(id);
      if (!rec) { this.dirty.delete(id); continue; }
      let w = toWire(rec, this.bots());
      if (!w && (rec.bot || rec.peer) && !NOT_SYNCED_SURFACES.has(rec.surface)) {
        try { await this.bots()?.list(); } catch { /* MIND unreachable */ }
        w = toWire(rec, this.bots());
      }
      if (!w) { if (NOT_SYNCED_SURFACES.has(rec.surface)) this.dirty.delete(id); continue; }
      // A record with no home (made before environments) starts on MIND Cloud, the standard: a computer is only ever the person's choice. (A copy the
      // server already holds keeps whatever home the server gave it.)
      if (!w.env && this.deps.env && !this.onServer.has(id)) { w.env = defaultHome(this.deps.env); w.envAt = Date.now(); w.envBy = "default"; }
      const size = JSON.stringify(w).length;
      if (size > 6 * 1024 * 1024) { this.dirty.delete(id); continue; }
      if (batch.length >= 5 || bytes + size > 3 * 1024 * 1024) await send();
      batch.push(w); bytes += size;
    }
    await send();
    this.status.dirty = this.dirty.size;
  }
}
