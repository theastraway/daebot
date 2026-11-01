// Server-to-server provisioning: Astra AI (the client portal) creates a MIND tenant for a client, then asks Daebot to
// register that tenant's key and hand back a one-time sign-in link.
//   DAEBOT_PROVISION_TOKEN   service token the portal sends as `Authorization: Bearer <token>` (unset = endpoint is off, 404)
// Two small pieces live here:
//   * RuntimeAllowList: usernames added at runtime, persisted next to the user store, unioned with DAEBOT_ALLOWED_USERS.
//   * EntryCodes: single-use, short-lived codes that the portal turns into a link; opening it sets the session cookie.
// The code is NOT the PKCE app handoff (that one needs a verifier held by the app); here the code itself is the bearer secret,
// so it is 256 bits, lives 5 minutes, works once, and the map is capped.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeEqual } from "../gateway/auth.ts";

export const PROVISION_PATH = "/auth/provision";
export const ENTER_PATH = "/auth/provision/enter";
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CODES = 500;
const CODE_RE = /^[A-Za-z0-9_-]{40,60}$/;

/** Constant-time check of a presented bearer against the configured token. Empty/unset configured token never matches. */
export function provisionTokenOk(presented: string | undefined, configured: string | undefined): boolean {
  const want = (configured ?? "").trim();
  if (want.length < 24) return false; // refuse a weak token outright
  return safeEqual((presented ?? "").trim(), want);
}

export function bearerOf(header: string | string[] | undefined): string {
  const h = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h ?? "");
  return m ? m[1] : "";
}

export class RuntimeAllowList {
  private path: string;
  private names = new Set<string>();
  constructor(dir: string) {
    this.path = join(dir, "daebot-allowed.json");
    if (existsSync(this.path)) {
      try {
        const j = JSON.parse(readFileSync(this.path, "utf8"));
        for (const n of Array.isArray(j?.users) ? j.users : []) if (typeof n === "string" && n) this.names.add(n.trim().toLowerCase());
      } catch { /* unreadable file = empty list; the env list still applies */ }
    }
  }
  has(username: string): boolean { return this.names.has(username.trim().toLowerCase()); }
  list(): string[] { return [...this.names]; }
  add(username: string): void {
    const n = username.trim().toLowerCase();
    if (!n || this.names.has(n)) return;
    this.names.add(n);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, users: [...this.names] }), { mode: 0o600 });
    renameSync(tmp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* best effort */ }
  }
}

export class EntryCodes {
  private codes = new Map<string, { uid: string; expires: number }>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.codes) if (v.expires <= t) this.codes.delete(k);
    while (this.codes.size > MAX_CODES) this.codes.delete(this.codes.keys().next().value as string);
  }
  mint(uid: string): string {
    this.sweep();
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, { uid, expires: this.now() + CODE_TTL_MS });
    return code;
  }
  /** Single use, success or fail. */
  redeem(code: unknown): string | undefined {
    this.sweep();
    if (typeof code !== "string" || !CODE_RE.test(code)) return undefined;
    const c = this.codes.get(code);
    this.codes.delete(code);
    return c && c.expires > this.now() ? c.uid : undefined;
  }
}
