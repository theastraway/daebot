/**
 * MINDClaw user-local state — a single JSON file in ~/.mindclaw/state.json.
 *
 * Stores everything the wrapper needs between runs: API key, base URL, tier,
 * whether onboarding ran, whether templates were seeded.  The MIND API key
 * itself is also written to the OpenClaw plugin config so the runtime picks
 * it up via the standard provider-auth mechanism.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const STATE_DIR = join(homedir(), ".mindclaw");
const STATE_FILE = join(STATE_DIR, "state.json");

const DEFAULT_STATE = {
  schema: 1,
  apiKey: null,
  baseUrl: "https://www.m-i-n-d.ai",
  tier: null,
  username: null,
  email: null,
  onboardedAt: null,
  templatesSeededAt: null,
};

export function loadState() {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(patch) {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  }
  const current = loadState();
  const next = { ...current, ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
