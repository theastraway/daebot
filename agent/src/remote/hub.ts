// Remote bots, hosted side (daebot.live). A desktop app that has bots registers itself here by long-polling for work. A message sent to a bot
// thread from another device (phone, web) becomes a JOB for that desktop: the desktop runs it with its local tools and streams the reply
// events back, which the hub forwards into the sender's run feed. Jobs wait here while the desktop is offline and are delivered when it
// polls again. Everything is scoped to one owner (a MIND user); a device only ever sees its own owner's jobs.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { cleanLabel, groupDevices, tidyName } from "../env.ts";
import type { EnvGroup } from "../env.ts";

export const ONLINE_MS = 45_000;
export const JOB_TTL_MS = 24 * 60 * 60 * 1000;
/** A delivered job whose device has said nothing for this long is failed (never re-run: it may already have used tools). */
export const STALL_MS = 3 * 60 * 1000;
const MAX_JOBS_PER_OWNER = 200;

/** An answer to a permission card, on its way to the desktop that asked. */
export interface RemoteDecision { jobId: string; permId: string; decision: "allow" | "deny"; remember?: "once" | "always"; scope?: string }

export interface DeviceInfo { id: string; name: string; lastSeen: number; slugs: string[]; /** machine (a computer) or server (a droplet); absent on a device that has not said. */ kind?: "machine" | "server"; /** The network hostname, when the device says its name is something friendlier (the same computer is then one environment). */ host?: string; firstSeen?: number }
export type JobState = "queued" | "delivered" | "done" | "failed";
export interface RemoteJob {
  id: string;
  owner: string;
  deviceId: string;
  sessionId: string;
  botSlug: string;
  surface: string;
  title: string;
  text: string;
  quote?: { id?: string; text: string };
  /** Photos attached to this message: already stored on daebot.live under the same session (the device fetches the bytes). */
  photos?: { id: string; name: string; width: number; height: number }[];
  /** The sender's device can answer a permission card: the desktop turn may ask (the card is relayed to the sender, the answer comes back). */
  interactive?: boolean;
  createdAt: number;
  state: JobState;
  deliveredAt?: number;
  activityAt?: number;
  abort?: boolean;
  error?: string;
}

interface OwnerState { devices: Record<string, DeviceInfo>; jobs: RemoteJob[]; /** Names the person gave environments: a device id (or "cloud") -> name. */ envNames: Record<string, string> }
interface Waiter { deviceId: string; wake: () => void }

export interface HubOptions { dir?: string; now?: () => number; onStalled?: (job: RemoteJob) => void; /** How recent a poll must be for a device to count as online (default ONLINE_MS). */ onlineMs?: number }

const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);

export class RemoteHub {
  private owners = new Map<string, OwnerState>();
  private waiters = new Map<string, Set<Waiter>>();
  private now: () => number;
  private dir?: string;
  private onStalled?: (job: RemoteJob) => void;
  private onlineMs: number;
  private decisions = new Map<string, RemoteDecision[]>(); // `${owner}|${deviceId}` -> answers waiting for that device (memory only: a card dies with its turn)

  constructor(o: HubOptions = {}) {
    this.now = o.now ?? Date.now;
    this.dir = o.dir ? join(o.dir, "remote") : undefined;
    this.onStalled = o.onStalled;
    this.onlineMs = o.onlineMs ?? ONLINE_MS;
  }

  private st(owner: string): OwnerState {
    let s = this.owners.get(owner);
    if (s) return s;
    s = { devices: {}, jobs: [], envNames: {} };
    if (this.dir) {
      try {
        const j = JSON.parse(readFileSync(join(this.dir, `${safe(owner)}.json`), "utf8"));
        if (j && typeof j === "object") { s.devices = j.devices && typeof j.devices === "object" ? j.devices : {}; s.jobs = Array.isArray(j.jobs) ? j.jobs : []; s.envNames = j.envNames && typeof j.envNames === "object" ? j.envNames : {}; }
      } catch { /* first use, or a torn file: start empty */ }
    }
    this.owners.set(owner, s);
    return s;
  }

  private save(owner: string): void {
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const s = this.st(owner);
      const keep = s.jobs.filter((j) => j.state === "queued" || j.state === "delivered" || this.now() - j.createdAt < 10 * 60_000).slice(-MAX_JOBS_PER_OWNER);
      s.jobs = keep;
      const f = join(this.dir, `${safe(owner)}.json`);
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ devices: s.devices, jobs: s.jobs, envNames: s.envNames }), { mode: 0o600 });
      renameSync(tmp, f);
    } catch { /* a failed save never blocks a message */ }
  }

  /** A desktop checked in: it carries these bots (by slug). */
  heartbeat(owner: string, d: { id: string; name: string; slugs: string[]; kind?: "machine" | "server"; host?: string }): DeviceInfo {
    const s = this.st(owner);
    const prev = s.devices[d.id];
    const kind = d.kind ?? prev?.kind;
    const host = (d.host ? tidyName(d.host, "server") : prev?.host)?.slice(0, 60) || undefined;
    const info: DeviceInfo = { id: d.id, name: d.name.slice(0, 60) || "Desktop", lastSeen: this.now(), slugs: d.slugs.slice(0, 200), ...(kind ? { kind } : {}), ...(host ? { host } : {}), firstSeen: prev?.firstSeen ?? this.now() };
    s.devices[d.id] = info;
    if (!prev || prev.name !== info.name || prev.kind !== info.kind || prev.host !== info.host || prev.slugs.join() !== info.slugs.join()) this.save(owner);
    return info;
  }

  /** The computers and servers of this owner with duplicate registrations merged into one each and the person's renames applied. */
  envGroups(owner: string): EnvGroup[] {
    const s = this.st(owner);
    return groupDevices(this.devices(owner), s.envNames);
  }

  /** The name the person gave MIND Cloud, if any. */
  cloudName(owner: string): string | undefined { return this.st(owner).envNames.cloud; }

  /** Renames an environment (a device id of any of its registrations, or "cloud"). An empty name puts the automatic name back. false = unknown environment. */
  renameEnv(owner: string, id: string, name: string): boolean {
    const s = this.st(owner);
    const clean = cleanLabel(name);
    if (id === "cloud") { if (clean) s.envNames.cloud = clean; else delete s.envNames.cloud; this.save(owner); return true; }
    const g = this.envGroups(owner).find((x) => x.members.includes(id));
    if (!g) return false;
    for (const m of g.members) delete s.envNames[m];
    if (clean) s.envNames[g.id] = clean;
    this.save(owner);
    return true;
  }

  isOnline(d: DeviceInfo): boolean { return this.now() - d.lastSeen < this.onlineMs; }

  devices(owner: string): (DeviceInfo & { online: boolean })[] {
    return Object.values(this.st(owner).devices).map((d) => ({ ...d, online: this.isOnline(d) })).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** Devices that carry this bot, online first, then most recently seen. */
  devicesFor(owner: string, slug: string): (DeviceInfo & { online: boolean })[] {
    return this.devices(owner).filter((d) => d.slugs.includes(slug)).sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);
  }

  enqueue(owner: string, j: Omit<RemoteJob, "id" | "owner" | "createdAt" | "state">): RemoteJob {
    const s = this.st(owner);
    const job: RemoteJob = { ...j, id: "rj_" + randomBytes(8).toString("hex"), owner, createdAt: this.now(), state: "queued" };
    s.jobs.push(job);
    this.save(owner);
    this.wake(owner, job.deviceId);
    return job;
  }

  /** The sender answered a permission card of a job that runs on a device: hold the answer for that device's next poll and wake it. */
  addDecision(owner: string, d: RemoteDecision): boolean {
    const j = this.job(owner, d.jobId);
    if (!j || j.state !== "delivered") return false;
    const k = `${owner}|${j.deviceId}`;
    this.decisions.set(k, [...(this.decisions.get(k) ?? []), d].slice(-50));
    this.wake(owner, j.deviceId);
    return true;
  }

  hasDecisions(owner: string, deviceId: string): boolean { return (this.decisions.get(`${owner}|${deviceId}`)?.length ?? 0) > 0; }

  takeDecisions(owner: string, deviceId: string): RemoteDecision[] {
    const k = `${owner}|${deviceId}`;
    const out = this.decisions.get(k) ?? [];
    this.decisions.delete(k);
    return out;
  }

  /** Something other than a job changed (a Remote flag): every waiting poll of this owner answers now so the device sees it. */
  nudge(owner: string): void {
    for (const w of [...(this.waiters.get(owner) ?? [])]) w.wake();
  }

  private wake(owner: string, deviceId: string): void {
    for (const w of [...(this.waiters.get(owner) ?? [])]) if (w.deviceId === deviceId) w.wake();
  }

  /** Jobs for this device that nobody has picked up yet; they become "delivered". Expired ones fail first. */
  take(owner: string, deviceId: string): RemoteJob[] {
    const s = this.st(owner);
    const t = this.now();
    let changed = false;
    for (const j of s.jobs) if (j.state === "queued" && t - j.createdAt > JOB_TTL_MS) { j.state = "failed"; j.error = "expired before the device came back"; changed = true; this.onStalled?.(j); }
    const out: RemoteJob[] = [];
    for (const j of s.jobs) {
      if (j.state !== "queued" || j.deviceId !== deviceId) continue;
      j.state = "delivered"; j.deliveredAt = t; j.activityAt = t; changed = true;
      out.push({ ...j });
    }
    if (changed) this.save(owner);
    return out;
  }

  /** Long poll: resolves with jobs as soon as there is one for this device, or with [] after `ms`. */
  async wait(owner: string, deviceId: string, ms: number, signal?: AbortSignal): Promise<RemoteJob[]> {
    const first = this.take(owner, deviceId);
    if (first.length || ms <= 0 || this.hasDecisions(owner, deviceId)) return first;
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(owner) ?? new Set<Waiter>();
      this.waiters.set(owner, set);
      const w: Waiter = { deviceId, wake: () => done() };
      let timer: NodeJS.Timeout | undefined;
      const done = () => { if (timer) clearTimeout(timer); set.delete(w); signal?.removeEventListener("abort", done); resolve(); };
      set.add(w);
      timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    });
    return this.take(owner, deviceId);
  }

  job(owner: string, id: string): RemoteJob | undefined {
    return this.st(owner).jobs.find((j) => j.id === id);
  }

  /** The device reported progress (or the end) of a job it was handed. */
  progress(owner: string, deviceId: string, id: string, o: { done?: boolean; error?: string }): RemoteJob | undefined {
    const j = this.job(owner, id);
    if (!j || j.deviceId !== deviceId || (j.state !== "delivered" && j.state !== "queued")) return undefined;
    j.activityAt = this.now();
    if (j.state === "queued") { j.state = "delivered"; j.deliveredAt = j.activityAt; }
    if (o.done) { j.state = o.error ? "failed" : "done"; if (o.error) j.error = o.error.slice(0, 300); this.save(owner); }
    return j;
  }

  /** Stop the job: the sender pressed stop. The device learns on its next report. */
  requestAbort(owner: string, sessionId: string): boolean {
    let hit = false;
    for (const j of this.st(owner).jobs) if (j.sessionId === sessionId && (j.state === "delivered" || j.state === "queued")) { j.abort = true; hit = true; }
    if (hit) this.save(owner);
    return hit;
  }

  /** The poll that was handed these jobs went away before it could read them: they go back in the queue (never run, never lost). */
  requeue(owner: string, jobs: RemoteJob[]): void {
    const s = this.st(owner);
    for (const j of jobs) { const x = s.jobs.find((y) => y.id === j.id); if (x && x.state === "delivered") { x.state = "queued"; delete x.deliveredAt; } }
    this.save(owner);
  }

  /** Stop pressed while the message still waits for a sleeping device: it never gets delivered. Returns the jobs withdrawn. */
  cancelQueued(owner: string, sessionId: string): RemoteJob[] {
    const out: RemoteJob[] = [];
    for (const j of this.st(owner).jobs) if (j.sessionId === sessionId && j.state === "queued") { j.state = "failed"; j.error = "stopped before the device picked it up"; out.push({ ...j }); }
    if (out.length) this.save(owner);
    return out;
  }

  activeFor(owner: string, sessionId: string): RemoteJob | undefined {
    return this.st(owner).jobs.find((j) => j.sessionId === sessionId && (j.state === "queued" || j.state === "delivered"));
  }

  /** Delivered jobs whose device went quiet: failed once, reported through onStalled. Call from a timer. */
  sweep(): number {
    let n = 0;
    const t = this.now();
    for (const [owner, s] of this.owners) {
      let changed = false;
      for (const j of s.jobs) {
        if (j.state === "delivered" && t - (j.activityAt ?? j.deliveredAt ?? j.createdAt) > STALL_MS) { j.state = "failed"; j.error = "the device stopped responding"; changed = true; n++; this.onStalled?.(j); }
      }
      if (changed) this.save(owner);
    }
    return n;
  }
}
