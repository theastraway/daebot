// Desktop-only event sources: folder watches (file_changed) and the screen feed (screen_change). The runner calls sync() every tick with
// the books on this computer, and this keeps exactly one fs watcher per file_changed routine and one frame listener for the screen
// ones, starting and stopping them as routines come, go, change folder or turn off. Hosted servers never build one of these.
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { changeScore } from "../screen/feed.ts";
import type { Frame, ScreenFeed } from "../screen/feed.ts";
import type { RoutineBook } from "./store.ts";

type Fire = (owner: string, botId: string, routineId: string, text: string) => boolean;
export const SENSITIVITY = { low: 0.15, medium: 0.05, high: 0.02 } as const;
export const FILE_SETTLE_MS = 3000;          // file changes: wait this long after the last one before running
export const SCREEN_SETTLE_MS = 1500;        // the picture must hold still this long before the change counts
export const SCREEN_COOLDOWN_MS = 60_000;
const MAX_NAMES = 20;

interface FileWatch { key: string; path: string; w?: FSWatcher; names: Set<string>; timer?: NodeJS.Timeout; error?: string }
interface ScreenWatch { key: string; owner: string; botId: string; id: string; threshold: number; base?: Uint8Array; lastFire: number; timer?: NodeJS.Timeout; score: number }

export class LocalSources {
  private files = new Map<string, FileWatch>();
  private screens = new Map<string, ScreenWatch>();
  private off?: () => void;
  private fire: Fire;
  private feed?: ScreenFeed;
  private now: () => number;
  private watchImpl: typeof watch;
  private t: { file: number; screen: number; cooldown: number };

  constructor(o: { fire: Fire; screen?: ScreenFeed; now?: () => number; watchImpl?: typeof watch; settleMs?: number; screenSettleMs?: number; cooldownMs?: number }) {
    this.t = { file: o.settleMs ?? FILE_SETTLE_MS, screen: o.screenSettleMs ?? SCREEN_SETTLE_MS, cooldown: o.cooldownMs ?? SCREEN_COOLDOWN_MS };
    this.fire = o.fire;
    this.feed = o.screen;
    this.now = o.now ?? Date.now;
    this.watchImpl = o.watchImpl ?? watch;
  }

  /** Brings the watchers in step with the routines. Idempotent. */
  sync(books: RoutineBook[]): void {
    const wantFiles = new Map<string, { owner: string; botId: string; id: string; path: string }>();
    const wantScreens = new Map<string, { owner: string; botId: string; id: string; threshold: number }>();
    for (const b of books) {
      for (const r of b.list()) {
        if (r.kind !== "trigger" || !r.enabled || !r.trigger) continue;
        const key = `${b.owner}\u0000${b.botId}\u0000${r.id}`;
        if (r.trigger.type === "file_changed" && r.trigger.path) wantFiles.set(key, { owner: b.owner, botId: b.botId, id: r.id, path: r.trigger.path });
        if (r.trigger.type === "screen_change") wantScreens.set(key, { owner: b.owner, botId: b.botId, id: r.id, threshold: SENSITIVITY[r.trigger.sensitivity ?? "medium"] });
      }
    }
    for (const [k, w] of this.files) if (!wantFiles.has(k) || wantFiles.get(k)!.path !== w.path) this.closeFile(k);
    for (const [k, v] of wantFiles) if (!this.files.has(k)) this.openFile(k, v.owner, v.botId, v.id, v.path);
    for (const k of [...this.screens.keys()]) if (!wantScreens.has(k)) { clearTimeout(this.screens.get(k)!.timer); this.screens.delete(k); }
    for (const [k, v] of wantScreens) {
      const cur = this.screens.get(k);
      if (cur) cur.threshold = v.threshold;
      else this.screens.set(k, { key: k, ...v, lastFire: 0, score: 0 });
    }
    if (this.screens.size && this.feed && !this.off) this.off = this.feed.onFrame((f) => this.frame(f));
    if (!this.screens.size && this.off) { this.off(); this.off = undefined; }
  }

  /** Folder watches that failed to start (shown to the user instead of silently doing nothing). */
  errors(): { path: string; error: string }[] { return [...this.files.values()].filter((w) => w.error).map((w) => ({ path: w.path, error: w.error! })); }

  private openFile(key: string, owner: string, botId: string, id: string, path: string): void {
    const fw: FileWatch = { key, path, names: new Set() };
    this.files.set(key, fw);
    try {
      fw.w = this.watchImpl(path, { recursive: true, persistent: false }, (_ev, name) => {
        const n = String(name ?? "");
        if (n && (n.split(/[\\/]/).some((seg) => seg.startsWith(".")) || n.startsWith("~$") || n.endsWith("~"))) return;   // dotfiles, editor and Office temp files
        if (fw.names.size < 200) fw.names.add(n || "(a file)");
        clearTimeout(fw.timer);
        fw.timer = setTimeout(() => {
          const list = [...fw.names]; fw.names.clear();
          if (!list.length) return;
          const more = list.length > MAX_NAMES ? `\n(and ${list.length - MAX_NAMES} more)` : "";
          this.fire(owner, botId, id, `Files changed in ${path}:\n${list.slice(0, MAX_NAMES).map((x) => `- ${x}`).join("\n")}${more}`);
        }, this.t.file);
        fw.timer.unref?.();
      });
      fw.w.on("error", (e) => { fw.error = String((e as Error)?.message ?? e).slice(0, 120); });
    } catch (e) { fw.error = String((e as Error)?.message ?? e).slice(0, 120); }
  }
  private closeFile(key: string): void {
    const w = this.files.get(key);
    if (!w) return;
    clearTimeout(w.timer);
    try { w.w?.close(); } catch { /* already closed */ }
    this.files.delete(key);
  }

  private frame(f: Frame): void {
    const t = this.now();
    for (const s of this.screens.values()) {
      if (!s.base) { s.base = f.sig; continue; }
      const score = changeScore(s.base, f.sig);
      if (score <= s.threshold || t - s.lastFire < this.t.cooldown) continue;
      s.score = Math.max(s.score, score);
      // Changed: let it settle (a page still loading is not "done"), then run once and take the new picture as the baseline.
      clearTimeout(s.timer);
      s.timer = setTimeout(() => {
        s.timer = undefined;
        const latest = this.feed?.latest();
        if (latest) s.base = latest.sig;
        s.lastFire = this.now();
        const pct = Math.round(s.score * 100); s.score = 0;
        this.fire(s.owner, s.botId, s.id, `The screen changed (about ${pct}% of it).`);
      }, this.t.screen);
      s.timer.unref?.();
    }
  }

  stop(): void {
    for (const k of [...this.files.keys()]) this.closeFile(k);
    for (const s of this.screens.values()) clearTimeout(s.timer);
    this.screens.clear();
    this.off?.(); this.off = undefined;
  }
}
