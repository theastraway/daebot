// Desktop/CLI only: the per-install secret that seals connected-server credentials when DAEBOT_SECRET_KEY is not set.
// Created once (48 random bytes, base64url) with mode 0600 inside a 0700 folder, then reused, so saved connections survive restarts.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function localSecret(dir: string): string {
  const file = join(dir, "local-secret");
  try {
    const s = readFileSync(file, "utf8").trim();
    if (s.length >= 40) return s;
  } catch { /* first run */ }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = randomBytes(48).toString("base64url");
  writeFileSync(file, `${s}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* not supported here */ }
  return s;
}
