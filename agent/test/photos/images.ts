// Tiny hand-built image headers for tests: just enough bytes for the size reader and the magic-byte check. Never decoded.
import type { PhotoMime } from "../../src/photos.ts";

export function png(w: number, h: number, pad = 0): Buffer {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

export function jpeg(w: number, h: number, pad = 0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(pad), Buffer.from([0xff, 0xd9])]);
}

export function gif(w: number, h: number): Buffer {
  const b = Buffer.alloc(16);
  b.write("GIF89a", 0, "latin1"); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
  return b;
}

export function webpX(w: number, h: number): Buffer {
  const b = Buffer.alloc(34);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(26, 4); b.write("WEBPVP8X", 8, "latin1"); b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}

export function webpL(w: number, h: number): Buffer {
  const b = Buffer.alloc(34);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(26, 4); b.write("WEBPVP8L", 8, "latin1"); b[20] = 0x2f;
  b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  return b;
}

export function webpLossy(w: number, h: number): Buffer {
  const b = Buffer.alloc(34);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(26, 4); b.write("WEBPVP8 ", 8, "latin1");
  b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28);
  return b;
}

export const dataUrl = (mime: string, buf: Buffer): string => `data:${mime};base64,${buf.toString("base64")}`;
export const jpegUrl = (w = 1024, h = 700, pad = 0): string => dataUrl("image/jpeg", jpeg(w, h, pad));
export const sample = (name = "estimate.jpg", w = 1024, h = 700): { name: string; dataUrl: string } => ({ name, dataUrl: jpegUrl(w, h) });
export const MIMES: PhotoMime[] = ["image/jpeg", "image/png", "image/webp", "image/gif"];
