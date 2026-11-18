// Full tool outputs that no longer fit in the model context. The bytes are the redacted text, named by
// sha256, so the same output is stored once. Tests pass a temp directory; the runtime passes dataDir().
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../learn/guard.ts";

export interface BlobStore {
  /** Redacts, then stores. `chars` is the redacted length. A second put of the same text does not write again. */
  put(text: string): { id: string; chars: number };
  /** Undefined for a non-hash id (no path traversal) or a missing blob. */
  get(id: string): string | undefined;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function refMarker(id: string, chars: number): string {
  return `[ref:${id} · ${chars} chars · session_recall expand ref=${id}]`;
}

/** Short view plus the ref line. Already-short text (including text a redaction shrank) is returned with no marker. */
export function externalize(text: string, max: number, blobs: BlobStore, label: string): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= max) return redacted;
  try {
    const put = blobs.put(redacted);
    return `${redacted.slice(0, max)}\n${label}\n${refMarker(put.id, put.chars)}`;
  } catch {
    return `${redacted.slice(0, max)}\n${label}`;
  }
}

export function createMemoryBlobStore(): BlobStore {
  const map = new Map<string, string>();
  return {
    put(text) {
      const redacted = redactSecrets(text);
      const id = createHash("sha256").update(redacted).digest("hex");
      if (!map.has(id)) map.set(id, redacted);
      return { id, chars: redacted.length };
    },
    get(id) {
      if (!HEX64.test(id)) return undefined;
      return map.get(id);
    },
  };
}

let memorySingleton: BlobStore | undefined;
/** Used when a caller (the clip unit test, a session built without a store) must not touch DATA_DIR. */
export function memoryBlobs(): BlobStore {
  return (memorySingleton ??= createMemoryBlobStore());
}

export function createBlobStore(dir: string): BlobStore {
  const root = join(dir, "blobs");
  return {
    put(text) {
      const redacted = redactSecrets(text);
      const id = createHash("sha256").update(redacted).digest("hex");
      const file = join(root, id);
      if (!existsSync(file)) {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        writeFileSync(file, redacted, { mode: 0o600 });
      }
      return { id, chars: redacted.length };
    },
    get(id) {
      if (!HEX64.test(id)) return undefined;
      try { return readFileSync(join(root, id), "utf8"); } catch { return undefined; }
    },
  };
}

const disk = new Map<string, BlobStore>();
/** One store per data directory. The directory is created on the first put, not at construction. */
export function blobStoreFor(dir: string): BlobStore {
  let s = disk.get(dir);
  if (!s) { s = createBlobStore(dir); disk.set(dir, s); }
  return s;
}
