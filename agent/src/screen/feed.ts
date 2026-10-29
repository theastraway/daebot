// Live screen feed: the in-memory half. The desktop shell (Electron main) captures the primary display at a low frame rate and POSTs each
// frame to the local gateway (gateway/screen.ts); this ring buffer holds the last N seconds. Frames live in memory only: they are never
// written to disk (unless the user asks `screen save`) and never leave this process except the few frames a tool hands the model in a turn.
// Turning the feed off clears the buffer.
//
// Change detection runs on a tiny grayscale signature (SIG_W x SIG_H bytes) the shell computes next to each JPEG, so no image decoder is
// needed here. The wire contract with desktop/src/lib/screen-frame.mjs is: one byte of luma per cell, row-major, SIG_W * SIG_H bytes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SIG_W = 64;
export const SIG_H = 36;
export const SIG_LEN = SIG_W * SIG_H;
export const DEFAULT_FPS = 2;
export const MAX_FPS = 5;
export const DEFAULT_BUFFER_SECONDS = 30;
export const MAX_BUFFER_SECONDS = 120;
export const MAX_FRAME_BYTES = 1_500_000;
/** A cell counts as changed when its luma moved by more than this (0-255). Absorbs JPEG noise, cursor blink and clock-free anti-aliasing. */
export const CELL_DELTA = 16;
/** Default wait_for_change threshold: this fraction of the (region of the) screen must change. 0.02 is about a 13x13 cell block: a dialog or a progress bar, not a blinking caret. */
export const DEFAULT_CHANGE_THRESHOLD = 0.02;
/** A frame this old no longer counts as "live". */
export const LIVE_MAX_AGE_MS = 4000;
const HARD_FRAME_CAP = 600;

export type ScreenPermission = "granted" | "needs-permission" | "restricted" | "unsupported" | "unknown";
const PERMISSIONS: readonly ScreenPermission[] = ["granted", "needs-permission", "restricted", "unsupported", "unknown"];

export interface Frame {
  id: number;
  /** Arrival time (ms since epoch) at this process. */
  t: number;
  jpeg: Buffer;
  /** Pixel size of the JPEG (what the model sees and clicks in). */
  width: number;
  height: number;
  /** The real screen size in pixels. */
  screenWidth: number;
  screenHeight: number;
  /** Pointer position in JPEG pixels. */
  cursorX: number;
  cursorY: number;
  sig: Uint8Array;
}

export interface FeedState {
  /** The user has the "Let Daebot watch my screen" switch on. */
  watching: boolean;
  /** Can the OS capture the screen right now? Only `granted` lets frames flow. */
  permission: ScreenPermission;
  fps: number;
  bufferSeconds: number;
  /** Last capture problem the shell reported, for the model and the user. */
  error?: string;
}

export interface Region { x: number; y: number; w: number; h: number }

/** Fraction (0-1) of cells whose luma differs by more than CELL_DELTA between two signatures, optionally limited to a frame-pixel region. */
export function changeScore(a: Uint8Array, b: Uint8Array, region?: { cells: CellBox }): number {
  if (a.length !== SIG_LEN || b.length !== SIG_LEN) return 0;
  const box = region?.cells ?? { x0: 0, y0: 0, x1: SIG_W, y1: SIG_H };
  let changed = 0, total = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = y * SIG_W + x;
      total++;
      if (Math.abs(a[i] - b[i]) > CELL_DELTA) changed++;
    }
  }
  return total === 0 ? 0 : changed / total;
}

export interface CellBox { x0: number; y0: number; x1: number; y1: number }

/** Map a region in frame pixels to signature cells (at least one cell). Returns undefined for a region that is empty or off the frame. */
export function regionToCells(r: Region, frameW: number, frameH: number): CellBox | undefined {
  if (![r.x, r.y, r.w, r.h, frameW, frameH].every((n) => Number.isFinite(n)) || r.w <= 0 || r.h <= 0 || frameW <= 0 || frameH <= 0) return undefined;
  const x0 = Math.max(0, Math.floor((r.x / frameW) * SIG_W));
  const y0 = Math.max(0, Math.floor((r.y / frameH) * SIG_H));
  const x1 = Math.min(SIG_W, Math.max(x0 + 1, Math.ceil(((r.x + r.w) / frameW) * SIG_W)));
  const y1 = Math.min(SIG_H, Math.max(y0 + 1, Math.ceil(((r.y + r.h) / frameH) * SIG_H)));
  if (x0 >= SIG_W || y0 >= SIG_H) return undefined;
  return { x0, y0, x1, y1 };
}

/** n keyframes from a time-ordered list: always the first and the last, the rest are the frames where the screen changed most from the one before. */
export function pickKeyframes(frames: Frame[], n: number): Frame[] {
  const want = Math.max(1, Math.floor(n));
  if (frames.length <= want) return frames.slice();
  if (want === 1) return [frames[frames.length - 1]];
  const picked = new Set<number>([0, frames.length - 1]);
  const jumps: { i: number; s: number }[] = [];
  for (let i = 1; i < frames.length - 1; i++) jumps.push({ i, s: changeScore(frames[i - 1].sig, frames[i].sig) });
  jumps.sort((a, b) => b.s - a.s || a.i - b.i);
  for (const j of jumps) {
    if (picked.size >= want) break;
    picked.add(j.i);
  }
  return [...picked].sort((a, b) => a - b).map((i) => frames[i]);
}

export interface ChangeResult { changed: boolean; frame: Frame; score: number; waitedMs: number }

export class ScreenFeed {
  private frames: Frame[] = [];
  private seq = 0;
  private st: FeedState = { watching: false, permission: "unknown", fps: DEFAULT_FPS, bufferSeconds: DEFAULT_BUFFER_SECONDS };
  private waiters = new Set<() => void>();
  /** Set the first time the desktop shell reports state, so a headless/CLI gateway can say the shell is missing. */
  attached = false;
  private frameListeners = new Set<(f: Frame) => void>();

  /** Runs `fn` for every frame that is stored (routines that wait for the screen to change). Returns the function that stops it. */
  onFrame(fn: (f: Frame) => void): () => void { this.frameListeners.add(fn); return () => { this.frameListeners.delete(fn); }; }

  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  state(): FeedState { return { ...this.st }; }

  /** True when frames are allowed to flow: the switch is on AND the OS lets us capture. */
  active(): boolean { return this.st.watching && this.st.permission === "granted"; }

  /** active() and a frame arrived recently. */
  live(maxAgeMs = LIVE_MAX_AGE_MS): boolean {
    if (!this.active()) return false;
    const f = this.latest();
    return !!f && this.now() - f.t <= maxAgeMs;
  }

  /** Apply what the shell reports. Turning the switch off, or losing the OS permission, drops every buffered frame. */
  setState(patch: Partial<FeedState>): FeedState {
    this.attached = true;
    const next: FeedState = { ...this.st };
    if (typeof patch.watching === "boolean") next.watching = patch.watching;
    if (patch.permission && PERMISSIONS.includes(patch.permission)) next.permission = patch.permission;
    if (typeof patch.fps === "number" && Number.isFinite(patch.fps)) next.fps = Math.min(MAX_FPS, Math.max(0.2, patch.fps));
    if (typeof patch.bufferSeconds === "number" && Number.isFinite(patch.bufferSeconds)) next.bufferSeconds = Math.min(MAX_BUFFER_SECONDS, Math.max(2, Math.round(patch.bufferSeconds)));
    if ("error" in patch) { if (typeof patch.error === "string" && patch.error) next.error = patch.error.slice(0, 300); else delete next.error; }
    this.st = next;
    if (!this.active()) this.frames = [];
    this.trim();
    this.wake();
    return this.state();
  }

  /** Store a frame. Returns false (and keeps nothing) when the feed is not active or the frame is malformed. */
  ingest(f: Omit<Frame, "id" | "t"> & { t?: number }): boolean {
    if (!this.active()) return false;
    if (f.sig.length !== SIG_LEN || !(f.jpeg.length > 0) || f.jpeg.length > MAX_FRAME_BYTES) return false;
    if (!(f.width > 0 && f.height > 0)) return false;
    const stored: Frame = { ...f, id: ++this.seq, t: f.t ?? this.now() };
    this.frames.push(stored);
    this.trim();
    this.wake();
    for (const fn of this.frameListeners) { try { fn(stored); } catch { /* a listener never breaks the feed */ } }
    return true;
  }

  latest(): Frame | undefined { return this.frames[this.frames.length - 1]; }
  count(): number { return this.frames.length; }
  /** Seconds of video currently held. */
  span(): number { return this.frames.length < 2 ? 0 : (this.frames[this.frames.length - 1].t - this.frames[0].t) / 1000; }

  /** Frames from the last `seconds`, oldest first. */
  recent(seconds: number): Frame[] {
    const from = this.now() - Math.max(0, seconds) * 1000;
    return this.frames.filter((f) => f.t >= from);
  }

  private trim(): void {
    const keepFrom = this.now() - this.st.bufferSeconds * 1000;
    let drop = 0;
    while (drop < this.frames.length - 1 && this.frames[drop].t < keepFrom) drop++;
    if (drop) this.frames.splice(0, drop);
    if (this.frames.length > HARD_FRAME_CAP) this.frames.splice(0, this.frames.length - HARD_FRAME_CAP);
  }

  private wake(): void {
    const w = [...this.waiters];
    this.waiters.clear();
    for (const fn of w) fn();
  }

  /** The first frame newer than `afterId` (or arriving after time `afterT`), or undefined on timeout, abort or when the feed turns off. */
  async next(opts: { afterId?: number; afterT?: number; timeoutMs: number; signal?: AbortSignal }): Promise<Frame | undefined> {
    const deadline = this.now() + opts.timeoutMs;
    for (;;) {
      if (opts.signal?.aborted || !this.active()) return undefined;
      const hit = this.frames.find((f) => (opts.afterId === undefined || f.id > opts.afterId) && (opts.afterT === undefined || f.t >= opts.afterT));
      if (hit) return hit;
      const left = deadline - this.now();
      if (left <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); this.waiters.delete(done); opts.signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, left);
        this.waiters.add(done);
        opts.signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  /**
   * Block until the screen differs from how it looks right now by more than `threshold` (a fraction of cells), then wait until it has been
   * still for `settleMs` (so a page that is still loading is not returned half drawn), then return that frame. On timeout returns the latest frame with changed:false.
   */
  async waitForChange(o: { timeoutMs: number; threshold?: number; settleMs?: number; region?: Region; signal?: AbortSignal }): Promise<ChangeResult | undefined> {
    const started = this.now();
    const threshold = o.threshold ?? DEFAULT_CHANGE_THRESHOLD;
    const settleMs = o.settleMs ?? 500;
    let base = this.latest();
    if (!base) base = await this.next({ timeoutMs: Math.min(3000, o.timeoutMs), signal: o.signal });
    if (!base) return undefined;
    const box = o.region ? regionToCells(o.region, base.width, base.height) : undefined;
    const cells = box ? { cells: box } : undefined;
    const deadline = started + o.timeoutMs;
    let cursor = base;
    for (;;) {
      const f = await this.next({ afterId: cursor.id, timeoutMs: deadline - this.now(), signal: o.signal });
      if (!f) return { changed: false, frame: this.latest() ?? base, score: 0, waitedMs: this.now() - started };
      cursor = f;
      const score = changeScore(base.sig, f.sig, cells);
      if (score <= threshold) continue;
      // Changed. Settle: follow the screen until it stops moving (or 5 s pass).
      let prev = f, quietSince = f.t;
      const cap = f.t + 5000;
      while (prev.t - quietSince < settleMs && prev.t < cap) {
        const g = await this.next({ afterId: prev.id, timeoutMs: Math.max(1500, settleMs * 2), signal: o.signal });
        if (!g) break;
        if (changeScore(prev.sig, g.sig, cells) > 0.002) quietSince = g.t;
        prev = g;
      }
      return { changed: true, frame: prev, score, waitedMs: this.now() - started };
    }
  }

  /** Write the frames of the last `seconds` as numbered JPEGs into `dir`. Only ever called for an explicit `screen save`. */
  save(dir: string, seconds: number): { dir: string; files: string[] } {
    const frames = this.recent(seconds);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const files: string[] = [];
    for (const f of frames) {
      const name = `frame-${String(files.length + 1).padStart(4, "0")}-${new Date(f.t).toISOString().replace(/[:.]/g, "-")}.jpg`;
      writeFileSync(join(dir, name), f.jpeg, { mode: 0o600 });
      files.push(name);
    }
    return { dir, files };
  }

  /** Drop everything (stop, sign out, shutdown). */
  clear(): void { this.frames = []; this.wake(); }
}

/** The process-wide feed the gateway routes fill and the screen and computer tools read. One user per desktop gateway. */
export const screenFeed = new ScreenFeed();

export function frameDataUrl(f: Frame): string { return `data:image/jpeg;base64,${f.jpeg.toString("base64")}`; }
