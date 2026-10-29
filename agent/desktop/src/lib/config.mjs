// Desktop config (~/.daebot/desktop.json) and window-state persistence. Pure helpers + small fs wrappers.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { daebotHome } from "./home.mjs";

// keepWorking: keep the gateway running and the machine awake while the window is closed/hidden (see keepworking.mjs).
// idleTrimSeconds: after the window has been hidden this long, its renderer is destroyed to cut idle RAM (0 = never).
export const DEFAULT_CONFIG = Object.freeze({ shortcut: "CommandOrControl+Shift+Space", kernelMode: "enforced", idleTrimSeconds: 300, keepWorking: true });
export const KERNEL_MODE_NAMES = Object.freeze(["enforced", "shadow", "off"]);

/** Daebot's home folder (~/.daebot). DAEBOT_HOME or the older MINDCLAW_DESKTOP_HOME override it; see home.mjs. */
export function desktopHome(env = process.env) {
  return daebotHome(env);
}
export const configPath = (env = process.env) => join(desktopHome(env), "desktop.json");
export const statePath = (env = process.env) => join(desktopHome(env), "desktop-state.json");

const MODIFIERS = new Set(["command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl", "alt", "option", "altgr", "shift", "super", "meta"]);
const KEY = /^([A-Za-z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Return|Escape|Esc|Up|Down|Left|Right|Home|End|PageUp|PageDown|Backspace|Delete|Plus|[-=;,./`'\[\]\\])$/;

/** An Electron accelerator we are willing to register: 0-3 modifiers + exactly one key. A bare letter is rejected (it would eat typing). */
export function isValidAccelerator(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > 40) return false;
  const parts = s.split("+");
  // "Alt++" style (Plus key written literally) is not supported; use "Plus".
  if (parts.some((p) => p === "")) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mods.length === 0 || mods.length > 3) return false;
  if (!mods.every((m) => MODIFIERS.has(m.toLowerCase()))) return false;
  if (new Set(mods.map((m) => m.toLowerCase())).size !== mods.length) return false;
  return KEY.test(key);
}

/** Merge a parsed JSON object over defaults, dropping anything invalid. Never throws. */
export function normalizeConfig(raw) {
  const out = { ...DEFAULT_CONFIG };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (isValidAccelerator(raw.shortcut)) out.shortcut = raw.shortcut;
    if (typeof raw.kernelMode === "string" && KERNEL_MODE_NAMES.includes(raw.kernelMode.toLowerCase())) out.kernelMode = raw.kernelMode.toLowerCase();
    if (Number.isInteger(raw.idleTrimSeconds) && raw.idleTrimSeconds >= 0 && raw.idleTrimSeconds <= 86400) out.idleTrimSeconds = raw.idleTrimSeconds;
    if (typeof raw.keepWorking === "boolean") out.keepWorking = raw.keepWorking;
    if (raw.shortcut === null || raw.shortcut === "") out.shortcut = null; // explicit opt-out
  }
  return out;
}

export function loadConfig(path = configPath(), read = readFileSync) {
  try {
    return normalizeConfig(JSON.parse(read(path, "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Atomic write (tmp + rename) of a JSON-able value, mode 0600. */
export function writeJson(path, value, io = { mkdirSync, writeFileSync, renameSync }) {
  io.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  io.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  io.renameSync(tmp, path);
}

/** Persist just the kernel mode, preserving other user keys in desktop.json. */
export function saveKernelMode(mode, path = configPath(), io) {
  let existing = {};
  try {
    const p = JSON.parse(readFileSync(path, "utf8"));
    if (p && typeof p === "object" && !Array.isArray(p)) existing = p;
  } catch { /* new file */ }
  writeJson(path, { ...existing, kernelMode: mode }, io);
}

/** Persist just the summon shortcut (an accelerator, or null to turn it off), preserving other user keys in desktop.json. */
export function saveShortcut(accelerator, path = configPath(), io) {
  let existing = {};
  try {
    const p = JSON.parse(readFileSync(path, "utf8"));
    if (p && typeof p === "object" && !Array.isArray(p)) existing = p;
  } catch { /* new file */ }
  writeJson(path, { ...existing, shortcut: accelerator }, io);
}

/** Persist just keepWorking, preserving other user keys in desktop.json. */
export function saveKeepWorking(on, path = configPath(), io) {
  let existing = {};
  try {
    const p = JSON.parse(readFileSync(path, "utf8"));
    if (p && typeof p === "object" && !Array.isArray(p)) existing = p;
  } catch { /* new file */ }
  writeJson(path, { ...existing, keepWorking: !!on }, io);
}

// ---- window bounds ----
export const DEFAULT_BOUNDS = Object.freeze({ width: 1100, height: 760 });

/**
 * Validate saved bounds against the current displays (workAreas: [{x,y,width,height}]).
 * Returns bounds to use. If the saved rectangle does not overlap any display enough, drops x/y (centers).
 */
export function resolveBounds(saved, workAreas) {
  if (!saved || typeof saved !== "object") return { ...DEFAULT_BOUNDS };
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  const width = num(saved.width) ? Math.min(Math.max(Math.round(saved.width), 480), 8000) : DEFAULT_BOUNDS.width;
  const height = num(saved.height) ? Math.min(Math.max(Math.round(saved.height), 360), 6000) : DEFAULT_BOUNDS.height;
  const out = { width, height };
  if (num(saved.x) && num(saved.y)) {
    const r = { x: Math.round(saved.x), y: Math.round(saved.y), width, height };
    const visible = workAreas.some((a) => {
      const ox = Math.min(r.x + r.width, a.x + a.width) - Math.max(r.x, a.x);
      const oy = Math.min(r.y + r.height, a.y + a.height) - Math.max(r.y, a.y);
      return ox >= 120 && oy >= 80; // enough of the title bar region is reachable
    });
    if (visible) { out.x = r.x; out.y = r.y; }
  }
  if (saved.maximized === true) out.maximized = true;
  return out;
}

export function loadState(path = statePath(), read = readFileSync) {
  try {
    const v = JSON.parse(read(path, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
