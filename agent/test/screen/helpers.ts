import { SIG_LEN, SIG_W } from "../../src/screen/feed.ts";

/** A flat signature of one luma value, with optional single-cell overrides. */
export const sig = (fill = 100, cells: Record<number, number> = {}): Uint8Array => { const s = new Uint8Array(SIG_LEN).fill(fill); for (const [i, v] of Object.entries(cells)) s[Number(i)] = v; return s; };
/** A block of w x h cells at (x, y) set to v. */
export const block = (base: Uint8Array, x: number, y: number, w: number, h: number, v: number): Uint8Array => { const s = base.slice(); for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) s[j * SIG_W + i] = v; return s; };
