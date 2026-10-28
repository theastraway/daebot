// Daebot's home folder: ~/.daebot (Windows: %USERPROFILE%\.daebot). It holds config.json, gateway-token, mind-key, accounts.json, desktop.json,
// desktop-state.json, channels.json, history and data/ (saved chats, bots, permissions). Every module that needs a path in there calls
// daebotHome(); nothing else spells the folder name.
//
// Before the rename the folder was ~/.mindclaw. migrateHome() moves it once, safely (see below). The desktop app has a plain-JS mirror of
// this file at desktop/src/lib/home.mjs (the packaged app does not ship the agent TypeScript); test/core/home.test.ts runs both through the
// same scenarios, so change them together.
//
// Resolution order: env DAEBOT_HOME, else env MINDCLAW_DESKTOP_HOME (the old override, still honoured), else ~/.daebot. While a pre-rename
// install has not been moved yet (~/.daebot absent, ~/.mindclaw a directory) the answer is ~/.mindclaw, so nothing ever starts "empty".
import { lstatSync, renameSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

export const HOME_DIR = ".daebot";
export const LEGACY_HOME_DIR = ".mindclaw";

export interface HomeIo {
  renameSync: (from: string, to: string) => void;
  symlinkSync: (target: string, path: string, type: "dir" | "junction") => void;
  platform: string;
}

export type MigrateAction =
  | "override"     // DAEBOT_HOME / MINDCLAW_DESKTOP_HOME is set: that folder is used as it is, nothing is moved
  | "current"      // ~/.daebot already exists: used as it is; ~/.mindclaw (if any) is never touched
  | "fresh"        // neither exists: a new install, ~/.daebot will be created on first write
  | "migrated"     // ~/.mindclaw was renamed to ~/.daebot
  | "legacy-link"  // ~/.mindclaw is a symlink to a folder (the user's own arrangement): left alone and used
  | "kept-legacy"; // the rename failed (cross-device, permission, locked on Windows): ~/.mindclaw is used for this run

export interface MigrateResult {
  home: string;
  action: MigrateAction;
  /** migrated only: whether the ~/.mindclaw -> ~/.daebot link was created (a failure to link is ignored). */
  linked?: boolean;
  /** kept-legacy only: the error code of the failed rename. */
  error?: string;
}

const realIo: HomeIo = {
  renameSync: (a, b) => renameSync(a, b),
  symlinkSync: (t, p, ty) => symlinkSync(t, p, ty),
  platform: process.platform,
};

type Kind = "none" | "dir" | "symlink" | "other";

/** What is at `p`, without following a final symlink. */
function kindOf(p: string): Kind {
  try {
    const s = lstatSync(p);
    return s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : "other";
  } catch {
    return "none";
  }
}

function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** The explicit override, if one is set (DAEBOT_HOME wins over the old MINDCLAW_DESKTOP_HOME). */
export function homeOverride(env: Env = process.env): string | undefined {
  const a = (env.DAEBOT_HOME ?? "").trim();
  if (a) return a;
  const b = (env.MINDCLAW_DESKTOP_HOME ?? "").trim();
  return b || undefined;
}

function paths(env: Env): { fresh: string; legacy: string } {
  const base = env.HOME || homedir();
  return { fresh: join(base, HOME_DIR), legacy: join(base, LEGACY_HOME_DIR) };
}

/** The folder Daebot keeps its files in. Pure lookup: it never creates, moves or writes anything. */
export function daebotHome(env: Env = process.env): string {
  const o = homeOverride(env);
  if (o) return o;
  const { fresh, legacy } = paths(env);
  if (kindOf(fresh) !== "none") return fresh;
  if (isDirectory(legacy)) return legacy; // not moved yet (or the move failed): keep reading what is there
  return fresh;
}

/**
 * One-time move of a pre-rename install. Idempotent and never destructive:
 *  - an explicit override (DAEBOT_HOME / MINDCLAW_DESKTOP_HOME) or an existing ~/.daebot: nothing is touched (both exist: ~/.daebot wins);
 *  - ~/.mindclaw a real directory and ~/.daebot absent: renameSync(~/.mindclaw, ~/.daebot) (same mode and files, so 0700 / 0600 stay), then a
 *    symlink (a junction on Windows) ~/.mindclaw -> ~/.daebot so an older Daebot still running finds its files; a link failure is ignored;
 *  - the rename fails: one line on stderr and ~/.mindclaw stays in use for this run. The run is pinned with env.DAEBOT_HOME so the gateway
 *    child (which inherits the environment) uses the same folder instead of racing to move it.
 * Never call it for a hosted deployment: those set DATA_DIR and their paths explicitly and have no home folder to move.
 */
export function migrateHome(env: Env = process.env, log: (line: string) => void = (l) => process.stderr.write(`${l}\n`), io: HomeIo = realIo): MigrateResult {
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
    const code = String((e as { code?: unknown })?.code ?? (e as Error)?.message ?? e).slice(0, 40);
    log(`daebot: could not move ${legacy} to ${fresh} (${code}); using ${legacy} for this run`);
    env.DAEBOT_HOME = legacy;
    return { home: legacy, action: "kept-legacy", error: code };
  }
  let linked = false;
  try { io.symlinkSync(fresh, legacy, io.platform === "win32" ? "junction" : "dir"); linked = true; } catch { /* the link is a courtesy for older installs */ }
  log(`daebot: moved ${legacy} to ${fresh}${linked ? ` (${legacy} now points at it)` : ""}`);
  return { home: fresh, action: "migrated", linked };
}
