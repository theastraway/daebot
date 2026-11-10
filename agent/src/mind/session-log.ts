// Every Daebot session, logged to the signed-in tenant's own MIND as an Agent Session (MIND Chat > Agents), from every device.
//
// One MIND Agent Session per Daebot session: source_key is the same on every device (`daebot`, or `daebot-bot-<slug>` for a bot's threads) and
// external_session_id is the Daebot session id (the same id on every device, because device sync keeps ids), so MIND's idempotent open gives the
// same MIND session everywhere and devices never create duplicates. Messages are appended as they happen, once: this logger reads the saved
// transcript from the session store, keeps a cursor per session, and only logs what THIS device wrote itself (a record that arrived by device
// sync was already logged by the device that ran it). A first run backfills every saved session. A delete closes the MIND session with a note;
// its history stays. Calls go through the MIND client (edge-fallback: gzip, other address) with the tenant's own key.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StoredSession, SessionStore } from "../persist.ts";
import type { HistoryEvent, MindClient } from "../types.ts";
import { pushReplies, redact } from "./session.ts";
import { isChatScopeError } from "./scope-upgrade.ts";

export const MAX_MESSAGE_CHARS = 20_000;
const BATCH = 20;

export interface LogMsg { role: "user" | "assistant" | "tool"; content: string }

/** The messages a stretch of transcript adds, and how many events it consumed. Assistant text is only logged once its turn is done. */
export function messagesFrom(history: HistoryEvent[], from: number, complete = false): { msgs: LogMsg[]; upTo: number } {
  const msgs: LogMsg[] = [];
  let upTo = from;
  let text = "";
  let tools = new Map<string, number>();
  const flushAssistant = () => {
    if (tools.size) msgs.push({ role: "tool", content: `Tools: ${[...tools].map(([t, n]) => (n > 1 ? `${t} x${n}` : t)).join(", ")}` });
    if (text.trim()) msgs.push({ role: "assistant", content: text });
    text = ""; tools = new Map();
  };
  for (let i = from; i < history.length; i++) {
    const ev = history[i];
    if (ev.type === "user") {
      flushAssistant(); // a turn that never finished (a crash): what it said so far is still logged
      const photos = ev.photos?.length ? `\n[${ev.photos.length} photo${ev.photos.length === 1 ? "" : "s"} attached: ${ev.photos.map((p) => p.name).join(", ")}]` : "";
      if (ev.text.trim() || photos) msgs.push({ role: "user", content: ev.text + photos });
      upTo = i + 1;
    } else if (ev.type === "text") text += ev.delta;
    else if (ev.type === "toolStart") tools.set(ev.tool, (tools.get(ev.tool) ?? 0) + 1);
    else if (ev.type === "done") {
      if (ev.finalText.trim()) text = ev.finalText;
      flushAssistant();
      upTo = i + 1;
    }
  }
  if (complete && (text.trim() || tools.size)) { flushAssistant(); upTo = history.length; } // a saved chat's last turn that never recorded its end (an old record, a crash)
  return { msgs, upTo };
}

interface Entry { mid?: string; n: number; title?: string; closed?: boolean }
interface Persisted { v: 1; sessions: Record<string, Entry> }

export interface SessionLoggerDeps {
  client: () => MindClient;
  store: SessionStore;
  /** The principal whose sessions this logs ("owner", or a MIND user id). Others' records in a shared store are ignored. */
  owner: string;
  /** undefined = this session is never logged. A bot-to-bot DM thread has its own source, so it is never mixed into the MAIN session other agents read. */
  sourceKeyOf(rec: Pick<StoredSession, "bot" | "peer">): string | undefined;
  /** The title a session is filed under in MIND (default: the chat's own title). */
  titleOf?(rec: Pick<StoredSession, "bot" | "peer" | "title">): string;
  /** Tags MIND files the session with (a bot-to-bot DM carries "bot-to-bot", so it can be told apart and filtered in MIND). */
  tagsOf?(rec: Pick<StoredSession, "bot" | "peer">): string[] | undefined;
  /** MIND answered 403 "lacks chat scope" on this owner's key: ask MIND to add the chat scopes to it (see scope-upgrade.ts). true = upgraded, retry. */
  upgradeScopes?(): Promise<boolean>;
  stateFile?: string;
  device?: { kind: string; label: string };
  retryMs?: number;
  log?: (line: string) => void;
}

export class SessionLogger {
  private d: SessionLoggerDeps;
  private st: Persisted = { v: 1, sessions: {} };
  private queue = new Set<string>();
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private unsubs: (() => void)[] = [];
  private seenReplies = new Set<string>();
  readonly stats = { opened: 0, appended: 0, closed: 0, errors: 0, upgraded: 0, lastError: "" };

  constructor(d: SessionLoggerDeps) {
    this.d = d;
    this.load();
  }

  setClient(c: () => MindClient): void { this.d = { ...this.d, client: c }; }

  private load(): void {
    if (!this.d.stateFile) return;
    try { const j = JSON.parse(readFileSync(this.d.stateFile, "utf8")); if (j?.v === 1 && j.sessions) this.st = j; } catch { /* first run */ }
  }
  private save(): void {
    if (!this.d.stateFile) return;
    try {
      mkdirSync(dirname(this.d.stateFile), { recursive: true, mode: 0o700 });
      const tmp = `${this.d.stateFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.st), { mode: 0o600 });
      renameSync(tmp, this.d.stateFile);
    } catch { /* a failed save only means a retry of the same messages is possible */ }
  }

  private mine(rec: { owner?: string }): boolean { return (rec.owner ?? "owner") === this.d.owner; }

  /** Starts listening to the store and backfills every saved session of this owner that was never logged. */
  start(): void {
    this.unsubs.push(this.d.store.subscribe?.((rec, origin) => this.noteSaved(rec, origin)) ?? (() => {}));
    this.unsubs.push(this.d.store.subscribeRemove?.((id, owner) => this.noteRemoved(id, owner)) ?? (() => {}));
    for (const m of this.d.store.list()) if (this.mine(m) && !this.st.sessions[m.id]?.closed) this.queue.add(m.id);
    this.kick();
  }

  stop(): void { for (const u of this.unsubs) u(); this.unsubs = []; if (this.timer) clearTimeout(this.timer); }

  noteSaved(rec: StoredSession, origin?: "sync"): void {
    if (!this.mine(rec) || this.st.sessions[rec.id]?.closed) return;
    if (origin === "sync") {
      // Written by device sync: the device that ran these turns logged them. Move the cursor past them so a later local turn logs only its own.
      const e = this.st.sessions[rec.id];
      if (e) { e.n = Math.max(e.n, rec.history.length); this.save(); }
      else { this.st.sessions[rec.id] = { n: rec.history.length }; this.save(); } // not logged here: the device that ran it (or this owner's hosted copy) does that
      return;
    }
    this.queue.add(rec.id);
    this.kick();
  }

  noteRemoved(id: string, owner: string | undefined): void {
    if ((owner ?? "owner") !== this.d.owner) return;
    const e = this.st.sessions[id];
    if (!e || e.closed) return;
    this.queue.add(id);
    this.kick();
  }

  /** Resolves when everything queued so far has been sent (tests, shutdown). */
  async flush(): Promise<void> {
    for (let i = 0; i < 50 && (this.queue.size || this.running); i++) { await (this.running ?? this.drain()); }
  }

  private kick(): void {
    if (this.running || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, 50);
    this.timer.unref?.();
  }

  private drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      let failed = false;
      for (const id of [...this.queue]) {
        this.queue.delete(id);
        try { await this.syncOne(id); } catch (e) {
          failed = true;
          this.stats.errors++;
          const msg = String((e as Error)?.message ?? e).slice(0, 160);
          if (msg !== this.stats.lastError) this.d.log?.(`mind-log: ${msg}`);
          this.stats.lastError = msg;
          this.queue.add(id);
        }
      }
      if (failed && !this.timer) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, this.d.retryMs ?? 60_000);
        this.timer.unref?.();
      }
    })().finally(() => { this.running = undefined; if (this.queue.size && !this.timer && !this.stopFlag()) this.kick(); });
    return this.running;
  }
  private stopFlag(): boolean { return false; }

  private lastUpgradeAt = 0;
  private async call(args: Record<string, unknown>): Promise<any> {
    const once = () => this.d.client().call("agent_sessions", args).then((t) => { try { return JSON.parse(t); } catch { return {}; } });
    try { return await once(); } catch (e) {
      // A key without the chat scopes: have MIND add them (at most once every 10 minutes), then the same call once more.
      if (this.d.upgradeScopes && isChatScopeError(e) && Date.now() - this.lastUpgradeAt > 10 * 60_000) {
        this.lastUpgradeAt = Date.now();
        if (await this.d.upgradeScopes()) { this.stats.upgraded++; return await once(); }
      }
      throw e;
    }
  }

  private harvest(id: string, data: any): void {
    const out: string[] = [];
    for (const r of Array.isArray(data?.pending_replies) ? data.pending_replies : []) {
      const content = typeof r === "string" ? r : String(r?.content ?? "");
      if (!content) continue;
      const rid = typeof r === "object" && r?.id ? String(r.id) : content;
      if (this.seenReplies.has(rid)) continue;
      this.seenReplies.add(rid);
      const who = typeof r === "object" && r?.meta?.replied_by ? String(r.meta.replied_by) : "";
      out.push(who ? `[${who}] ${content}` : content);
    }
    if (out.length) pushReplies(id, out);
  }

  private async syncOne(id: string): Promise<void> {
    const entry = (this.st.sessions[id] ??= { n: 0 });
    const rec = this.d.store.load(id);
    if (!rec) {
      // Deleted: the MIND session is closed with a note; its transcript stays.
      if (entry.mid && !entry.closed) {
        const data = await this.call({ action: "close", session_id: entry.mid, status: "ended", summary: "This chat was deleted in Daebot. The transcript above is kept." });
        this.harvest(id, data);
        this.stats.closed++;
      }
      entry.closed = true;
      this.save();
      return;
    }
    if (!this.mine(rec)) return;
    const key = this.d.sourceKeyOf(rec);
    if (!key) return; // never logged (a bot whose slug is unknown here)
    const title = (this.d.titleOf ? this.d.titleOf(rec) : rec.title || "Daebot session").slice(0, 200);
    const fresh = !entry.mid;
    if (!entry.mid) {
      const data = await this.call({
        // runtime "mindclaw" and no device hint, on purpose: MIND files a session under <runtime>@<device>, so a per-device hint would give each
        // device its own MIND session for the same chat. This is also the source the earlier per-turn logging used, so existing sessions resume.
        action: "open", source_key: key, external_session_id: id, runtime: "mindclaw", title,
        ...(this.d.tagsOf?.(rec)?.length ? { tags: this.d.tagsOf(rec) } : {}),
      });
      if (!data?.session_id) throw new Error("MIND did not return a session id");
      entry.mid = String(data.session_id);
      this.stats.opened++;
      this.harvest(id, data);
      // Another device (or an older run) already logged this session: do not write its history a second time.
      const had = Number(data.message_count ?? data.messages_count ?? data.count ?? 0);
      if (data.resumed === true && had > 0 && entry.n === 0) entry.n = rec.history.length;
      this.save();
    }
    const { msgs, upTo } = messagesFrom(rec.history, entry.n, fresh && entry.n === 0 && rec.run?.status !== "running");
    const titleChanged = !fresh && entry.title !== undefined && entry.title !== title;
    if (!msgs.length && !titleChanged) { entry.n = Math.max(entry.n, upTo); entry.title = title; this.save(); return; }
    const clean = msgs.map((m) => ({ role: m.role, content: redact(m.content).slice(0, MAX_MESSAGE_CHARS) })).filter((m) => m.content.trim());
    for (let i = 0; i < Math.max(1, clean.length); i += BATCH) {
      const batch = clean.slice(i, i + BATCH);
      if (!batch.length && !titleChanged) break;
      const data = await this.call({ action: "append", session_id: entry.mid, messages: batch, title });
      this.stats.appended += batch.length;
      this.harvest(id, data);
    }
    entry.n = upTo;
    entry.title = title;
    this.save();
  }
}

// One logger per (store, owner): a hosted runtime is rebuilt when a user's key rotates, and a second logger would write every message twice.
const registry = new WeakMap<object, Map<string, SessionLogger>>();
export function loggerFor(deps: SessionLoggerDeps): SessionLogger {
  let m = registry.get(deps.store);
  if (!m) registry.set(deps.store, (m = new Map()));
  const have = m.get(deps.owner);
  if (have) { have.setClient(deps.client); return have; }
  const l = new SessionLogger(deps);
  m.set(deps.owner, l);
  l.start();
  return l;
}
