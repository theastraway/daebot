// A small PNG decoder for likeness rasters: 8-bit, non-interlaced, greyscale / RGB / RGBA / grey+alpha (what a browser screenshot
// is). node:zlib only, no image library (SPEC §2). Anything else throws, and the caller reports "likeness: not measured".
import { inflateSync } from "node:zlib";
import type { Raster } from "./score.ts";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
const MAX_PIXELS = 4096 * 8192;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf: Uint8Array): Raster {
  if (buf.length < 33 || SIG.some((b, i) => buf[i] !== b)) throw new Error("png: not a PNG");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let width = 0, height = 0, ch = 0;
  const idat: Uint8Array[] = [];
  for (let off = 8; off + 8 <= buf.length;) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4]!, buf[off + 5]!, buf[off + 6]!, buf[off + 7]!);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(off + 8); height = dv.getUint32(off + 12);
      const depth = body[8]!, color = body[9]!, interlace = body[12]!;
      if (depth !== 8 || interlace !== 0 || !CHANNELS[color]) throw new Error("png: only 8-bit non-interlaced grey, RGB or RGBA");
      if (!width || !height || width * height > MAX_PIXELS) throw new Error("png: size out of range");
      ch = CHANNELS[color]!;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ch || !idat.length) throw new Error("png: no image data");
  const stride = width * ch;
  // Never inflate past what the header promises (a compression bomb in IDAT cannot blow up memory).
  const raw = inflateSync(Buffer.concat(idat.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength))), { maxOutputLength: (stride + 1) * height });
  if (raw.length < (stride + 1) * height) throw new Error("png: truncated");
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!, src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= ch ? px[dst + x - ch]! : 0, b = y > 0 ? px[dst - stride + x]! : 0, c = x >= ch && y > 0 ? px[dst - stride + x - ch]! : 0;
      px[dst + x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : f === 4 ? v + paeth(a, b, c) : NaN) & 0xff;
      if (f > 4) throw new Error("png: bad filter");
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += ch) {
    const o = i * 4;
    if (ch === 1 || ch === 2) { data[o] = data[o + 1] = data[o + 2] = px[j]!; data[o + 3] = ch === 2 ? px[j + 1]! : 255; }
    else { data[o] = px[j]!; data[o + 1] = px[j + 1]!; data[o + 2] = px[j + 2]!; data[o + 3] = ch === 4 ? px[j + 3]! : 255; }
  }
  return { width, height, data };
}

/** The top-left `w` x `h` of a raster (both pictures must be the same size before SSIM). */
export function cropRaster(r: Raster, w: number, h: number): Raster {
  const W = Math.min(w, r.width), H = Math.min(h, r.height);
  if (W === r.width && H === r.height) return r;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) data.set(r.data.subarray(y * r.width * 4, y * r.width * 4 + W * 4), y * W * 4);
  return { width: W, height: H, data };
}
