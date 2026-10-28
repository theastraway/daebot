// Photos attached to chat messages (drag and drop, paste, the attach button).
//
// The chat model never sees a photo. The gateway validates what the browser sends, this module stores it per owner and per
// session, and the view_photo tool (src/tools/photo.ts) reads it with a dedicated vision model. Everything here is pure
// validation plus a small file store; nothing touches the network.
//
// Layout: <DATA_DIR>/photos/<owner>/<session>/index.json + p1.bin, p2.bin ... An owner is the principal that owns the session
// ("owner" or a MIND user id). A store is built per owner runtime and only ever opens its own owner directory, so one user can
// never read another user's photo, whatever session id they ask for.
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { PhotoRef } from "./types.ts";
import { fileNameFor } from "./persist.ts";

export const PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type PhotoMime = (typeof PHOTO_MIMES)[number];

export const MAX_PHOTOS_PER_MESSAGE = 5;
/** Decoded bytes per photo. The web client shrinks to 1568px JPEG first, which is a few hundred KB; this is the hard ceiling. */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
/** Decoded bytes per request (all photos of one message). */
export const MAX_REQUEST_PHOTO_BYTES = 24 * 1024 * 1024;
/** Request body ceiling on the routes that take photos: base64 of the cap above plus the JSON around it and the message text. */
export const MAX_PHOTO_BODY = 36 * 1024 * 1024;
export const MAX_SESSION_PHOTOS = 60;
/** All photos of one owner (the hosted disk is shared by every user). */
export const MAX_OWNER_BYTES = 150 * 1024 * 1024;
const MAX_SIDE = 12_000;

// ---------------------------------------------------------------- validation

export interface UploadedPhoto { name: string; mime: PhotoMime; data: Buffer; width: number; height: number }
export type PhotoCheck = { ok: true; photos: UploadedPhoto[] } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): PhotoCheck => ({ ok: false, status, error });
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A file name that is safe to show, to log and to put in a line the model reads: no brackets, no control characters, no path. */
export function cleanName(raw: unknown, fallback: string): string {
  let n = typeof raw === "string" ? raw : "";
  n = n.split(/[\\/]/).pop() ?? "";
  n = n.replace(/[^A-Za-z0-9 ._()+-]/g, "_").replace(/\s+/g, " ").trim().slice(0, 60);
  return n && n !== "." && n !== ".." ? n : fallback;
}

/** Width and height read from the image header (JPEG, PNG, GIF, WebP). undefined = not a readable image of that type. */
export function imageSize(buf: Buffer, mime: PhotoMime): { width: number; height: number } | undefined {
  try {
    if (mime === "image/png") {
      if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a || buf.toString("latin1", 12, 16) !== "IHDR") return undefined;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === "image/gif") {
      const sig = buf.toString("latin1", 0, 6);
      if (buf.length < 10 || (sig !== "GIF87a" && sig !== "GIF89a")) return undefined;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === "image/jpeg") {
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return undefined;
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xff) { i++; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) carry the frame size.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        if (len < 2) return undefined;
        i += 2 + len;
      }
      return undefined;
    }
    // WebP: RIFF....WEBP then one of VP8 (lossy), VP8L (lossless), VP8X (extended).
    if (buf.length < 30 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return undefined;
    const kind = buf.toString("latin1", 12, 16);
    if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === "VP8L") {
      if (buf[20] !== 0x2f) return undefined;
      const b = buf.readUInt32LE(21);
      return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    if (kind === "VP8 ") {
      if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined;
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validates the `photos` array of a send request: [{ name, dataUrl }]. Checks the mime prefix, that the payload is real base64,
 * that the bytes really are an image of the declared type, and the per-photo, per-request and count caps. Never throws.
 */
export function checkPhotos(raw: unknown): PhotoCheck {
  if (raw === undefined || raw === null) return { ok: true, photos: [] };
  if (!Array.isArray(raw)) return fail(400, "photos must be an array");
  if (raw.length > MAX_PHOTOS_PER_MESSAGE) return fail(400, `at most ${MAX_PHOTOS_PER_MESSAGE} photos per message`);
  const out: UploadedPhoto[] = [];
  let total = 0;
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] as { name?: unknown; dataUrl?: unknown } | null;
    const label = `photo ${i + 1}`;
    if (!p || typeof p !== "object" || typeof p.dataUrl !== "string") return fail(400, `${label}: expected { name, dataUrl }`);
    const url = p.dataUrl;
    const comma = url.indexOf(",");
    const head = comma > 0 ? url.slice(0, comma).toLowerCase() : "";
    const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64$/.exec(head);
    if (!m) return fail(400, `${label}: not a base64 data URL`);
    const mime = m[1] as PhotoMime;
    if (!(PHOTO_MIMES as readonly string[]).includes(mime)) {
      return fail(415, /^image\/hei[cf]/.test(mime) ? `${label}: HEIC photos are not supported; convert it to JPEG` : `${label}: ${mime} is not supported (use JPEG, PNG, WebP or GIF)`);
    }
    const b64 = url.slice(comma + 1);
    if (b64.length === 0 || b64.length % 4 !== 0 || !BASE64.test(b64)) return fail(400, `${label}: the image data is not valid base64`);
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const bytes = (b64.length / 4) * 3 - pad;
    if (bytes > MAX_PHOTO_BYTES) return fail(413, `${label} is ${(bytes / 1048576).toFixed(1)} MB; the limit is ${MAX_PHOTO_BYTES / 1048576} MB per photo`);
    total += bytes;
    if (total > MAX_REQUEST_PHOTO_BYTES) return fail(413, `these photos total over ${MAX_REQUEST_PHOTO_BYTES / 1048576} MB; send fewer or smaller ones`);
    const data = Buffer.from(b64, "base64");
    if (data.length !== bytes) return fail(400, `${label}: the image data is not valid base64`);
    const size = imageSize(data, mime);
    if (!size || size.width < 1 || size.height < 1) return fail(400, `${label}: this is not a valid ${mime.slice(6).toUpperCase()} image`);
    if (size.width > MAX_SIDE || size.height > MAX_SIDE) return fail(413, `${label} is ${size.width}x${size.height}; the longest side may be ${MAX_SIDE}px`);
    out.push({ name: cleanName(p.name, `photo-${i + 1}`), mime, data, width: size.width, height: size.height });
  }
  return { ok: true, photos: out };
}

/** The lines appended to the user's message so the model knows a photo exists and what to ask for. */
export function photoLines(photos: PhotoRef[] | undefined): string {
  return (photos ?? []).map((p) => `[photo ${p.id}: ${p.name}, ${p.width}x${p.height}]`).join("\n");
}

/** What the model reads for a message: the user's words, then one line per photo. */
export function messageWithPhotos(text: string, photos: PhotoRef[] | undefined): string {
  if (!photos?.length) return text;
  const lines = photoLines(photos);
  return text.trim() ? `${text}\n\n${lines}` : `(The user attached ${photos.length === 1 ? "a photo" : `${photos.length} photos`} without a message.)\n${lines}`;
}

// ---------------------------------------------------------------- store

export interface PhotoMeta extends PhotoRef { mime: PhotoMime; bytes: number; at: number }
interface Index { v: 1; next: number; photos: PhotoMeta[] }
export type AddResult = { ok: true; photos: PhotoMeta[] } | { ok: false; status: number; error: string };

const PHOTO_ID = /^p[1-9]\d{0,3}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const segment = (s: string): string => (SAFE_SEGMENT.test(s) ? s : `h-${createHash("sha256").update(s).digest("hex").slice(0, 32)}`);

export const isPhotoId = (v: unknown): v is string => typeof v === "string" && PHOTO_ID.test(v);

export class PhotoStore {
  private root: string;
  private queues = new Map<string, Promise<unknown>>();
  private used: number | undefined;

  constructor(o: { dir: string; owner: string }) {
    this.root = join(o.dir, "photos", segment(o.owner));
  }

  private sdir(sessionId: string): string { return join(this.root, fileNameFor(sessionId).replace(/\.json$/, "")); }

  private readIndex(sessionId: string): Index {
    try {
      const j = JSON.parse(readFileSync(join(this.sdir(sessionId), "index.json"), "utf8")) as Index;
      if (j && j.v === 1 && Array.isArray(j.photos) && Number.isInteger(j.next)) return j;
    } catch { /* none yet, or torn: start empty */ }
    return { v: 1, next: 1, photos: [] };
  }

  /** The photos of one session, oldest first. */
  list(sessionId: string): PhotoMeta[] { return this.readIndex(sessionId).photos.slice(); }

  get(sessionId: string, id: string): PhotoMeta | undefined {
    return isPhotoId(id) ? this.readIndex(sessionId).photos.find((p) => p.id === id) : undefined;
  }

  /** The bytes of one photo of this session, or undefined. Never reaches outside this owner's directory. */
  async read(sessionId: string, id: string): Promise<{ meta: PhotoMeta; data: Buffer } | undefined> {
    const meta = this.get(sessionId, id);
    if (!meta) return undefined;
    try { return { meta, data: await readFile(join(this.sdir(sessionId), `${id}.bin`)) }; } catch { return undefined; }
  }

  private ownerBytes(): number {
    if (this.used !== undefined) return this.used;
    let sum = 0;
    try {
      for (const d of readdirSync(this.root)) {
        try {
          const j = JSON.parse(readFileSync(join(this.root, d, "index.json"), "utf8")) as Index;
          for (const p of j.photos ?? []) sum += Number(p.bytes) || 0;
        } catch { /* a folder without an index counts as nothing */ }
      }
    } catch { /* no photos yet */ }
    return (this.used = sum);
  }

  private serial<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.queues.set(sessionId, next);
    return next.finally(() => { if (this.queues.get(sessionId) === next) this.queues.delete(sessionId); });
  }

  /** Stores photos that already passed checkPhotos. Ids are p1, p2, ... per session and never reused. */
  add(sessionId: string, photos: UploadedPhoto[]): Promise<AddResult> {
    return this.serial(sessionId, async (): Promise<AddResult> => {
      const idx = this.readIndex(sessionId);
      if (idx.photos.length + photos.length > MAX_SESSION_PHOTOS) return { ok: false, status: 413, error: `this chat already holds ${idx.photos.length} photos (limit ${MAX_SESSION_PHOTOS}); start a new chat` };
      const add = photos.reduce((n, p) => n + p.data.length, 0);
      if (this.ownerBytes() + add > MAX_OWNER_BYTES) return { ok: false, status: 413, error: `photo storage is full (${MAX_OWNER_BYTES / 1048576} MB); delete old chats to free space` };
      const dir = this.sdir(sessionId);
      const metas: PhotoMeta[] = [];
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        for (const p of photos) {
          const id = `p${idx.next++}`;
          await writeFile(join(dir, `${id}.bin`), p.data, { mode: 0o600 });
          metas.push({ id, name: p.name, width: p.width, height: p.height, mime: p.mime, bytes: p.data.length, at: Date.now() });
        }
        idx.photos.push(...metas);
        const tmp = join(dir, `index.json.${process.pid}.tmp`);
        await writeFile(tmp, JSON.stringify(idx), { mode: 0o600 });
        await rename(tmp, join(dir, "index.json"));
      } catch {
        return { ok: false, status: 500, error: "could not save the photos" };
      }
      if (this.used !== undefined) this.used += add;
      return { ok: true, photos: metas };
    });
  }

  /** Deletes every photo of a session (the chat was deleted). */
  async removeSession(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      const freed = this.readIndex(sessionId).photos.reduce((n, p) => n + (Number(p.bytes) || 0), 0);
      await rm(this.sdir(sessionId), { recursive: true, force: true }).catch(() => {});
      if (this.used !== undefined) this.used = Math.max(0, this.used - freed);
    });
  }
}
