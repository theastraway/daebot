// First-run sign-in for the desktop app: one pasted MIND API key, kept in a 0600 file under ~/.mindclaw and handed to the
// gateway child through its environment (never argv, never a log line, never a URL). Pure helpers + small fs wrappers.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { desktopHome } from "./config.mjs";

export const KEY_RE = /^mind_[A-Za-z0-9_-]{8,200}$/;
export const looksLikeMindKey = (k) => typeof k === "string" && KEY_RE.test(k.trim());
export const keyPath = (env = process.env) => join(desktopHome(env), "mind-key");

/** The saved key, or undefined (missing, unreadable or malformed). Never throws. */
export function readKey(path = keyPath()) {
  try {
    const k = readFileSync(path, "utf8").trim();
    return looksLikeMindKey(k) ? k : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the key atomically with mode 0600 inside a 0700 directory. Throws on a malformed key (the message never contains it). */
export function saveKey(key, path = keyPath()) {
  if (!looksLikeMindKey(key)) throw new Error("That does not look like a MIND API key (it starts with mind_).");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${key.trim()}\n`, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* not supported on this filesystem */ }
  renameSync(tmp, path);
}

export function clearKey(path = keyPath()) {
  rmSync(path, { force: true });
}

/**
 * What the desktop should do about credentials at startup.
 *   { mode: "mind", key }       bill to the user's MIND account (default). key may be undefined when the gateway child finds one itself.
 *   { mode: "openrouter" }      developer setup: DAEBOT_BILLING is not "mind", no MIND key anywhere, an OpenRouter key exists.
 *   { mode: "needs-key" }       nothing usable: show the sign-in window.
 * `config` is the parsed ~/.mindclaw/config.json (or {}).
 */
export function resolveSignIn({ env = process.env, saved, config = {} } = {}) {
  const fromEnv = looksLikeMindKey(env.MIND_API_KEY) ? env.MIND_API_KEY.trim() : undefined;
  const fromConfig = looksLikeMindKey(config?.mindApiKey) ? config.mindApiKey.trim() : undefined;
  const key = saved ?? fromEnv ?? fromConfig;
  if (key) return { mode: "mind", key: key === fromEnv || key === fromConfig ? undefined : key };
  const hasOpenRouter = (typeof env.OPENROUTER_API_KEY === "string" && env.OPENROUTER_API_KEY.trim() !== "") || (typeof config?.openrouterKey === "string" && config.openrouterKey.trim() !== "");
  if (hasOpenRouter && String(env.DAEBOT_BILLING ?? "").toLowerCase() !== "mind") return { mode: "openrouter" };
  return { mode: "needs-key" };
}

export function readConfigJson(path, read = readFileSync) {
  try {
    const j = JSON.parse(read(path, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}
