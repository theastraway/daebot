// Remote bots, device side. The desktop app long-polls daebot.live; when someone messages one of its bots from another device, the job lands
// here, runs on THIS machine with the bot's local tools, and the reply events stream back to the sender (and the session syncs as usual).
// The same poll carries the per-bot Remote on/off flags both ways (last writer wins by time), so the toggle follows the user across devices.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { BotsApi } from "../bots/types.ts";
import type { HistoryEvent } from "../types.ts";
import { SyncHttp } from "./http.ts";
import type { RemoteDecision, RemoteJob } from "../remote/hub.ts";

/** A stable id for this install, kept next to the data. */
export function loadDeviceId(path: string): string {
  try { const t = readFileSync(path, "utf8").trim(); if (/^d_[0-9a-f]{16}$/.test(t)) return t; } catch { /* first run */ }
  const id = "d_" + randomBytes(8).toString("hex");
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); if (!existsSync(path)) writeFileSync(path, id + "\n", { mode: 0o600 }); } catch { /* an unwritable home still works for this run */ }
  return id;
}

export interface RemoteAgentDeps {
  http: SyncHttp;
  deviceId: string;
  deviceName: string;
  /** machine (a computer) or server (a droplet): the hosted side groups sessions by it. */
  deviceKind?: "machine" | "server";
  /** The network hostname: with the friendly name above it lets the server see that two registrations are the same computer. */
  deviceHost?: string;
  bots(): BotsApi | undefined;
  /** Runs one message as a turn of the bot thread on this machine; every event goes to `emit`. Resolves when the turn ended. */
  runJob(job: RemoteJob, emit: (ev: HistoryEvent) => void, signal: AbortSignal): Promise<void>;
  /** The sender answered a permission card of a turn running here. */
  decide?(d: RemoteDecision): void;
  /** After a job: push the session to the server now. */
  afterJob?(sessionId: string): Promise<void>;
  waitSec?: number;
  log?: (line: string) => void;
}

interface FlagOut { slug: string; remote: boolean; at: number }
interface FlagIn { slug: string; remote: boolean; at: number; by?: "user" | "auto"; note?: string }

export class RemoteAgent {
  private d: RemoteAgentDeps;
  private stopped = false;
  private fails = 0;
  private chains = new Map<string, Promise<void>>();
  private ctl?: AbortController;
  readonly status = { polls: 0, jobs: 0, lastPollAt: 0, lastError: "", running: 0 };

  constructor(d: RemoteAgentDeps) { this.d = d; }

  start(): void {
    this.stopped = false;
    this.ctl = new AbortController();
    void this.loop();
  }

  stop(): void { this.stopped = true; this.ctl?.abort(); }

  /** A flag changed on this device: tell the server now (a second, non-waiting poll) instead of at the end of the current long poll. */
  kick(): void { void this.pollOnce(0).catch(() => {}); }

  private flags(): FlagOut[] {
    return (this.d.bots()?.snapshot() ?? []).map((b) => ({ slug: b.slug, remote: !!b.remote, at: b.remoteAt ?? 0 }));
  }

  private applyFlags(incoming: FlagIn[] | undefined): void {
    const bots = this.d.bots();
    if (!bots?.setRemote || !Array.isArray(incoming)) return;
    for (const f of incoming) {
      const b = bots.bySlug(f.slug);
      if (!b || typeof f.remote !== "boolean" || !(f.at > (b.remoteAt ?? 0))) continue;
      try { bots.setRemote(b.id, f.remote, { by: f.by === "auto" ? "auto" : "user", note: f.note, at: f.at }); } catch { /* a bad row never stops the loop */ }
    }
  }

  /** One poll. Exposed for tests: returns how many jobs it started. */
  async pollOnce(waitSec = this.d.waitSec ?? 20): Promise<number> {
    const r = await this.d.http.json<{ bots?: FlagIn[]; jobs?: RemoteJob[]; decisions?: RemoteDecision[] }>("POST", "/api/sync/device/poll", { deviceId: this.d.deviceId, name: this.d.deviceName, ...(this.d.deviceKind ? { kind: this.d.deviceKind } : {}), ...(this.d.deviceHost ? { host: this.d.deviceHost } : {}), bots: this.flags(), wait: waitSec }, (waitSec + 25) * 1000, waitSec > 0 ? this.ctl?.signal : undefined);
    this.status.polls++; this.status.lastPollAt = Date.now(); this.status.lastError = "";
    this.applyFlags(r.bots);
    for (const d of r.decisions ?? []) { try { this.d.decide?.(d); } catch { /* an answer for a card that is gone */ } }
    for (const job of r.jobs ?? []) this.enqueue(job);
    return (r.jobs ?? []).length;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const t0 = Date.now();
      try {
        await this.pollOnce();
        this.fails = 0;
        if (Date.now() - t0 < 400) await sleep(800, this.ctl?.signal); // a server that answers at once must not be hammered
      } catch (e) {
        if (this.stopped) return;
        this.fails++;
        const msg = String((e as Error)?.message ?? e).slice(0, 160);
        if (msg !== this.status.lastError) this.d.log?.(`remote: ${msg}`);
        this.status.lastError = msg;
        await sleep(Math.min(30_000, 1000 * 2 ** Math.min(this.fails, 5)), this.ctl?.signal);
      }
    }
  }

  private enqueue(job: RemoteJob): void {
    // Jobs of one session run one after the other; different sessions run side by side.
    const prev = this.chains.get(job.sessionId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.run(job));
    this.chains.set(job.sessionId, run);
    void run.finally(() => { if (this.chains.get(job.sessionId) === run) this.chains.delete(job.sessionId); });
  }

  private async run(job: RemoteJob): Promise<void> {
    this.status.running++; this.status.jobs++;
    const ac = new AbortController();
    let buf: HistoryEvent[] = [];
    let flushing: Promise<void> = Promise.resolve();
    const flush = (done = false, error?: string): Promise<void> => {
      const events = buf; buf = [];
      flushing = flushing.catch(() => {}).then(async () => {
        const r = await this.d.http.json<{ ok: boolean; abort?: boolean }>("POST", `/api/sync/device/jobs/${encodeURIComponent(job.id)}/events`, { events, ...(done ? { done: true } : {}), ...(error ? { error } : {}) }).catch((e) => { this.d.log?.(`remote: could not report a job (${String((e as Error)?.message ?? e).slice(0, 100)})`); return undefined; });
        if (r?.abort) ac.abort();
      });
      return flushing;
    };
    const timer = setInterval(() => { if (buf.length) void flush(); }, 300);
    timer.unref?.();
    // A turn that waits on a permission card (or a long tool) says nothing for a while; this keeps the server from calling the device dead.
    const alive = setInterval(() => { void flush(); }, 30_000);
    alive.unref?.();
    let error: string | undefined;
    try {
      await this.d.runJob(job, (ev) => { buf.push(ev); }, ac.signal);
    } catch (e) {
      error = String((e as Error)?.message ?? e).slice(0, 300);
    } finally {
      clearInterval(timer);
      clearInterval(alive);
      await flush(true, error);
      this.status.running--;
      await this.d.afterJob?.(job.sessionId).catch(() => {});
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
