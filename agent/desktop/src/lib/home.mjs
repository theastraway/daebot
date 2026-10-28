// Daebot's home folder for the desktop app: ~/.daebot (Windows: %USERPROFILE%\.daebot). Plain-JS mirror of agent/src/home.ts: the packaged app
// does not ship the agent TypeScript, and the gateway child (the bundled binary) uses the TypeScript original. agent/test/core/home.test.ts
// runs both through the same scenarios, so change them together. See agent/src/home.ts for the full contract.
import { lstatSync, renameSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME_DIR = ".daebot";
export const LEGACY_HOME_DIR = ".mindclaw";

const realIo = {
  renameSync: (a, b) => renameSync(a, b),
  symlinkSync: (t, p, ty) => symlinkSync(t, p, ty),
  platform: process.platform,
};

/** What is at `p`, without following a final symlink: "none" | "dir" | "symlink" | "other". */
function kindOf(p) {
  try {
    const s = lstatSync(p);
    return s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : "other";
  } catch {
    return "none";
  }
}

function isDirectory(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** The explicit override, if one is set (DAEBOT_HOME wins over the old MINDCLAW_DESKTOP_HOME). */
export function homeOverride(env = process.env) {
  const a = (env.DAEBOT_HOME ?? "").trim();
  if (a) return a;
  const b = (env.MINDCLAW_DESKTOP_HOME ?? "").trim();
  return b || undefined;
}

function paths(env) {
  const base = env.HOME || homedir();
  return { fresh: join(base, HOME_DIR), legacy: join(base, LEGACY_HOME_DIR) };
}

/** The folder Daebot keeps its files in. Pure lookup: it never creates, moves or writes anything. */
export function daebotHome(env = process.env) {
  const o = homeOverride(env);
  if (o) return o;
  const { fresh, legacy } = paths(env);
  if (kindOf(fresh) !== "none") return fresh;
  if (isDirectory(legacy)) return legacy; // not moved yet (or the move failed): keep reading what is there
  return fresh;
}

/**
 * One-time move of a pre-rename install; idempotent, never destructive. Returns { home, action, linked?, error? } where action is
 * override | current | fresh | migrated | legacy-link | kept-legacy (see agent/src/home.ts). When the rename fails it logs one line and
 * pins env.DAEBOT_HOME to ~/.mindclaw so the gateway child (which inherits the environment) uses the same folder for this run.
 */
export function migrateHome(env = process.env, log = (l) => process.stderr.write(`${l}\n`), io = realIo) {
  const o = homeOverride(env);
  if (o) return { home: o, action: "override" };
  const { fresh, legacy } = paths(env);
  if (kindOf(fresh) !== "none") return { home: fresh, action: "current" };
  const k = kindOf(legacy);
  if (k === "none" || k === "other") return { home: fresh, action: "fresh" };
  if (k === "symlink") return isDirectory(legacy) ? { home: legacy, action: "legacy-link" } : { home: fresh, action: "fresh" };
  try {
    io.renameSync(legacy, fresh);
  } catch (e) {
    if (kindOf(fresh) !== "none") return { home: fresh, action: "current" }; // another Daebot process moved it first
    const code = String(e?.code ?? e?.message ?? e).slice(0, 40);
    log(`daebot: could not move ${legacy} to ${fresh} (${code}); using ${legacy} for this run`);
    env.DAEBOT_HOME = legacy;
    return { home: legacy, action: "kept-legacy", error: code };
  }
  let linked = false;
  try { io.symlinkSync(fresh, legacy, io.platform === "win32" ? "junction" : "dir"); linked = true; } catch { /* the link is a courtesy for older installs */ }
  log(`daebot: moved ${legacy} to ${fresh}${linked ? ` (${legacy} now points at it)` : ""}`);
  return { home: fresh, action: "migrated", linked };
}
