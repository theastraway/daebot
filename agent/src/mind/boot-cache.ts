// In-memory cache of the MIND boot context, per MIND key. A new chat then opens without waiting on mind_context
// (seconds) except for the first one in a 10 minute window. A degraded boot (fallback path) is cached briefly
// WITH its degraded flag, so the "loaded from the fallback path" notice behaves exactly as before.
// Failed boots are never cached. Concurrent opens for one key share one in-flight load.
import { createHash } from "node:crypto";

export interface BootResult { ok: boolean; context: string; error?: string; degraded?: boolean }

export const BOOT_TTL_MS = 10 * 60 * 1000;
export const DEGRADED_BOOT_TTL_MS = 60 * 1000;

export class BootCache {
  private entries = new Map<string, { at: number; ttl: number; boot: BootResult }>();
  private inflight = new Map<string, Promise<BootResult>>();
  private ttlMs: number;
  private degradedTtlMs: number;
  private now: () => number;

  constructor(opts: { ttlMs?: number; degradedTtlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? BOOT_TTL_MS;
    this.degradedTtlMs = opts.degradedTtlMs ?? DEGRADED_BOOT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  // The key itself is never stored: only a short digest of it.
  private keyOf(mindKey: string): string { return createHash("sha256").update(mindKey).digest("hex").slice(0, 24); }

  async get(mindKey: string, load: () => Promise<BootResult>): Promise<BootResult> {
    const k = this.keyOf(mindKey);
    const hit = this.entries.get(k);
    if (hit && this.now() - hit.at < hit.ttl) return hit.boot;
    const running = this.inflight.get(k);
    if (running) return running;
    const p = (async () => {
      const boot = await load();
      if (boot.ok) this.entries.set(k, { at: this.now(), ttl: boot.degraded ? this.degradedTtlMs : this.ttlMs, boot });
      return boot;
    })().finally(() => { this.inflight.delete(k); });
    this.inflight.set(k, p);
    return p;
  }

  invalidate(mindKey?: string): void {
    if (mindKey === undefined) this.entries.clear();
    else this.entries.delete(this.keyOf(mindKey));
  }
}
