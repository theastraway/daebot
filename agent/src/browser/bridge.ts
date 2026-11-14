// The local channel between the gateway and the desktop app.
//
// Same auth as /screen: the desktop presents the gateway bearer token. The direction is reversed, because the
// gateway is the one that needs work done. The desktop long-polls GET /browser/poll. The gateway queues one
// command (open a tab, send a CDP 1.3 call, show the pane). The desktop POSTs the outcome to /browser/result
// and pushes tab/control changes to POST /browser/state. There is no --remote-debugging-port and no Playwright.
//
// A gateway with no desktop (CLI or server) has nobody polling, so the browser tool reports that it is unavailable.

import { randomUUID } from "node:crypto";
import { BROWSER_PARTITION, clampPaneWidth } from "./policy.ts";

export interface BrowserTabState {
  id: string;
  url: string;
  title: string;
  active: boolean;
  control: "agent" | "user";
}

export interface BrowserNotice {
  kind: "refusal" | "approval" | "info";
  text: string;
}

export interface BrowserSnapshot {
  partition: string;
  gatewayOrigin: string;
  pane: { open: boolean; width: number };
  tabs: BrowserTabState[];
  notice: BrowserNotice | null;
}

export interface BrowserCommand {
  id: string;
  op: string;
  args: Record<string, unknown>;
}

export interface CommandResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

const DEFAULT_SNAPSHOT = (): BrowserSnapshot => ({
  partition: BROWSER_PARTITION,
  gatewayOrigin: "",
  pane: { open: false, width: 0 },
  tabs: [],
  notice: null,
});

type Waiter = { resolve: (body: { commands: BrowserCommand[] }) => void; timer: NodeJS.Timeout };

export interface BrowserBridge {
  connected(): boolean;
  snapshot(): BrowserSnapshot;
  /** Desktop long-poll. Resolves with the next command, or with an empty list when waitMs elapses. */
  poll(waitMs: number): Promise<{ commands: BrowserCommand[] }>;
  /** Desktop finished one command. Returns false when the id is unknown. */
  result(id: string, body: CommandResult): boolean;
  /** Desktop replaced the tab list, who has control, or the pane. */
  pushState(patch: Partial<BrowserSnapshot> & { tabs?: BrowserTabState[] }): BrowserSnapshot;
  notice(n: BrowserNotice | null): void;
  /** Tool side. Rejects when no desktop is connected or the desktop does not answer in time. */
  call(op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  subscribe(fn: () => void): () => void;
  /** Test aid: drop waiters and pending calls. */
  reset(): void;
}

const SEEN_MS = 15_000;

export function createBrowserBridge(now: () => number = Date.now): BrowserBridge {
  let snap = DEFAULT_SNAPSHOT();
  let lastSeen = 0;
  let polling = false;
  const queue: BrowserCommand[] = [];
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let waiter: Waiter | null = null;
  const listeners = new Set<() => void>();

  const emit = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* a pane listener must not break the bridge */ } } };
  const touch = () => { lastSeen = now(); };

  const connected = () => polling || now() - lastSeen < SEEN_MS;

  const kick = () => {
    if (!waiter || queue.length === 0) return;
    const w = waiter;
    waiter = null;
    clearTimeout(w.timer);
    const cmd = queue.shift()!;
    w.resolve({ commands: [cmd] });
  };

  return {
    connected,
    snapshot: () => snap,
    poll(waitMs: number) {
      touch();
      polling = true;
      const wait = Math.min(25_000, Math.max(0, Math.floor(waitMs) || 0));
      if (queue.length) {
        const cmd = queue.shift()!;
        queueMicrotask(() => { polling = false; });
        return Promise.resolve({ commands: [cmd] });
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (waiter && waiter.timer === timer) waiter = null;
          polling = false;
          touch();
          resolve({ commands: [] });
        }, wait);
        timer.unref?.();
        waiter = { resolve: (body) => { polling = false; touch(); resolve(body); }, timer };
      });
    },
    result(id, body) {
      const p = pending.get(id);
      if (!p) return false;
      clearTimeout(p.timer);
      pending.delete(id);
      touch();
      if (body && body.ok === false) p.reject(new Error(String(body.error || "browser command failed").slice(0, 300)));
      else p.resolve(body?.result);
      return true;
    },
    pushState(patch) {
      touch();
      const tabs = Array.isArray(patch.tabs) ? patch.tabs.map(cleanTab).filter((t): t is BrowserTabState => !!t) : snap.tabs;
      snap = {
        partition: BROWSER_PARTITION,
        gatewayOrigin: typeof patch.gatewayOrigin === "string" ? patch.gatewayOrigin.slice(0, 200) : snap.gatewayOrigin,
        pane: {
          open: typeof patch.pane?.open === "boolean" ? patch.pane.open : snap.pane.open,
          width: clampPaneWidth(patch.pane?.width ?? snap.pane.width),
        },
        tabs,
        notice: patch.notice === null ? null : patch.notice ? cleanNotice(patch.notice) : snap.notice,
      };
      emit();
      return snap;
    },
    notice(n) {
      snap = { ...snap, notice: n ? cleanNotice(n) : null };
      emit();
    },
    call(op, args, timeoutMs = 20_000) {
      if (!connected()) return Promise.reject(new Error("browser unavailable"));
      const id = randomUUID();
      const cmd: BrowserCommand = { id, op, args: args ?? {} };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("browser timed out waiting for the desktop app"));
        }, Math.min(60_000, Math.max(100, timeoutMs)));
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        queue.push(cmd);
        kick();
      });
    },
    subscribe(fn) {
      listeners.add(fn);
      let on = true;
      return () => { if (!on) return; on = false; listeners.delete(fn); };
    },
    reset() {
      if (waiter) clearTimeout(waiter.timer);
      waiter = null;
      polling = false;
      queue.splice(0, queue.length);
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("browser bridge reset")); }
      pending.clear();
      snap = DEFAULT_SNAPSHOT();
      lastSeen = 0;
    },
  };
}

function cleanTab(t: unknown): BrowserTabState | undefined {
  if (!t || typeof t !== "object") return undefined;
  const o = t as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return undefined;
  return {
    id: o.id.slice(0, 40),
    url: typeof o.url === "string" ? o.url.slice(0, 2000) : "",
    title: typeof o.title === "string" ? o.title.slice(0, 200) : "",
    active: o.active === true,
    control: o.control === "user" ? "user" : "agent",
  };
}

function cleanNotice(n: BrowserNotice): BrowserNotice {
  const kind = n.kind === "refusal" || n.kind === "approval" || n.kind === "info" ? n.kind : "info";
  return { kind, text: String(n.text ?? "").slice(0, 400) };
}

let singleton: BrowserBridge | undefined;

/** The bridge the running gateway and the browser tool share. Tests that start a gateway pass their own. */
export function browserBridge(): BrowserBridge {
  if (!singleton) singleton = createBrowserBridge();
  return singleton;
}

export function installBrowserBridge(b: BrowserBridge): void {
  singleton = b;
}
