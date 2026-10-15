// Generates tiny PNG assets with no dependencies: a macOS menu-bar template image (black glyph on transparent)
// and a 1024px app icon. Run once; outputs are committed to build-resources/ and src/assets/.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const aa = (d, edge) => Math.max(0, Math.min(1, edge - d + 0.5)); // 1px anti-alias ramp

// Menu bar glyph: ring with a centered dot (reads as an "eye"/node), black + alpha (template image).
const tray = (x, y, s) => {
  const c = (s - 1) / 2, d = Math.hypot(x - c, y - c), R = s * 0.40, w = s * 0.11, dot = s * 0.15;
  const ring = aa(Math.abs(d - R), w / 2 + 0.5) , center = aa(d, dot);
  return [0, 0, 0, Math.round(255 * Math.max(ring, center))];
};
// App icon: dark rounded square with a light ring + dot.
const app = (x, y, s) => {
  const c = (s - 1) / 2, r = s * 0.22, half = s * 0.46;
  const dx = Math.max(Math.abs(x - c) - (half - r), 0), dy = Math.max(Math.abs(y - c) - (half - r), 0);
  const box = aa(Math.hypot(dx, dy), r);
  const d = Math.hypot(x - c, y - c), R = s * 0.26, w = s * 0.07, dot = s * 0.09;
  const g = Math.max(aa(Math.abs(d - R), w / 2), aa(d, dot));
  const t = y / s;
  const bg = [Math.round(24 + 18 * t), Math.round(26 + 22 * t), Math.round(44 + 40 * t)];
  const px = bg.map((v) => Math.round(v * (1 - g) + 236 * g));
  return [...px, Math.round(255 * box)];
};

const out = (rel, buf) => { const p = join(here, "..", rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, buf); console.log("wrote", rel, buf.length); };
out("src/assets/trayTemplate.png", png(18, tray));
out("src/assets/trayTemplate@2x.png", png(36, tray));
out("build-resources/icon.png", png(1024, app));
