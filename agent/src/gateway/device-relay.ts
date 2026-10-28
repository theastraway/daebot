// Device relay. A tool that needs the user's own device (today: Apple Calendar in the iPhone and Mac apps) never runs anything on this
// host. It publishes a `device_call` event into the run feed of the turn; the web UI inside the app runs it natively and POSTs the answer
// to /sessions/:id/device-result, which resolves the tool's promise here. Every call is owned by (session, principal): only that
// principal's answer counts, an id answers once, and an unknown or expired id is refused.
import { randomUUID } from "node:crypto";
import type { AgentEvent, DeviceBridge, DeviceReply } from "../types.ts";

/** Capabilities a client may list on a send. Anything else is dropped. */
export const CLIENT_CAPABILITIES: ReadonlySet<string> = new Set(["apple_calendar"]);

/** The capabilities named in a send body: known names only, each once. */
export function parseCapabilities(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && CLIENT_CAPABILITIES.has(x)))];
}

const MAX_PENDING_PER_SESSION = 8;
const MAX_RESULT_BYTES = 900_000;
const MAX_ERROR_CHARS = 500;

interface Pending {
  sessionId: string;
  owner: string;
  tool: string;
  settle: (r: DeviceReply) => void;
}

export type AnswerOutcome = { ok: true } | { ok: false; status: number; error: string };

export class DeviceRelay {
  private pending = new Map<string, Pending>();
  private newId: () => string;

  constructor(o: { newId?: () => string } = {}) {
    this.newId = o.newId ?? randomUUID;
  }

  /** The bridge for one turn of one session of one principal. `publish` puts an event into that turn's run feed. */
  bridge(o: { sessionId: string; owner: string; publish: (ev: AgentEvent) => void }): DeviceBridge {
    return {
      call: (req, opts) => new Promise<DeviceReply>((resolve) => {
        if (opts.signal?.aborted) return resolve({ ok: false, code: "aborted", error: "Stopped before the device was asked." });
        if (this.countFor(o.sessionId) >= MAX_PENDING_PER_SESSION) return resolve({ ok: false, code: "device", error: "Too many device requests are waiting for an answer. Try again in a moment." });
        const id = this.newId();
        let timer: NodeJS.Timeout | undefined;
        let onAbort: (() => void) | undefined;
        const settle = (r: DeviceReply) => {
          if (!this.pending.delete(id)) return;
          if (timer) clearTimeout(timer);
          if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
          resolve(r);
        };
        this.pending.set(id, { sessionId: o.sessionId, owner: o.owner, tool: req.tool, settle });
        timer = setTimeout(() => settle({ ok: false, code: "timeout", error: "The device did not answer in time." }), opts.timeoutMs);
        timer.unref?.();
        if (opts.signal) {
          onAbort = () => settle({ ok: false, code: "aborted", error: "Stopped while waiting for the device." });
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
        try {
          o.publish({ type: "device_call", id, tool: req.tool, op: req.op, args: req.args });
        } catch {
          settle({ ok: false, code: "device", error: "Could not reach your device." });
        }
      }),
    };
  }

  private countFor(sessionId: string): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.sessionId === sessionId) n++;
    return n;
  }

  /** True while the call still waits for its answer (a replayed event for an answered or expired call is not sent again). */
  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  /** The device's answer. Validated here: right session, right principal, a known unanswered id, a bounded body. */
  answer(o: { sessionId: string; owner: string; body: Record<string, unknown> }): AnswerOutcome {
    const id = typeof o.body.id === "string" ? o.body.id : "";
    const p = id ? this.pending.get(id) : undefined;
    if (!p || p.sessionId !== o.sessionId || p.owner !== o.owner) return { ok: false, status: 404, error: "no such device request (already answered, expired, or not yours)" };
    if (typeof o.body.ok !== "boolean") return { ok: false, status: 400, error: "ok must be true or false" };
    if (o.body.ok) {
      let size = 0;
      try { size = JSON.stringify(o.body.result ?? null).length; } catch { return { ok: false, status: 400, error: "result must be JSON" }; }
      if (size > MAX_RESULT_BYTES) return { ok: false, status: 413, error: "result too large" };
      p.settle({ ok: true, result: o.body.result ?? null });
    } else {
      const err = typeof o.body.error === "string" && o.body.error.trim() ? o.body.error.trim().slice(0, MAX_ERROR_CHARS) : "Your device could not run that request.";
      p.settle({ ok: false, code: "device", error: err });
    }
    return { ok: true };
  }

  /** The turn ended (or the session closed): nothing is waiting for an answer any more. */
  endSession(sessionId: string): void {
    for (const p of [...this.pending.values()]) if (p.sessionId === sessionId) p.settle({ ok: false, code: "closed", error: "The turn ended before the device answered." });
  }

  size(): number {
    return this.pending.size;
  }
}
