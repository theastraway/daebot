import type { AgentEvent, AgentSession, Runtime } from "../types.ts";

export class BusyError extends Error {}
export class NotFoundError extends Error {}

export interface LiveSession {
  id: string;
  surface: string;
  title: string;
  session: AgentSession;
  busy: boolean;
  abort: AbortController | null;
  lastUsed: number;
  createdAt: number;
}

export const IDLE_MS = 6 * 60 * 60 * 1000;

export class SessionManager {
  private live = new Map<string, LiveSession>();
  private runtime: Runtime;
  private idleMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(runtime: Runtime, opts: { idleMs?: number; sweepMs?: number } = {}) {
    this.runtime = runtime;
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.timer = setInterval(() => void this.sweep(), opts.sweepMs ?? 10 * 60 * 1000);
    this.timer.unref();
  }

  async open(o: { surface: string; title?: string; resumeId?: string; identity?: string }): Promise<LiveSession> {
    if (o.resumeId) {
      const existing = this.live.get(o.resumeId);
      if (existing) {
        existing.lastUsed = Date.now();
        return existing;
      }
    }
    const session = await this.runtime.openSession({ surface: o.surface, title: o.title, resumeId: o.resumeId, identity: o.identity });
    const existing = this.live.get(session.id);
    if (existing) return existing;
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
    };
    this.live.set(ls.id, ls);
    return ls;
  }

  get(id: string): LiveSession | undefined {
    return this.live.get(id);
  }

  count(): number {
    return this.live.size;
  }

  list(): { id: string; surface: string; title: string; updatedAt: number; live: boolean; busy: boolean }[] {
    const out = new Map<string, { id: string; surface: string; title: string; updatedAt: number; live: boolean; busy: boolean }>();
    try {
      for (const s of this.runtime.listSessions()) out.set(s.id, { ...s, live: false, busy: false });
    } catch {
      /* runtime listing is best-effort */
    }
    for (const ls of this.live.values()) {
      const prev = out.get(ls.id);
      out.set(ls.id, {
        id: ls.id,
        surface: ls.surface,
        title: prev?.title || ls.title || "Untitled",
        updatedAt: Math.max(prev?.updatedAt ?? 0, ls.lastUsed),
        live: true,
        busy: ls.busy,
      });
    }
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Runs one turn. Throws BusyError / NotFoundError synchronously-in-promise before any event is emitted. */
  async turn(id: string, text: string, onEvent: (e: AgentEvent) => void, external?: AbortSignal): Promise<void> {
    const ls = this.live.get(id);
    if (!ls) throw new NotFoundError("no such session");
    if (ls.busy) throw new BusyError("session is busy with another turn");
    ls.busy = true; // set synchronously: no await between check and set
    const ac = new AbortController();
    ls.abort = ac;
    const onExternal = () => ac.abort();
    if (external) {
      if (external.aborted) ac.abort();
      else external.addEventListener("abort", onExternal, { once: true });
    }
    let sawDone = false;
    try {
      for await (const ev of ls.session.send(text, { signal: ac.signal })) {
        if (ev.type === "done") sawDone = true;
        onEvent(ev);
        if (sawDone) break;
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent({ type: "notice", level: "warn", text: `Turn failed: ${msg.slice(0, 300)}` });
      }
    } finally {
      if (!sawDone) {
        if (ac.signal.aborted) onEvent({ type: "notice", level: "info", text: "Turn aborted." });
        onEvent({ type: "done", finalText: "" });
      }
      external?.removeEventListener("abort", onExternal);
      ls.busy = false;
      ls.abort = null;
      ls.lastUsed = Date.now();
    }
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
      if (!ls.busy && now - ls.lastUsed > this.idleMs) {
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
