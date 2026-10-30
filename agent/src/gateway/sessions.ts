import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentSession, DeviceBridge, MessageQuote, PhotoRef, Runtime } from "../types.ts";
import type { SessionPermMode } from "../permissions/store.ts";

export class BusyError extends Error {}
export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}

/** Owner key for sessions opened by the single-tenant paths (local gateway, in-process channels, the hosted owner login). */
export const LOCAL_OWNER = "owner";

export interface LiveSession {
  id: string;
  surface: string;
  title: string;
  session: AgentSession;
  busy: boolean;
  abort: AbortController | null;
  lastUsed: number;
  createdAt: number;
  turns: number; // user messages sent through this gateway process; 0 = prewarmed and untouched
  /** Principal id that opened it. Another principal can never list, open, send to, abort or close it. */
  owner: string;
  /** Bot id when this is a thread of a bot (and `peer`: the other end of a bot-to-bot DM thread). */
  bot?: string;
  peer?: string;
  /** Identity tier this session was opened with (undefined = the runtime's own). */
  identity?: string;
  /** A fresh random value per turn (the bot bus keys its per-user-message budget on it). */
  turnNonce: string;
}

export interface SessionRow { id: string; surface: string; title: string; updatedAt: number; live: boolean; busy: boolean; bot?: string; peer?: string; model?: string; permMode?: string; unread?: boolean; archived?: boolean }

export const IDLE_MS = 6 * 60 * 60 * 1000;
export const EMPTY_IDLE_MS = 15 * 60 * 1000; // a session nobody has written to is dropped sooner

export class SessionManager {
  private live = new Map<string, LiveSession>();
  private runtime: Runtime;
  private idleMs: number;
  private timer: NodeJS.Timeout | null = null;

  /** Called once for every user message accepted in a bot's own thread (not routine runs, not bot-to-bot DMs). Used by thread_message routines. */
  onUserMessage?: (ls: LiveSession, text: string) => void;
  /** Called once when a turn in a bot's own thread ends (not routine runs, not bot-to-bot DMs, not an abort). Used by turn_done routines. */
  onTurnDone?: (ls: LiveSession, r: { ok: boolean; text: string }) => void;
  private runtimeFor?: (owner: string) => Runtime;
  /** Owner of a persisted (not live) session, from the shared store; undefined = unknown id. */
  private storedOwner?: (id: string) => string | undefined;

  constructor(runtime: Runtime, opts: { idleMs?: number; sweepMs?: number; runtimeFor?: (owner: string) => Runtime; storedOwner?: (id: string) => string | undefined } = {}) {
    this.runtime = runtime;
    this.runtimeFor = opts.runtimeFor;
    this.storedOwner = opts.storedOwner;
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.timer = setInterval(() => void this.sweep(), opts.sweepMs ?? 10 * 60 * 1000);
    this.timer.unref();
  }

  async open(o: { surface: string; title?: string; resumeId?: string; identity?: string; owner?: string; bot?: string; peer?: string; model?: string }): Promise<LiveSession> {
    const owner = o.owner ?? LOCAL_OWNER;
    if (o.resumeId) {
      const existing = this.live.get(o.resumeId);
      if (existing) {
        if (existing.owner !== owner) throw new ForbiddenError("forbidden");
        if (o.bot && existing.bot !== o.bot) throw new Error("session belongs to a different bot");
        existing.lastUsed = Date.now();
        return existing;
      }
    }
    if (o.resumeId) {
      const stored = this.storedOwner?.(o.resumeId);
      if (stored !== undefined && stored !== owner) throw new ForbiddenError("forbidden");
    }
    const rt = this.runtimeFor ? this.runtimeFor(owner) : this.runtime;
    const session = await rt.openSession({ surface: o.surface, title: o.title, resumeId: o.resumeId, identity: o.identity, botId: o.bot, peer: o.peer, model: o.model });
    const info = rt.sessionInfo?.(session.id);
    const existing = this.live.get(session.id);
    if (existing) {
      if (existing.owner !== owner) throw new ForbiddenError("forbidden");
      return existing;
    }
    const now = Date.now();
    const ls: LiveSession = {
      id: session.id,
      surface: session.surface || o.surface,
      title: o.title ?? "",
      session,
      busy: false,
      abort: null,
      lastUsed: now,
      createdAt: now,
      turns: 0,
      owner,
      bot: info?.bot ?? o.bot,
      peer: info?.peer ?? o.peer,
      identity: o.identity,
      turnNonce: randomUUID(),
    };
    this.live.set(ls.id, ls);
    return ls;
  }

  get(id: string): LiveSession | undefined {
    return this.live.get(id);
  }

  /** Ownership-checked lookup: the session, "forbidden" when it belongs to someone else, or undefined when unknown. */
  access(id: string, owner: string): LiveSession | "forbidden" | undefined {
    const ls = this.live.get(id);
    if (!ls) {
      // Not live: a persisted session still belongs to its owner.
      const stored = this.storedOwner?.(id);
      return stored !== undefined && stored !== owner ? "forbidden" : undefined;
    }
    return ls.owner === owner ? ls : "forbidden";
  }

  /** The runtime a principal acts through (history lookups go through it so they are tenant-scoped). */
  runtimeOf(owner: string): Runtime {
    return this.runtimeFor ? this.runtimeFor(owner) : this.runtime;
  }

  count(): number {
    return this.live.size;
  }

  /** Sessions of one owner. Bot threads are left out by default; `bot` returns only that bot's threads. */
  list(owner: string = LOCAL_OWNER, filter: { bot?: string; archived?: boolean } = {}): SessionRow[] {
    const out = new Map<string, SessionRow>();
    try {
      for (const s of (this.runtimeFor ? this.runtimeFor(owner) : this.runtime).listSessions()) {
        const other = this.live.get(s.id);
        if (other && other.owner !== owner) continue;
        out.set(s.id, { ...s, live: false, busy: false });
      }
    } catch {
      /* runtime listing is best-effort */
    }
    for (const ls of this.live.values()) {
      if (ls.owner !== owner) continue;
      const prev = out.get(ls.id);
      // Prewarmed sessions with no message yet stay out of the list (the client keeps its own current id).
      // A resumed session is in the runtime listing already, so it stays.
      if (ls.turns === 0 && !prev) continue;
      out.set(ls.id, {
        id: ls.id,
        surface: ls.surface,
        title: prev?.title || ls.title || "Untitled",
        updatedAt: Math.max(prev?.updatedAt ?? 0, ls.lastUsed),
        live: true,
        busy: ls.busy,
        ...((prev?.bot ?? ls.bot) ? { bot: prev?.bot ?? ls.bot } : {}),
        ...((prev?.peer ?? ls.peer) ? { peer: prev?.peer ?? ls.peer } : {}),
        ...(prev?.model ? { model: prev.model } : {}),
        ...(prev?.permMode ? { permMode: prev.permMode } : {}),
        ...(prev?.unread ? { unread: true } : {}),
        ...(prev?.archived ? { archived: true } : {}),
      });
    }
    return [...out.values()].filter((r) => (filter.archived || !r.archived) && (filter.bot ? r.bot === filter.bot : !r.bot && !r.peer)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Runs one turn. Throws BusyError / NotFoundError synchronously-in-promise before any event is emitted. */
  async turn(id: string, text: string, onEvent: (e: AgentEvent) => void, external?: AbortSignal, origin: "user" | "bot" = "user", interactive = false, photos?: PhotoRef[], client?: { capabilities?: string[]; device?: DeviceBridge; peerReceipt?: string }, quote?: MessageQuote): Promise<void> {
    const ls = this.live.get(id);
    if (!ls) throw new NotFoundError("no such session");
    if (ls.busy) throw new BusyError("session is busy with another turn");
    ls.busy = true; // set synchronously: no await between check and set
    ls.turns++;
    if (origin === "user" && ls.bot && !ls.peer && ls.surface !== "routine" && this.onUserMessage) { try { this.onUserMessage(ls, text); } catch { /* a routine hook never blocks a message */ } }
    ls.turnNonce = randomUUID();
    const ac = new AbortController();
    ls.abort = ac;
    const onExternal = () => ac.abort();
    if (external) {
      if (external.aborted) ac.abort();
      else external.addEventListener("abort", onExternal, { once: true });
    }
    let sawDone = false, failedMsg = "", finalText = "";
    try {
      for await (const ev of ls.session.send(text, { signal: ac.signal, origin, interactive, ...(quote ? { quote } : {}), ...(photos?.length ? { photos } : {}), ...(client?.capabilities?.length ? { capabilities: client.capabilities } : {}), ...(client?.device ? { device: client.device } : {}), ...(origin === "bot" && client?.peerReceipt ? { peerReceipt: client.peerReceipt } : {}) })) {
        if (ev.type === "done") { sawDone = true; finalText = ev.finalText; }
        if (ev.type === "notice" && /^Turn failed/.test(ev.text)) failedMsg = ev.text;
        onEvent(ev);
        if (sawDone) break;
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        failedMsg = `Turn failed: ${msg.slice(0, 300)}`;
        onEvent({ type: "notice", level: "warn", text: failedMsg });
      }
    } finally {
      if (!sawDone) {
        if (ac.signal.aborted) onEvent({ type: "notice", level: "info", text: "Turn aborted." });
        onEvent({ type: "done", finalText: "" });
      }
      external?.removeEventListener("abort", onExternal);
      const aborted = ac.signal.aborted;
      ls.busy = false;
      ls.abort = null;
      ls.lastUsed = Date.now();
      if (!aborted && ls.bot && !ls.peer && ls.surface !== "routine" && this.onTurnDone) { try { this.onTurnDone(ls, { ok: !failedMsg, text: failedMsg || finalText }); } catch { /* a routine hook never breaks a turn */ } }
    }
  }

  /** Whether any live thread of the bot exists / is mid-turn. */
  botState(owner: string, botId: string): { live: boolean; busy: boolean } {
    let live = false, busy = false;
    for (const ls of this.live.values()) if (ls.owner === owner && ls.bot === botId) { live = true; busy = busy || ls.busy; }
    return { live, busy };
  }

  /** Closes every live session of one bot (the bot was deleted). */
  async closeBotSessions(owner: string, botId: string): Promise<void> {
    for (const ls of [...this.live.values()]) if (ls.owner === owner && (ls.bot === botId || ls.peer === botId)) await this.close(ls.id, "bot deleted");
  }

  /** Permanently deletes one session of an owner (live and/or saved). false = unknown id. The caller has already passed access(). */
  async deleteSession(id: string, owner: string): Promise<boolean> {
    const ls = this.live.get(id);
    if (ls && ls.owner !== owner) throw new ForbiddenError("forbidden");
    if (ls) await this.close(id, "deleted");
    const rt = this.runtimeFor ? this.runtimeFor(owner) : this.runtime;
    return (await rt.deleteSession?.(id)) === true || !!ls;
  }

  /** Renames one session of an owner (live and/or saved). The caller has already passed access(). false = unknown id. */
  async rename(id: string, owner: string, title: string): Promise<boolean> {
    const ls = this.live.get(id);
    if (ls && ls.owner !== owner) throw new ForbiddenError("forbidden");
    const rt = this.runtimeFor ? this.runtimeFor(owner) : this.runtime;
    const ok = (await rt.renameSession?.(id, title)) === true;
    if (ok && ls) ls.title = title;
    return ok;
  }

  /** Changes the model the NEXT turn of a live session runs on. */
  setModel(id: string, model: string | undefined): boolean {
    const ls = this.live.get(id);
    if (!ls || !ls.session.setModel) return false;
    ls.session.setModel(model);
    return true;
  }

  /** Changes a live session's permission mode (undefined = the account default). The caller checked bypass against the waiver. */
  setPermMode(id: string, mode: SessionPermMode | undefined): boolean {
    const ls = this.live.get(id);
    if (!ls || !ls.session.setPermMode) return false;
    ls.session.setPermMode(mode);
    return true;
  }

  abort(id: string): boolean {
    const ls = this.live.get(id);
    if (!ls || !ls.abort) return false;
    ls.abort.abort();
    return true;
  }

  async close(id: string, summary?: string): Promise<boolean> {
    const ls = this.live.get(id);
    if (!ls) return false;
    this.live.delete(id);
    ls.abort?.abort();
    try {
      await ls.session.close(summary);
    } catch {
      /* closing is best-effort */
    }
    return true;
  }

  async sweep(now = Date.now()): Promise<number> {
    let n = 0;
    for (const ls of [...this.live.values()]) {
      const limit = ls.turns === 0 ? Math.min(this.idleMs, EMPTY_IDLE_MS) : this.idleMs;
      if (!ls.busy && now - ls.lastUsed > limit) {
        await this.close(ls.id, "idle timeout");
        n++;
      }
    }
    return n;
  }

  async closeAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.live.keys()].map((id) => this.close(id)));
  }
}
