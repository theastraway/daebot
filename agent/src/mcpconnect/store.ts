// Per-user store of connected MCP servers. Each server record (URL, tool list, allow list AND its credentials) is sealed as one
// AES-256-GCM blob under DAEBOT_SECRET_KEY, bound to "<user>:<server id>" so a blob cannot be moved to another user or server.
// The file therefore shows nothing but ids; a flipped bit fails authentication and the record is reported unreadable.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HostedConfigError } from "../hosted.ts";
import { SealError, deriveDataKey, open, seal } from "../auth/crypto.ts";

export type Publisher = "official" | "community" | "unknown";
export type AuthKind = "none" | "key" | "oauth";

export interface ToolInfo {
  name: string;
  description: string;
  readOnly: boolean;      // server says readOnlyHint: true
  destructive: boolean;   // server says destructiveHint: true
  schema: Record<string, unknown>;
}

export type Secret =
  | { kind: "none" }
  | { kind: "key"; key: string }
  | { kind: "oauth"; accessToken: string; refreshToken?: string; expiresAt?: number; clientId: string; clientSecret?: string; tokenEndpoint: string; resource: string };

export interface ServerRec {
  id: string;
  name: string;            // slug used in tool names: <name>__<tool>
  url: string;
  host: string;
  publisher: Publisher;
  auth: AuthKind;
  enabled: boolean;
  addedAt: number;
  tools: ToolInfo[];
  allow: string[];         // tool names the user lets run without asking
  truncated?: boolean;     // the server offered more tools than the per-user cap allowed
  secret: Secret;
}

interface FileShape { v: 1; users: Record<string, Record<string, string>> }

export class McpStore {
  private path: string;
  private key?: Buffer;
  private sealed = new Map<string, Map<string, string>>();
  private cache = new Map<string, Map<string, ServerRec>>();
  private versions = new Map<string, number>();
  /** Records on disk that this process could not decrypt (wrong key or tampered). */
  unreadable = 0;

  constructor(o: { dir: string; secretKey?: string }) {
    this.path = join(o.dir, "daebot-mcp.json");
    if (o.secretKey !== undefined && o.secretKey.trim() !== "") {
      try { this.key = deriveDataKey(o.secretKey); } catch (e) { throw new HostedConfigError((e as Error).message); }
    }
    this.load();
  }

  /** False when no data key is configured: nothing can be stored securely, so connecting is off. */
  get enabled(): boolean { return !!this.key; }

  private load(): void {
    if (!existsSync(this.path)) return;
    let parsed: FileShape;
    try { parsed = JSON.parse(readFileSync(this.path, "utf8")); } catch { return; } // a damaged file is treated as empty; connections can be made again
    for (const [uid, recs] of Object.entries(parsed?.users ?? {})) {
      const m = new Map<string, string>();
      for (const [id, blob] of Object.entries(recs ?? {})) if (typeof blob === "string") m.set(id, blob);
      if (m.size) this.sealed.set(uid, m);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const data: FileShape = { v: 1, users: {} };
    for (const [uid, m] of this.sealed) if (m.size) data.users[uid] = Object.fromEntries(m);
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* best effort */ }
  }

  private bump(uid: string): void { this.versions.set(uid, (this.versions.get(uid) ?? 0) + 1); this.cache.delete(uid); }
  /** Changes whenever this user's servers change (tool objects are cached on it). */
  version(uid: string): number { return this.versions.get(uid) ?? 0; }

  private decrypted(uid: string): Map<string, ServerRec> {
    const hit = this.cache.get(uid);
    if (hit) return hit;
    const out = new Map<string, ServerRec>();
    if (this.key) {
      for (const [id, blob] of this.sealed.get(uid) ?? []) {
        try { out.set(id, open<ServerRec>(this.key, blob, `mcp:${uid}:${id}`)); } catch { this.unreadable++; }
      }
    }
    this.cache.set(uid, out);
    return out;
  }

  list(uid: string): ServerRec[] {
    return [...this.decrypted(uid).values()].sort((a, b) => a.addedAt - b.addedAt);
  }

  get(uid: string, id: string): ServerRec | undefined {
    return this.decrypted(uid).get(id);
  }

  put(uid: string, rec: ServerRec): void {
    if (!this.key) throw new SealError("connected servers cannot be stored (no DAEBOT_SECRET_KEY)");
    let m = this.sealed.get(uid);
    if (!m) this.sealed.set(uid, (m = new Map()));
    m.set(rec.id, seal(this.key, rec, `mcp:${uid}:${rec.id}`));
    this.persist();
    this.bump(uid);
  }

  /** Rewrites a record WITHOUT invalidating cached tool objects (a refreshed OAuth token changes nothing the model can see). */
  update(uid: string, rec: ServerRec): void {
    if (!this.key) throw new SealError("connected servers cannot be stored (no DAEBOT_SECRET_KEY)");
    const m = this.sealed.get(uid);
    if (!m || !m.has(rec.id)) return;
    m.set(rec.id, seal(this.key, rec, `mcp:${uid}:${rec.id}`));
    this.persist();
    this.decrypted(uid).set(rec.id, rec);
  }

  remove(uid: string, id: string): boolean {
    const m = this.sealed.get(uid);
    if (!m || !m.delete(id)) return false;
    this.persist();
    this.bump(uid);
    return true;
  }
}
