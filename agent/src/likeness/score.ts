// Likeness: how alike a build looks to its original, per width. Pure functions over decoded rasters and
// capture records, so they run anywhere (desktop, a canvas, a test). Decoding a PNG into RGBA is the
// caller's job; nothing here imports an image library (SPEC §2: dependencies stay near zero).
//
// Scores are percentages, 0 to 100. They are a proxy for "looks alike", not a judgement of quality, and
// they start in shadow mode (see `likenessMode`): they are reported, never used to block anything.
//
// Method, in the same shape as Craft Anything's website check (concepts only, re-implemented here):
//   layout    mean colour of a coarse grid of tiles, compared tile by tile
//   detail    SSIM on luminance over 8x8 windows
//   per width (layout + detail) / 2
//   text      word-count overlap of the visible text, 200 * shared / (total a + total b)
//   structure LCS of the page skeleton (landmarks, headings, lists, media, forms), 200 * common / (len a + len b)

/** Decoded picture: RGBA bytes, row-major, 4 bytes per pixel. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface WidthScore {
  width: number;
  similarity: number;
  layout: number;
  detail: number;
}

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}

function luminance(data: Uint8Array | Uint8ClampedArray, i: number): number {
  return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
}

/** Mean colour of each cell of a `cols` x `rows` grid. Cells are read from the same pixels in both pictures. */
export function tileColours(r: Raster, cols: number, rows: number): number[][] {
  const out: number[][] = [];
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x0 = Math.floor((tx * r.width) / cols), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * r.width) / cols));
      const y0 = Math.floor((ty * r.height) / rows), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * r.height) / rows));
      let R = 0, G = 0, B = 0, n = 0;
      for (let y = y0; y < y1 && y < r.height; y++) {
        for (let x = x0; x < x1 && x < r.width; x++) {
          const i = (y * r.width + x) * 4;
          R += r.data[i]!; G += r.data[i + 1]!; B += r.data[i + 2]!; n++;
        }
      }
      out.push(n ? [R / n, G / n, B / n] : [0, 0, 0]);
    }
  }
  return out;
}

/** Layout similarity: 100 minus the mean per-channel difference of matching tiles, as a share of 255. */
export function layoutSimilarity(a: Raster, b: Raster, cols = 12, rows = 8): number {
  const ta = tileColours(a, cols, rows), tb = tileColours(b, cols, rows);
  let diff = 0;
  for (let i = 0; i < ta.length; i++) {
    for (let c = 0; c < 3; c++) diff += Math.abs(ta[i]![c]! - tb[i]![c]!);
  }
  return clampPct(100 - (100 * diff) / (ta.length * 3 * 255));
}

/** SSIM on luminance over non-overlapping 8x8 windows, as a percentage. Pictures must be the same size. */
export function detailSimilarity(a: Raster, b: Raster, win = 8): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error("detailSimilarity: pictures differ in size");
  const { width: w, height: h } = a;
  let total = 0, n = 0;
  for (let y0 = 0; y0 + win <= h; y0 += win) {
    for (let x0 = 0; x0 + win <= w; x0 += win) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let y = y0; y < y0 + win; y++) {
        for (let x = x0; x < x0 + win; x++) {
          const i = (y * w + x) * 4;
          const la = luminance(a.data, i), lb = luminance(b.data, i);
          sa += la; sb += lb; saa += la * la; sbb += lb * lb; sab += la * lb;
        }
      }
      const N = win * win;
      const ma = sa / N, mb = sb / N;
      const va = saa / N - ma * ma, vb = sbb / N - mb * mb, cov = sab / N - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  }
  if (n === 0) return layoutSimilarity(a, b);
  return clampPct(100 * (total / n));
}

/** One width's score: the mean of layout and detail. */
export function widthScore(a: Raster, b: Raster): Omit<WidthScore, "width"> {
  const layout = layoutSimilarity(a, b);
  const detail = detailSimilarity(a, b);
  return { similarity: (layout + detail) / 2, layout, detail };
}

/** Visible-text overlap: word counts, shared minimum over the sum of both totals. */
export function textSimilarity(a: string, b: string): number {
  const count = (s: string) => {
    const m = new Map<string, number>();
    for (const w of s.toLowerCase().split(/[^\p{L}\p{N}']+/u)) if (w) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  };
  const ca = count(a), cb = count(b);
  let shared = 0, ta = 0, tb = 0;
  for (const v of ca.values()) ta += v;
  for (const v of cb.values()) tb += v;
  for (const [w, n] of ca) shared += Math.min(n, cb.get(w) ?? 0);
  if (ta + tb === 0) return 100;
  return clampPct((200 * shared) / (ta + tb));
}

/** Longest common subsequence length. */
export function commonLength<T>(a: readonly T[], b: readonly T[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Page structure similarity from skeleton tokens (e.g. "h2", "nav", "list:3"). */
export function structureSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length + b.length === 0) return 100;
  return clampPct((200 * commonLength(a, b)) / (a.length + b.length));
}

/** Mode for the likeness check. Off unless asked; shadow reports without blocking anything. */
export type LikenessMode = "off" | "shadow" | "on";

export function likenessMode(env: Record<string, string | undefined> = process.env): LikenessMode {
  const v = (env.DAEBOT_LIKENESS ?? "off").trim().toLowerCase();
  return v === "shadow" || v === "on" ? v : "off";
}

/** Round-level summary across widths, with the worst width named so the builder knows where to look first. */
export interface LikenessReport {
  similarity: number;
  widths: WidthScore[];
  worst?: WidthScore;
}

export function reportAcross(scores: WidthScore[]): LikenessReport {
  if (scores.length === 0) return { similarity: 0, widths: [] };
  const similarity = scores.reduce((s, w) => s + w.similarity, 0) / scores.length;
  const worst = scores.reduce((a, b) => (b.similarity < a.similarity ? b : a));
  return { similarity: clampPct(similarity), widths: scores, worst };
}
