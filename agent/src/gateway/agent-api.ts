// Server-to-server agent API helpers (POST /api/agent/turn). MIND's backend calls Daebot with the end user's own
// mind_ key in `X-MIND-Key`; the turn then runs in that user's own runtime exactly like a signed-in browser session.
import { createHash } from "node:crypto";

/** Sliding-window request limiter keyed by user id (turns per window). */
export class TurnRateLimiter {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  constructor(o: { max?: number; windowMs?: number } = {}) {
    this.max = Math.max(1, o.max ?? 30);
    this.windowMs = o.windowMs ?? 60_000;
  }
  /** Records a hit and returns 0, or the seconds to wait when the user is over the limit (the hit is not recorded). */
  take(uid: string, now = Date.now()): number {
    const cut = now - this.windowMs;
    const kept = (this.hits.get(uid) ?? []).filter((t) => t > cut);
    if (kept.length >= this.max) {
      this.hits.set(uid, kept);
      return Math.max(1, Math.ceil((kept[0] + this.windowMs - now) / 1000));
    }
    kept.push(now);
    this.hits.set(uid, kept);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => t > cut)) this.hits.delete(k);
    return 0;
  }
}

/** Short-lived memo of key -> MIND username so a chatty conversation does not hit MIND /profile every turn. Keyed by key hash. */
export class KeyIdentityCache {
  private m = new Map<string, { username: string; exp: number }>();
  private ttl: number;
  private now: () => number;
  constructor(ttlMs = 60_000, now: () => number = Date.now) { this.ttl = ttlMs; this.now = now; }
  private k(key: string): string { return createHash("sha256").update(key).digest("hex"); }
  get(key: string): string | undefined {
    const e = this.m.get(this.k(key));
    if (!e) return undefined;
    if (e.exp <= this.now()) { this.m.delete(this.k(key)); return undefined; }
    return e.username;
  }
  set(key: string, username: string): void {
    if (this.m.size > 2000) this.m.clear();
    this.m.set(this.k(key), { username, exp: this.now() + this.ttl });
  }
}

export const AGENT_TURN_PATH = "/api/agent/turn";
export const AGENT_SURFACE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
