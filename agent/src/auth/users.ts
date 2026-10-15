// Per-user records for the hosted deployment. One record per MIND username. Credentials (the user's own
// MIND API key, or OAuth access+refresh tokens) are AES-256-GCM sealed; everything else is plain metadata.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HostedConfigError } from "../hosted.ts";
import { SealError, deriveDataKey, open, seal } from "./crypto.ts";
import type { Tier } from "../kernel/tier.ts";

export type Creds =
  | { kind: "key"; mindKey: string }
  | { kind: "oauth"; accessToken: string; refreshToken?: string; clientId: string };

export interface UserRecord {
  id: string;
  username: string;
  tier: Tier;
  createdAt: number;
  lastLoginAt: number;
}

/** Who a request is acting as. "owner" is the GATEWAY_TOKEN login (server MIND key). */
export interface Principal {
  id: string;
  username: string;
  tier: Tier;
  owner: boolean;
}
export const OWNER: Principal = { id: "owner", username: "owner", tier: "admin", owner: true };

interface Stored extends UserRecord { secret: string }
interface FileShape { v: 1; users: Record<string, Stored> }

export function userIdFor(username: string): string {
  return "u_" + createHash("sha256").update("daebot-user:" + username.trim().toLowerCase()).digest("hex").slice(0, 24);
}

export function parseList(v: string | undefined): string[] {
  return (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/** Admins (DAEBOT_ADMINS, MIND usernames) get the unrestricted tier; everyone else is staff (no outward/irreversible/public tools). */
export function tierFor(username: string, admins: string[]): Tier {
  return admins.includes(username.trim().toLowerCase()) ? "admin" : "staff";
}

export class UserStore {
  private path: string;
  private key?: Buffer;
  private users = new Map<string, Stored>();
  private admins: string[];
  /** Records present on disk that this process cannot decrypt (wrong key / tampered). They stay until the user signs in again. */
  unreadable = 0;

  constructor(o: { dir: string; secretKey?: string; admins?: string[] }) {
    this.path = join(o.dir, "daebot-users.json");
    this.admins = o.admins ?? [];
    if (o.secretKey !== undefined && o.secretKey !== "") {
      try { this.key = deriveDataKey(o.secretKey); } catch (e) { throw new HostedConfigError((e as Error).message); }
    }
    this.load();
    // Refuse to run with stored users and nothing to decrypt them with (would silently orphan every account).
    if (this.users.size > 0 && !this.key) {
      throw new HostedConfigError("user records exist but DAEBOT_SECRET_KEY is not set. Refusing to start hosted without it.");
    }
    if (this.key) for (const u of this.users.values()) { try { open(this.key, u.secret, u.id); } catch { this.unreadable++; } }
  }

  /** True when user sign-in can be offered (a data key is configured). */
  get enabled(): boolean { return !!this.key; }
  count(): number { return this.users.size; }

  private load(): void {
    if (!existsSync(this.path)) return;
    let parsed: FileShape;
    try { parsed = JSON.parse(readFileSync(this.path, "utf8")); } catch { throw new HostedConfigError("daebot-users.json is unreadable; refusing to start (move it aside to reset)."); }
    for (const [id, u] of Object.entries(parsed?.users ?? {})) {
      if (u && typeof u.username === "string" && typeof u.secret === "string" && userIdFor(u.username) === id) this.users.set(id, { ...u, id });
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const data: FileShape = { v: 1, users: Object.fromEntries(this.users) };
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* best effort */ }
  }

  get(id: string): UserRecord | undefined {
    const u = this.users.get(id);
    if (!u) return undefined;
    // Tier is recomputed from the live DAEBOT_ADMINS list, so removing an admin takes effect immediately.
    return { id: u.id, username: u.username, tier: tierFor(u.username, this.admins), createdAt: u.createdAt, lastLoginAt: u.lastLoginAt };
  }

  principal(id: string): Principal | undefined {
    const u = this.get(id);
    return u ? { id: u.id, username: u.username, tier: u.tier, owner: false } : undefined;
  }

  /** Creates or updates the user's record with fresh credentials. */
  upsert(username: string, creds: Creds, now = Date.now()): UserRecord {
    if (!this.key) throw new SealError("user storage is disabled (no DAEBOT_SECRET_KEY)");
    const name = username.trim();
    const id = userIdFor(name);
    const prev = this.users.get(id);
    const rec: Stored = {
      id, username: name, tier: tierFor(name, this.admins),
      createdAt: prev?.createdAt ?? now, lastLoginAt: now,
      secret: seal(this.key, creds, id),
    };
    this.users.set(id, rec);
    this.persist();
    return this.get(id)!;
  }

  /** Decrypts a user's credentials; undefined when missing or unreadable. */
  creds(id: string): Creds | undefined {
    const u = this.users.get(id);
    if (!u || !this.key) return undefined;
    try { return open<Creds>(this.key, u.secret, id); } catch { return undefined; }
  }

  setCreds(id: string, creds: Creds): void {
    const u = this.users.get(id);
    if (!u || !this.key) return;
    u.secret = seal(this.key, creds, id);
    this.persist();
  }

  remove(id: string): void {
    if (this.users.delete(id)) this.persist();
  }
}
