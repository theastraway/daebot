// Screen control on macOS for the `computer` tool. No native module and no helper binary: everything is a short call to a tool macOS
// already ships.
//   screenshot  screencapture (PNG, primary display) -> sips (resize to at most SHOT_MAX_WIDTH, JPEG)
//   mouse       osascript -l JavaScript with the CoreGraphics bridge (CGEventCreateMouseEvent / ScrollWheel), posted at the HID tap
//   keyboard    osascript + System Events (keystroke for text, key code for named keys and combos)
//   state       one JXA call: screen size in points, the mouse position, and whether Screen Recording / Accessibility are granted
// Coordinates the model sends are pixels of the SCREENSHOT; they are scaled to the screen's points here, so the model never needs the
// display scale (Retina). Typed text and key names reach osascript as argv items, never spliced into script text.
// The terminal ban of the Windows path holds here too: nothing is clicked, typed or keyed while a terminal is the frontmost app.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockedMessage } from "./ps.ts";

export const MAC_SHOT_MAX_WIDTH = 1366;
const EXEC_TIMEOUT_MS = 30_000;
const MAX_TEXT = 2000;
const MAX_WAIT_S = 10;

export type MacExec = (cmd: string, args: string[], o?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** The production executor: spawn, no shell. */
export const runMacExec: MacExec = (cmd, args, o = {}) => new Promise((resolve) => {
  let stdout = "", stderr = "";
  let child;
  try { child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return resolve({ code: null, stdout, stderr: (e as Error).message }); }
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
  child.stderr.on("data", (d: Buffer) => { if (stderr.length < 8000) stderr += d.toString("utf8"); });
  const kill = () => { try { child.kill(); } catch { /* gone */ } };
  const timer = setTimeout(kill, o.timeoutMs ?? EXEC_TIMEOUT_MS);
  o.signal?.addEventListener("abort", kill, { once: true });
  child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: e.message }); });
  child.on("close", (code) => { clearTimeout(timer); o.signal?.removeEventListener("abort", kill); resolve({ code, stdout, stderr }); });
});

// ---------------------------------------------------------------- terminals

/** Lower-case app names whose windows are terminals: nothing is clicked, typed or keyed into them. */
export const MAC_TERMINAL_APPS = ["terminal", "iterm", "iterm2", "warp", "ghostty", "kitty", "alacritty", "wezterm", "wezterm-gui", "hyper", "tabby", "rio", "termius"];
export const isMacTerminalApp = (name: string): boolean => MAC_TERMINAL_APPS.includes(name.trim().toLowerCase());

// ---------------------------------------------------------------- keys

const KEY_CODES: Record<string, number> = {
  enter: 36, return: 36, tab: 48, esc: 53, escape: 53, backspace: 51, delete: 117, space: 49,
  up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
const MAC_MODS: Record<string, string> = {
  ctrl: "control down", control: "control down", alt: "option down", option: "option down", opt: "option down", shift: "shift down",
  cmd: "command down", command: "command down", meta: "command down", super: "command down", win: "command down", windows: "command down",
};

export type MacKey = { code: number; mods: string[] } | { char: string; mods: string[] } | { error: string };

/** "cmd+shift+s" -> { char: "s", mods: ["command down", "shift down"] }; "enter" -> { code: 36 }. */
export function toMacKey(combo: string): MacKey {
  const parts = combo.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { error: "key: empty key" };
  const last = parts[parts.length - 1];
  const mods: string[] = [];
  for (const m of parts.slice(0, -1)) {
    if (!MAC_MODS[m]) return { error: `key: unknown modifier "${m}" (use cmd, ctrl, alt, shift)` };
    if (!mods.includes(MAC_MODS[m])) mods.push(MAC_MODS[m]);
  }
  if (KEY_CODES[last] !== undefined) return { code: KEY_CODES[last], mods };
  if (last.length === 1) return { char: last, mods };
  return { error: `key: unknown key "${last}"` };
}

/** osascript argv for one key or combo. */
export function keyArgs(k: { code: number; mods: string[] } | { char: string; mods: string[] }): string[] {
  const using = k.mods.length ? ` using {${k.mods.join(", ")}}` : "";
  if ("code" in k) return ["-e", `tell application "System Events" to key code ${k.code}${using}`];
  return ["-e", "on run argv", "-e", `tell application "System Events" to keystroke (item 1 of argv)${using}`, "-e", "end run", "--", k.char];
}

/** osascript argv that types text (newlines become Return). The text is an argv item, so quotes and backslashes cannot break out. */
export function typeArgs(text: string): string[] {
  return [
    "-e", "on run argv",
    "-e", "tell application \"System Events\"",
    "-e", "set n to count of argv",
    "-e", "repeat with i from 1 to n",
    "-e", "if item i of argv is not \"\" then keystroke (item i of argv)",
    "-e", "if i < n then key code 36",
    "-e", "end repeat",
    "-e", "end tell",
    "-e", "end run",
    "--", ...text.replace(/\r\n/g, "\n").split("\n"),
  ];
}

// ---------------------------------------------------------------- mouse (JXA)

const JXA_HEAD = "ObjC.import('CoreGraphics');ObjC.import('Foundation');" +
  "function ev(t,x,y,b,c){var e=$.CGEventCreateMouseEvent(null,t,$.CGPointMake(x,y),b);if(c>1)$.CGEventSetIntegerValueField(e,1,c);$.CGEventPost(0,e);}" +
  "function nap(s){$.NSThread.sleepForTimeInterval(s);}";

export type MouseOp =
  | { op: "move"; x: number; y: number }
  | { op: "click"; x: number; y: number; right?: boolean; count?: 1 | 2 }
  | { op: "drag"; x: number; y: number; toX: number; toY: number }
  | { op: "scroll"; x?: number; y?: number; amount: number };

const n0 = (v: number): number => Math.round(v);

/** The JXA program for one mouse action, in screen POINTS. */
export function mouseJxa(m: MouseOp): string {
  switch (m.op) {
    case "move": return `${JXA_HEAD}ev(5,${n0(m.x)},${n0(m.y)},0,1);`;
    case "click": {
      const [d, u, b] = m.right ? [3, 4, 1] : [1, 2, 0];
      const one = (c: number) => `ev(${d},${n0(m.x)},${n0(m.y)},${b},${c});nap(0.04);ev(${u},${n0(m.x)},${n0(m.y)},${b},${c});`;
      return `${JXA_HEAD}ev(5,${n0(m.x)},${n0(m.y)},0,1);nap(0.06);${one(1)}${m.count === 2 ? `nap(0.08);${one(2)}` : ""}`;
    }
    case "drag": {
      const steps = Array.from({ length: 10 }, (_, i) => `ev(6,${n0(m.x + ((m.toX - m.x) * (i + 1)) / 10)},${n0(m.y + ((m.toY - m.y) * (i + 1)) / 10)},0,1);nap(0.03);`).join("");
      return `${JXA_HEAD}ev(5,${n0(m.x)},${n0(m.y)},0,1);nap(0.06);ev(1,${n0(m.x)},${n0(m.y)},0,1);${steps}ev(2,${n0(m.toX)},${n0(m.toY)},0,1);`;
    }
    case "scroll":
      return `${JXA_HEAD}${m.x !== undefined && m.y !== undefined ? `ev(5,${n0(m.x)},${n0(m.y)},0,1);nap(0.05);` : ""}` +
        `var s=$.CGEventCreateScrollWheelEvent2(null,1,1,${n0(m.amount)},0,0);$.CGEventPost(0,s);`;
  }
}

const STATE_JXA = "ObjC.import('AppKit');ObjC.import('ApplicationServices');" +
  "var f=$.NSScreen.screens.objectAtIndex(0).frame.size;var m=$.NSEvent.mouseLocation;" +
  "[f.width,f.height,m.x,f.height-m.y,1,$.AXIsProcessTrusted()?1:0].join(' ');";

export interface MacState { pointsW: number; pointsH: number; cursorX: number; cursorY: number; screenRecording: boolean; accessibility: boolean }

export function parseMacState(stdout: string): MacState | undefined {
  const n = stdout.trim().split(/\s+/).map(Number);
  if (n.length < 6 || n.some((v) => !Number.isFinite(v)) || !(n[0] > 0) || !(n[1] > 0)) return undefined;
  return { pointsW: n[0], pointsH: n[1], cursorX: n[2], cursorY: n[3], screenRecording: n[4] === 1, accessibility: n[5] === 1 };
}

// ---------------------------------------------------------------- actions

export const MAC_ACTIONS = ["screenshot", "click", "double_click", "right_click", "move", "drag", "type", "key", "scroll", "wait"] as const;
export type MacAction = (typeof MAC_ACTIONS)[number];

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Math.round(Number(v)) : undefined);

/** One action: a description for the dry run and the log, and the executor calls (points are derived from `f`, points per screenshot pixel). */
export interface PlannedAction { text: string; calls: { cmd: string; args: string[] }[]; waitMs?: number; input: boolean }

export function planAction(action: MacAction, args: Record<string, unknown>, f: number): PlannedAction | { error: string } {
  const x = num(args.x), y = num(args.y);
  const needXY = () => (x === undefined || y === undefined || x < 0 || y < 0 ? `${action}: x and y are required (screenshot pixels, from the latest screenshot)` : undefined);
  const pt = (v: number): number => v * f;
  const jxa = (script: string) => ({ cmd: "osascript", args: ["-l", "JavaScript", "-e", script] });
  switch (action) {
    case "screenshot": return { text: "screenshot", calls: [], input: false };
    case "wait": {
      const s = Math.min(MAX_WAIT_S, Math.max(0, Number(args.seconds) || 1));
      return { text: `wait ${s}s`, calls: [], waitMs: Math.round(s * 1000), input: false };
    }
    case "move": { const e = needXY(); if (e) return { error: e }; return { text: `move to ${x},${y}`, calls: [jxa(mouseJxa({ op: "move", x: pt(x!), y: pt(y!) }))], input: true }; }
    case "click": case "double_click": case "right_click": {
      const e = needXY(); if (e) return { error: e };
      const right = action === "right_click" || args.button === "right";
      return { text: `${action} at ${x},${y}`, calls: [jxa(mouseJxa({ op: "click", x: pt(x!), y: pt(y!), right, count: action === "double_click" ? 2 : 1 }))], input: true };
    }
    case "drag": {
      const e = needXY(); if (e) return { error: e };
      const tx = num(args.to_x), ty = num(args.to_y);
      if (tx === undefined || ty === undefined || tx < 0 || ty < 0) return { error: "drag: to_x and to_y are required" };
      return { text: `drag ${x},${y} to ${tx},${ty}`, calls: [jxa(mouseJxa({ op: "drag", x: pt(x!), y: pt(y!), toX: pt(tx), toY: pt(ty) }))], input: true };
    }
    case "type": {
      const text = args.text;
      if (typeof text !== "string" || text === "") return { error: "type: text is required" };
      if (text.length > MAX_TEXT) return { error: `type: text is over ${MAX_TEXT} characters; send it in parts` };
      return { text: `type ${text.length} chars`, calls: [{ cmd: "osascript", args: typeArgs(text) }], input: true };
    }
    case "key": {
      const combo = args.keys;
      if (typeof combo !== "string" || combo.trim() === "") return { error: 'key: keys is required, e.g. "enter", "cmd+s", "cmd+shift+4"' };
      const k = toMacKey(combo);
      if ("error" in k) return k;
      return { text: `key ${combo.trim()}`, calls: [{ cmd: "osascript", args: keyArgs(k) }], input: true };
    }
    case "scroll": {
      const amount = num(args.amount) ?? -3;
      if (amount === 0 || Math.abs(amount) > 50) return { error: "scroll: amount must be between -50 and 50 and not 0 (negative scrolls down)" };
      return { text: x !== undefined && y !== undefined ? `scroll ${amount} at ${x},${y}` : `scroll ${amount}`, calls: [jxa(mouseJxa({ op: "scroll", amount, ...(x !== undefined && y !== undefined ? { x: pt(x), y: pt(y) } : {}) }))], input: true };
    }
  }
}

// ---------------------------------------------------------------- screenshot

export interface MacShot { width: number; height: number; screenWidth: number; screenHeight: number; cursorX: number; cursorY: number; jpegBase64: string; state: MacState }

const sipsDim = (out: string, key: string): number => Number(new RegExp(`${key}:\\s*(\\d+)`).exec(out)?.[1] ?? NaN);

/** Primary display, as a JPEG of at most SHOT_MAX_WIDTH pixels. Read-only: it never clicks or types. */
export async function macScreenshot(exec: MacExec, signal?: AbortSignal): Promise<{ ok: true; shot: MacShot } | { ok: false; error: string }> {
  const dir = await mkdtemp(join(tmpdir(), "daebot-shot-"));
  try {
    const png = join(dir, "s.png"), jpg = join(dir, "s.jpg");
    const cap = await exec("screencapture", ["-x", "-m", "-t", "png", png], { signal });
    if (cap.code !== 0) return { ok: false, error: `screencapture failed (${(cap.stderr || `exit ${cap.code}`).replace(/\s+/g, " ").trim().slice(0, 200)}). Daebot needs Screen Recording permission: System Settings, Privacy & Security, Screen Recording.` };
    const dims = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", png], { signal });
    const nw = sipsDim(dims.stdout, "pixelWidth"), nh = sipsDim(dims.stdout, "pixelHeight");
    if (!(nw > 0) || !(nh > 0)) return { ok: false, error: "screencapture produced no readable image. Check Screen Recording permission for Daebot." };
    const w = Math.min(MAC_SHOT_MAX_WIDTH, nw), h = Math.round((nh * w) / nw);
    const conv = await exec("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "--resampleWidth", String(w), png, "--out", jpg], { signal });
    if (conv.code !== 0) return { ok: false, error: `could not encode the screenshot (${conv.stderr.replace(/\s+/g, " ").trim().slice(0, 160)})` };
    const st = parseMacState((await exec("osascript", ["-l", "JavaScript", "-e", STATE_JXA], { signal })).stdout)
      ?? { pointsW: nw, pointsH: nh, cursorX: 0, cursorY: 0, screenRecording: true, accessibility: true };
    const jpeg = await readFile(jpg);
    if (!jpeg.length) return { ok: false, error: "the screenshot file was empty" };
    const f = w / st.pointsW; // screenshot pixels per point
    return { ok: true, shot: { width: w, height: h, screenWidth: nw, screenHeight: nh, cursorX: Math.round(st.cursorX * f), cursorY: Math.round(st.cursorY * f), jpegBase64: jpeg.toString("base64"), state: st } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The name of the frontmost application, or undefined when it cannot be read. */
export async function frontmostApp(exec: MacExec, signal?: AbortSignal): Promise<string | undefined> {
  const r = await exec("osascript", ["-e", "tell application \"System Events\" to get name of first application process whose frontmost is true"], { signal });
  const name = r.stdout.trim();
  return r.code === 0 && name ? name : undefined;
}

export interface MacRunResult { ok: boolean; error?: string; done: number; texts: string[]; shot?: MacShot; dryRun: boolean; shots: MacShot[] }

/**
 * Runs planned steps in order. `dryRun`: input actions are described and NOT executed (screenshots still are: they change nothing).
 * `hideOwnPid`: the Daebot desktop app's pid, hidden first (like the Windows minimize) so it does not cover the screen.
 */
export async function runMacSteps(
  steps: { action: MacAction; args: Record<string, unknown>; shot: boolean }[],
  o: { exec: MacExec; signal?: AbortSignal; dryRun: boolean; finalShot: boolean; hideOwnPid?: number; settleMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<MacRunResult> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const settle = o.settleMs ?? 600;
  const res: MacRunResult = { ok: true, done: 0, texts: [], dryRun: o.dryRun, shots: [] };
  const fail = (error: string): MacRunResult => ({ ...res, ok: false, error });
  // Scale: points per screenshot pixel. One cheap read; every coordinate in the batch uses it.
  const needsScale = steps.some((s) => ["click", "double_click", "right_click", "move", "drag", "scroll"].includes(s.action));
  let f = 1;
  if (needsScale) {
    const st = parseMacState((await o.exec("osascript", ["-l", "JavaScript", "-e", STATE_JXA], { signal: o.signal })).stdout);
    if (!st) return fail("computer: could not read the screen size (osascript failed)");
    f = st.pointsW / Math.min(MAC_SHOT_MAX_WIDTH, Math.round(st.pointsW * (await nativeScale(o.exec, o.signal))));
  }
  const plans: PlannedAction[] = [];
  for (let i = 0; i < steps.length; i++) {
    const p = planAction(steps[i].action, steps[i].args, f);
    if ("error" in p) return fail(`${steps.length > 1 ? `step ${i + 1}: ` : ""}${p.error}`);
    plans.push(p);
  }
  const anyInput = plans.some((p) => p.input);
  if (anyInput && !o.dryRun) {
    const st = parseMacState((await o.exec("osascript", ["-l", "JavaScript", "-e", STATE_JXA], { signal: o.signal })).stdout);
    if (st && !st.accessibility) return fail("computer: macOS has not given Daebot Accessibility permission, so clicks and keys would be ignored. Turn it on in System Settings, Privacy & Security, Accessibility.");
    const front = await frontmostApp(o.exec, o.signal);
    if (front && isMacTerminalApp(front)) return fail(blockedMessage("computer", front));
  }
  if (o.hideOwnPid && !o.dryRun && steps.some((s) => s.action !== "wait")) {
    await o.exec("osascript", ["-e", `tell application "System Events" to set visible of (first process whose unix id is ${Math.trunc(o.hideOwnPid)}) to false`], { signal: o.signal });
    await sleep(300);
  }
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    if (o.signal?.aborted) return fail("computer: stopped");
    res.texts.push(o.dryRun && p.input ? `DRY RUN (not executed) ${p.text}` : p.text);
    if (p.input && !o.dryRun) {
      // the terminal ban is rechecked between actions: a click can change which app is frontmost
      if (i > 0) { const front = await frontmostApp(o.exec, o.signal); if (front && isMacTerminalApp(front)) return { ...fail(`${blockedMessage("computer", front)} Completed ${res.done} of ${plans.length} actions before it.`) }; }
      for (const c of p.calls) {
        const r = await o.exec(c.cmd, c.args, { signal: o.signal });
        if (r.code !== 0) return fail(`computer: ${plans.length > 1 ? `stopped after ${res.done} of ${plans.length} actions: ` : `${steps[i].action} failed: `}${(r.stderr || `exit ${r.code}`).replace(/\s+/g, " ").trim().slice(0, 300)}`);
      }
    }
    if (p.waitMs) await sleep(p.waitMs);
    res.done = i + 1;
    if (i < plans.length - 1) {
      if (steps[i].shot) { await sleep(150); const s = await macScreenshot(o.exec, o.signal); if (!s.ok) return fail(`computer: ${s.error}`); res.shots.push(s.shot); } else await sleep(150);
    }
  }
  if (o.finalShot || steps[steps.length - 1].shot) {
    if (anyInput && !o.dryRun) await sleep(settle);
    const s = await macScreenshot(o.exec, o.signal);
    if (!s.ok) return fail(`computer: ${s.error}`);
    res.shots.push(s.shot);
    res.shot = s.shot;
  }
  return res;
}

/** Screenshot pixels per point is only known after a capture; the scale of the primary display is read from the backing store. */
async function nativeScale(exec: MacExec, signal?: AbortSignal): Promise<number> {
  const r = await exec("osascript", ["-l", "JavaScript", "-e", "ObjC.import('AppKit');$.NSScreen.screens.objectAtIndex(0).backingScaleFactor;"], { signal });
  const v = Number(r.stdout.trim());
  return Number.isFinite(v) && v >= 1 ? v : 1;
}
