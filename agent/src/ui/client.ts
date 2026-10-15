// One interface for both transports so the renderer and app are shared.
import type { AgentEvent, AgentSession, Runtime, Violation } from "../types.ts";
import { agentEventsFromStream } from "./sse.ts";

export interface SessionInfo { id: string; surface: string; title: string; updatedAt: number }
export interface RuntimeInfo { model?: string; kernel?: "on" | "shadow" | "off" }

export interface SessionClient {
  readonly mode: "gateway" | "local";
  readonly label: string;                 // shown in /help and the status line ("local" or the gateway url)
  connected(): boolean;                   // last known connection state
  info(): Promise<RuntimeInfo>;
  open(opts: { title?: string; resumeId?: string }): Promise<string>;
  send(sessionId: string, text: string, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  abort(sessionId: string): Promise<void>;
  list(): Promise<SessionInfo[]>;
  violations(sessionId: string): Promise<Violation[]>;
  close(sessionId: string): Promise<void>;
}

// ---------- gateway ----------
export function createGatewayClient(opts: { url: string; token: string; fetchImpl?: typeof fetch; surface?: string }): SessionClient {
  const base = opts.url.replace(/\/+$/, "");
  const f = opts.fetchImpl ?? fetch;
  const surface = opts.surface ?? "tui";
  let up = false;
  const headers = (extra?: Record<string, string>) => ({ authorization: `Bearer ${opts.token}`, ...extra });

  async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await f(base + path, { ...init, headers: { ...headers({ "content-type": "application/json" }), ...(init.headers as Record<string, string> | undefined) } });
    } catch (e) {
      up = false;
      throw new Error(`cannot reach gateway at ${base} (${(e as Error).message})`);
    }
    up = true;
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const b = (await res.json()) as { error?: string }; if (b.error) msg += " " + b.error; } catch { /* no body */ }
      throw new Error(`gateway ${path}: ${msg}`);
    }
    return (await res.json()) as T;
  }

  return {
    mode: "gateway",
    label: base,
    connected: () => up,
    async info() {
      try {
        const h = await json<{ model?: string; kernel?: string; shadow?: boolean }>("/health");
        const kernel = h.kernel === "off" || h.kernel === "false" ? "off" : h.shadow ? "shadow" : h.kernel === "shadow" ? "shadow" : h.kernel === "on" ? "on" : undefined;
        return { model: typeof h.model === "string" ? h.model : undefined, kernel };
      } catch { return {}; }
    },
    async open({ title, resumeId }) {
      const r = await json<{ sessionId: string }>("/sessions", { method: "POST", body: JSON.stringify({ surface, title, resumeId }) });
      return r.sessionId;
    },
    async *send(sessionId, text, signal) {
      let res: Response;
      try {
        res = await f(`${base}/sessions/${encodeURIComponent(sessionId)}/send`, {
          method: "POST", headers: headers({ "content-type": "application/json", accept: "text/event-stream" }),
          body: JSON.stringify({ text }), signal,
        });
      } catch (e) {
        if (signal?.aborted) return;
        up = false;
        yield { type: "notice", level: "warn", text: `connection lost: ${(e as Error).message}` };
        return;
      }
      up = true;
      if (!res.ok || !res.body) {
        let msg = `${res.status}`;
        try { const b = (await res.json()) as { error?: string }; if (b.error) msg += " " + b.error; } catch { /* ignore */ }
        yield { type: "notice", level: "warn", text: `send failed: ${msg}` };
        return;
      }
      try {
        yield* agentEventsFromStream(res.body as unknown as AsyncIterable<Uint8Array>);
      } catch (e) {
        if (signal?.aborted) return;
        up = false;
        yield { type: "notice", level: "warn", text: `stream interrupted: ${(e as Error).message}` };
      }
    },
    async abort(sessionId) { try { await json(`/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST", body: "{}" }); } catch { /* best effort */ } },
    async list() { return (await json<{ sessions: SessionInfo[] }>("/sessions")).sessions ?? []; },
    async violations(sessionId) { return (await json<{ violations: Violation[] }>(`/sessions/${encodeURIComponent(sessionId)}/violations`)).violations ?? []; },
    async close(sessionId) { try { await json(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }); } catch { /* best effort */ } },
  };
}

// ---------- in-process ----------
export function createLocalClient(runtime: Runtime, env: Record<string, string | undefined> = process.env): SessionClient {
  const sessions = new Map<string, AgentSession>();
  return {
    mode: "local",
    label: "local",
    connected: () => true,
    async info() {
      const kernel = env.MINDCLAW_KERNEL === "0" ? "off" : env.MINDCLAW_SHADOW === "1" ? "shadow" : "on";
      return { model: env.MINDCLAW_MODEL || undefined, kernel };
    },
    async open({ title, resumeId }) {
      const s = await runtime.openSession({ surface: "tui", title, resumeId });
      sessions.set(s.id, s);
      return s.id;
    },
    send(sessionId, text, signal) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`no such session ${sessionId}`);
      return s.send(text, { signal });
    },
    async abort() { /* local aborts go through the AbortSignal passed to send() */ },
    async list() { return runtime.listSessions(); },
    async violations(sessionId) { return sessions.get(sessionId)?.violations() ?? []; },
    async close(sessionId) {
      const s = sessions.get(sessionId);
      sessions.delete(sessionId);
      if (s) await s.close();
    },
  };
}
