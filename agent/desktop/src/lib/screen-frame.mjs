// Pure helpers for the screen feed: the capture size, the tiny change-detection signature, the upload query and the red recording dot.
// The signature contract (SIG_W x SIG_H luma bytes, row-major) is shared with agent/src/screen/feed.ts.

export const SIG_W = 64;
export const SIG_H = 36;
export const SIG_LEN = SIG_W * SIG_H;
export const MAX_FRAME_WIDTH = 1366; // same as the computer tool's screenshot width, so frame coordinates are click coordinates

/**
 * The size the model sees. Mirrors computer.ts: width = min(1366, physical width), height scaled by the same factor.
 * display.size is in DIPs; physical pixels = DIPs * scaleFactor.
 */
export function captureGeometry({ width, height, scaleFactor = 1 }, maxWidth = MAX_FRAME_WIDTH) {
  const physW = Math.max(1, Math.round(width * scaleFactor));
  const physH = Math.max(1, Math.round(height * scaleFactor));
  const w = Math.min(maxWidth, physW);
  const f = physW / w;
  return { physW, physH, width: w, height: Math.max(1, Math.round(physH / f)), f };
}

/** BGRA bitmap of exactly SIG_W x SIG_H -> SIG_LEN luma bytes. Returns null when the bitmap is the wrong size. */
export function signature(bgra) {
  if (!bgra || bgra.length !== SIG_LEN * 4) return null;
  const out = new Uint8Array(SIG_LEN);
  for (let i = 0; i < SIG_LEN; i++) {
    const b = bgra[i * 4], g = bgra[i * 4 + 1], r = bgra[i * 4 + 2];
    out[i] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  return out;
}

const clampInt = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : 0)));

/** Pointer position in frame pixels from the Electron cursor point (DIPs, global) and the display. */
export function cursorInFrame(point, display, geo) {
  const x = ((point.x - display.bounds.x) * display.scaleFactor) / geo.f;
  const y = ((point.y - display.bounds.y) * display.scaleFactor) / geo.f;
  return { x: clampInt(x, 0, geo.width - 1), y: clampInt(y, 0, geo.height - 1) };
}

/** The query string for POST /screen/frame. */
export function frameQuery({ width, height, screenWidth, screenHeight, cursorX, cursorY, sig }) {
  const q = new URLSearchParams();
  q.set("w", String(width)); q.set("h", String(height));
  q.set("sw", String(screenWidth)); q.set("sh", String(screenHeight));
  q.set("cx", String(cursorX)); q.set("cy", String(cursorY));
  q.set("sig", Buffer.from(sig).toString("base64url"));
  return q.toString();
}

/**
 * A red recording dot as a BGRA bitmap (size x size) for the tray while the screen feed is on. Not a template image on purpose: it must stay red
 * in light and dark menu bars. Anti-aliased edge so it is not jagged at 16pt.
 */
export function redDotBitmap(size = 32) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2, r = size * 0.34;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.max(0, Math.min(1, r + 0.5 - d));
      const i = (y * size + x) * 4;
      buf[i] = 40; buf[i + 1] = 40; buf[i + 2] = 235; buf[i + 3] = Math.round(a * 255); // B G R A
    }
  }
  return buf;
}
