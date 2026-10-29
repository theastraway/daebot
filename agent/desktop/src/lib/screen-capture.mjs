// The capture loop: Electron desktopCapturer -> downscaled JPEG + change signature -> the local gateway's ring buffer. Everything Electron-specific is
// injected (desktopCapturer, screen, getAccess, post, report), so the loop is unit tested with fakes. Frames are never written to disk here.
// Low frame rate on purpose: the model reads one frame at a time, so 2 fps is plenty and costs about 15 ms of CPU per frame.
import { captureGeometry, cursorInFrame, signature, SIG_H, SIG_W } from "./screen-frame.mjs";

export const DEFAULT_FPS = 2;
export const MAX_FPS = 5;
export const MIN_FPS = 0.2;
const RECHECK_MS = 3000;   // while permission is missing: look again for the user's grant
const ERROR_AFTER = 3;     // consecutive failed frames before the problem is reported

export const clampFps = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.min(MAX_FPS, Math.max(MIN_FPS, n)) : DEFAULT_FPS);

export class ScreenCapture {
  /**
   * @param {object} o
   * @param {{getSources: Function}} o.desktopCapturer
   * @param {{getPrimaryDisplay: Function, getCursorScreenPoint: Function}} o.screen
   * @param {() => {state: string, askable?: boolean, canOpenSettings?: boolean}} o.getAccess  current OS permission (screen-permission.mjs)
   * @param {(frame: object) => Promise<void>} o.post  upload one frame to the gateway
   * @param {(state: {watching: boolean, permission: string, fps: number, error?: string}) => void} o.report  tell the gateway and the UI
   */
  constructor(o) {
    this.o = o;
    this.fps = clampFps(o.fps);
    this.quality = o.quality ?? 60;
    this.setTimer = o.setTimer ?? setTimeout;
    this.clearTimer = o.clearTimer ?? clearTimeout;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    this.mode = "off"; // off | waiting (no permission yet) | running
    this.timer = null;
    this.fails = 0;
    this.errored = false;
    this.permission = "unknown";
    this.probed = false;
    this.inflight = false;
  }

  get running() { return this.mode === "running"; }
  get watching() { return this.mode !== "off"; }

  /** The user turned the switch on. Reads the OS permission; captures only when it is granted. */
  async start() {
    if (this.mode !== "off") return this.snapshot();
    this.mode = "waiting";
    this.fails = 0;
    this.errored = false;
    await this.#evaluate();
    return this.snapshot();
  }

  /** The user turned it off (or the app is quitting). Reports watching:false so the gateway drops every buffered frame. */
  stop() {
    this.clearTimer(this.timer);
    this.timer = null;
    const was = this.mode !== "off";
    this.mode = "off";
    this.errored = false;
    if (was) this.#report();
    return this.snapshot();
  }

  setFps(n) {
    this.fps = clampFps(n);
    if (this.mode !== "off") this.#report();
  }

  snapshot() {
    return { watching: this.mode !== "off", permission: this.permission, fps: this.fps, ...(this.errored && this.lastError ? { error: this.lastError } : {}) };
  }

  #report() { try { this.o.report(this.snapshot()); } catch (e) { this.log("report failed:", String(e?.message ?? e)); } }

  async #evaluate() {
    let access = this.o.getAccess();
    // macOS never asked yet: one capture attempt makes the OS show its own "record the screen" prompt, which the USER answers. We never grant it.
    if (access.askable && !this.probed) {
      this.probed = true;
      try { await this.o.desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false }); } catch { /* the prompt is the point */ }
      access = this.o.getAccess();
    }
    this.permission = access.state;
    this.#report();
    this.clearTimer(this.timer);
    if (this.mode === "off") return;
    if (access.state === "granted") {
      this.mode = "running";
      this.#schedule(0);
    } else if (access.state === "needs-permission") {
      this.mode = "waiting";
      this.timer = this.setTimer(() => { if (this.mode === "waiting") void this.#evaluate(); }, RECHECK_MS);
      this.timer?.unref?.();
    } else {
      this.mode = "waiting"; // restricted / unsupported: nothing to poll for
    }
  }

  #schedule(ms) {
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { void this.#tick(); }, ms);
    this.timer?.unref?.();
  }

  async #tick() {
    if (this.mode !== "running" || this.inflight) return;
    this.inflight = true;
    const t0 = this.now();
    try {
      await this.#captureOnce();
      this.fails = 0;
      if (this.errored) { this.errored = false; this.lastError = undefined; this.#report(); }
    } catch (e) {
      this.fails++;
      this.lastError = String(e?.message ?? e).slice(0, 200);
      this.log("capture failed:", this.lastError);
      if (this.fails >= ERROR_AFTER && !this.errored) { this.errored = true; this.#report(); }
    } finally {
      this.inflight = false;
    }
    if (this.mode === "running") this.#schedule(Math.max(0, 1000 / this.fps - (this.now() - t0)));
  }

  async #captureOnce() {
    const { desktopCapturer, screen } = this.o;
    const display = screen.getPrimaryDisplay();
    const geo = captureGeometry({ width: display.size.width, height: display.size.height, scaleFactor: display.scaleFactor });
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: geo.width, height: geo.height }, fetchWindowIcons: false });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0];
    if (!src || !src.thumbnail || src.thumbnail.isEmpty()) throw new Error("the system returned no picture of the screen");
    const img = src.thumbnail;
    const size = img.getSize();
    const jpeg = img.toJPEG(Math.round(this.quality));
    const small = img.resize({ width: SIG_W, height: SIG_H, quality: "good" });
    const sig = signature(small.toBitmap());
    if (!sig) throw new Error("could not compute the change signature");
    const cur = cursorInFrame(screen.getCursorScreenPoint(), display, { ...geo, width: size.width, height: size.height });
    if (this.mode !== "running") return; // switched off while capturing: drop this frame
    await this.o.post({ jpeg, width: size.width, height: size.height, screenWidth: geo.physW, screenHeight: geo.physH, cursorX: cur.x, cursorY: cur.y, sig });
  }
}
