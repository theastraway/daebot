// Per-user connector preferences, saved on the server (the data disk): which tools of a connector the user switched off, and the labels
// they gave their accounts. A switched-off tool is removed from the agent's tool list for that user on their next turn, on every Daebot.
// Nothing secret lives here; the file is plain JSON next to the sealed store.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface UserPrefs { off: string[]; labels: Record<string, string> }
interface FileShape { v: 1; users: Record<string, UserPrefs> }

const MAX_OFF = 4000;

export class ConnectorPrefs {
  private path?: string;
  private users = new Map<string, UserPrefs>();
  private ver = new Map<string, number>();
  constructor(o: { dir?: string } = {}) {
    if (!o.dir) return;
    this.path = join(o.dir, "daebot-connector-prefs.json");
    try {
      if (existsSync(this.path)) {
        const j = JSON.parse(readFileSync(this.path, "utf8")) as FileShape;
        if (j && j.v === 1 && j.users && typeof j.users === "object") {
          for (const [uid, u] of Object.entries(j.users)) {
            this.users.set(uid, { off: Array.isArray(u?.off) ? u.off.filter((x) => typeof x === "string").slice(0, MAX_OFF) : [], labels: u?.labels && typeof u.labels === "object" ? { ...u.labels } : {} });
          }
        }
      }
    } catch { /* unreadable: start empty, never crash a turn */ }
  }

  private get(uid: string): UserPrefs { let u = this.users.get(uid); if (!u) { u = { off: [], labels: {} }; this.users.set(uid, u); } return u; }
  private save(): void {
    if (!this.path) return;
    try {
      const users: Record<string, UserPrefs> = {};
      for (const [k, v] of this.users) if (v.off.length || Object.keys(v.labels).length) users[k] = v;
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, users } satisfies FileShape), { mode: 0o600 });
      renameSync(tmp, this.path);
      try { chmodSync(this.path, 0o600); } catch { /* best effort */ }
    } catch { /* the choice still holds in memory until restart */ }
  }

  /** Changes whenever this user's preferences change (folded into the tool-list cache signature). */
  version(uid: string): number { return this.ver.get(uid) ?? 0; }
  private bump(uid: string): void { this.ver.set(uid, (this.ver.get(uid) ?? 0) + 1); }

  static key(server: string, tool: string): string { return `${server}__${tool}`; }
  toolOff(uid: string, server: string, tool: string): boolean { const u = this.users.get(uid); return !!u && u.off.includes(ConnectorPrefs.key(server, tool)); }
  setTool(uid: string, server: string, tool: string, enabled: boolean): void {
    const u = this.get(uid), k = ConnectorPrefs.key(server, tool), has = u.off.includes(k);
    if (enabled && has) u.off = u.off.filter((x) => x !== k);
    else if (!enabled && !has && u.off.length < MAX_OFF) u.off.push(k);
    else return;
    this.bump(uid); this.save();
  }
  label(uid: string, accountKey: string): string | undefined { return this.users.get(uid)?.labels[accountKey]; }
  setLabel(uid: string, accountKey: string, label: string): void {
    const u = this.get(uid), clean = label.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    if (clean) u.labels[accountKey] = clean; else delete u.labels[accountKey];
    if (Object.keys(u.labels).length > 200) delete u.labels[Object.keys(u.labels)[0]];
    this.bump(uid); this.save();
  }
  /** Forget everything about one connector's servers (Uninstall): its switched-off tools and account labels. */
  forgetServer(uid: string, server: string, accountKey?: string): void {
    const u = this.users.get(uid); if (!u) return;
    u.off = u.off.filter((x) => !x.startsWith(`${server}__`));
    if (accountKey) delete u.labels[accountKey];
    this.bump(uid); this.save();
  }
}
