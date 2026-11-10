// Tombstones: "this session was deleted at T". Without them an offline device that comes back would push its copy of a deleted session and
// bring it back to life. Keyed by owner (hosted holds every user's; a device holds only its own, under "owner"). Kept 180 days, saved atomically.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const TOMBSTONE_KEEP_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_PER_OWNER = 20_000;

export interface TombstoneRow { id: string; at: number }

export class TombstoneBook {
  private by = new Map<string, Map<string, number>>();
  private pend = new Set<string>();
  private file?: string;
  private now: () => number;

  constructor(o: { file?: string; now?: () => number } = {}) {
    this.file = o.file;
    this.now = o.now ?? Date.now;
    if (this.file) {
      try {
        const j = JSON.parse(readFileSync(this.file, "utf8"));
        for (const [owner, rows] of Object.entries((j?.owners ?? {}) as Record<string, Record<string, number>>)) {
          const m = new Map<string, number>();
          for (const [id, at] of Object.entries(rows)) if (typeof at === "number") m.set(id, at);
          this.by.set(owner, m);
        }
        for (const id of Array.isArray(j?.pending) ? j.pending : []) if (typeof id === "string") this.pend.add(id);
      } catch { /* first use, or a torn file: start empty */ }
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const owners: Record<string, Record<string, number>> = {};
      for (const [o, m] of this.by) owners[o] = Object.fromEntries(m);
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ owners, pending: [...this.pend] }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* a failed save never blocks a delete */ }
  }

  private map(owner: string): Map<string, number> {
    let m = this.by.get(owner);
    if (!m) this.by.set(owner, (m = new Map()));
    return m;
  }

  has(owner: string, id: string): boolean { return this.by.get(owner)?.has(id) === true; }
  at(owner: string, id: string): number | undefined { return this.by.get(owner)?.get(id); }

  /** Records a delete. Returns the stored time (the first delete's time stands: a tombstone never moves later). */
  mark(owner: string, id: string, at = this.now()): number {
    const m = this.map(owner);
    const prev = m.get(id);
    if (prev !== undefined) return prev;
    m.set(id, at);
    if (m.size > MAX_PER_OWNER) { const first = m.keys().next().value; if (first !== undefined) m.delete(first); }
    this.save();
    return at;
  }

  /** Rows of one owner deleted after `since` (a sync-clock time), oldest first. Expired ones are dropped here. */
  since(owner: string, since: number): TombstoneRow[] {
    const m = this.by.get(owner);
    if (!m) return [];
    const out: TombstoneRow[] = [];
    let dropped = false;
    for (const [id, at] of m) {
      if (this.now() - at > TOMBSTONE_KEEP_MS && at < this.now()) { m.delete(id); dropped = true; continue; }
      if (at > since) out.push({ id, at });
    }
    if (dropped) this.save();
    return out.sort((a, b) => a.at - b.at);
  }

  /** Device side: deletes the server has not been told about yet (survive a restart and an offline stretch). */
  pending(): string[] { return [...this.pend]; }
  addPending(id: string): void { if (!this.pend.has(id)) { this.pend.add(id); this.save(); } }
  clearPending(id: string): void { if (this.pend.delete(id)) this.save(); }
}
