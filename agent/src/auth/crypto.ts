// AES-256-GCM sealing for secrets at rest (user MIND keys / OAuth tokens). Key comes from DAEBOT_SECRET_KEY.
// Format: "v1." + base64url(iv[12] | tag[16] | ciphertext). The record id is bound in as AAD, so a sealed
// blob cannot be moved from one user's record to another's, and any bit flip fails authentication.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const MIN_SECRET_KEY_LEN = 32;
export class SealError extends Error {}

/** Derives the 32-byte data key from the operator-provided secret. Accepts any string of 32+ characters. */
export function deriveDataKey(secret: string): Buffer {
  if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_KEY_LEN) {
    throw new SealError(`DAEBOT_SECRET_KEY must be at least ${MIN_SECRET_KEY_LEN} characters`);
  }
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret.trim(), "utf8"), Buffer.from("daebot-salt-v1"), Buffer.from("daebot-users-aes256gcm"), 32));
}

export function seal(key: Buffer, plaintext: unknown, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(JSON.stringify(plaintext), "utf8"), c.final()]);
  return "v1." + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

export function open<T = unknown>(key: Buffer, sealed: string, aad: string): T {
  if (typeof sealed !== "string" || !sealed.startsWith("v1.")) throw new SealError("unrecognized sealed value");
  const raw = Buffer.from(sealed.slice(3), "base64url");
  if (raw.length < 12 + 16 + 1) throw new SealError("sealed value truncated");
  try {
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(raw.subarray(12, 28));
    const pt = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
    return JSON.parse(pt.toString("utf8")) as T;
  } catch {
    throw new SealError("sealed value failed authentication (wrong key or tampered)");
  }
}
