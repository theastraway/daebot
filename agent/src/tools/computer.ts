import type { Tool, ToolResult } from "../types.ts";
import { fail } from "./util.ts";
import { backgroundGuard } from "../routing.ts";
import { CONSOLE_CHECK_PS, blockedMessage, parseBlocked, psq, runPowerShell as makeRunner } from "./ps.ts";
import type { ScriptRunner } from "./ps.ts";
export type { ScriptRunner } from "./ps.ts";

// Screen control for desktop apps with no API (Xactimate is the first). Windows only: every action is one short PowerShell
// script (System.Windows.Forms + user32), so the compiled gateway needs no native module. Coordinates are always in the
// SCREENSHOT's pixel space; the script maps them to the real screen, so the model never has to know the display scale.

export const SHOT_MAX_WIDTH = 1366;
const SCRIPT_TIMEOUT_MS = 30_000;
const SETTLE_MS = 600;
const STEP_SETTLE_MS = 150; // between the actions of one batch
const MAX_BATCH = 20;
const MAX_SHOTS = 4;
const MAX_TEXT = 2000;
const MAX_WAIT_S = 10;

const ACTIONS = ["screenshot", "click", "double_click", "right_click", "move", "drag", "type", "key", "scroll", "wait"] as const;
type Action = (typeof ACTIONS)[number];

// SendKeys names for the keys a model will ask for. Letters, digits and punctuation pass through (escaped).
const NAMED: Record<string, string> = {
  enter: "{ENTER}", return: "{ENTER}", tab: "{TAB}", esc: "{ESC}", escape: "{ESC}", backspace: "{BACKSPACE}", delete: "{DELETE}", del: "{DELETE}",
  insert: "{INSERT}", home: "{HOME}", end: "{END}", pageup: "{PGUP}", pagedown: "{PGDN}", up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
  space: " ", capslock: "{CAPSLOCK}", printscreen: "{PRTSC}",
};
for (let i = 1; i <= 16; i++) NAMED[`f${i}`] = `{F${i}}`;
const MODS: Record<string, string> = { ctrl: "^", control: "^", alt: "%", shift: "+" };

/** Text for SendKeys: every character SendKeys treats as syntax is wrapped in braces; newlines become ENTER. */
export function escapeSendKeys(text: string): string {
  let out = "";
  for (const ch of text.replace(/\r\n/g, "\n")) {
    if (ch === "\n") out += "{ENTER}";
    else if ("+^%~(){}[]".includes(ch)) out += `{${ch}}`;
    else out += ch;
  }
  return out;
}

/** "ctrl+shift+s" -> "^+s", "enter" -> "{ENTER}", "alt+f4" -> "%{F4}". "win" combos are returned as { win: key }. */
export function toSendKeys(combo: string): { keys: string } | { win: string } | { error: string } {
  const parts = combo.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { error: "key: empty key" };
  const last = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mods.includes("win") || mods.includes("windows") || last === "win" || last === "windows") {
    if (mods.length > 1 || (mods.length === 1 && last === "win")) return { error: "key: only win alone or win+<one key> is supported" };
    return { win: last === "win" || last === "windows" ? "" : last };
  }
  let prefix = "";
  for (const m of mods) {
    if (!MODS[m]) return { error: `key: unknown modifier "${m}" (use ctrl, alt, shift, win)` };
    prefix += MODS[m];
  }
  let key: string;
  if (NAMED[last] !== undefined) key = NAMED[last];
  else if (last.length === 1) key = escapeSendKeys(last);
  else return { error: `key: unknown key "${last}"` };
  return { keys: prefix + key };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Math.round(Number(v)) : undefined);

const PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Daebot -Name U32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, System.IntPtr e);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, System.IntPtr e);
'@
[void][Daebot.U32]::SetProcessDPIAware()
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$W = [Math]::Min(${SHOT_MAX_WIDTH}, $b.Width)
$f = $b.Width / $W
function P([int]$x, [int]$y) { [void][Daebot.U32]::SetCursorPos([int]($b.X + $x * $f), [int]($b.Y + $y * $f)) }
function Btn([uint32]$down, [uint32]$up) { [Daebot.U32]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 40; [Daebot.U32]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero) }
`;

const SHOT_FN = `
function Take-Shot([int]$settle) {
  Start-Sleep -Milliseconds $settle
  $H = [int]($b.Height / $f)
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $small = New-Object System.Drawing.Bitmap $bmp, $W, $H
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 70L
  $ms = New-Object System.IO.MemoryStream
  $small.Save($ms, $enc, $ep)
  $pos = [System.Windows.Forms.Cursor]::Position
  Write-Output ("DAEBOT_SHOT {0} {1} {2} {3} {4} {5}" -f $W, $H, $b.Width, $b.Height, [int](($pos.X - $b.X) / $f), [int](($pos.Y - $b.Y) / $f))
  Write-Output ([Convert]::ToBase64String($ms.ToArray()))
}
`;

const HEAD = `${PRELUDE}${CONSOLE_CHECK_PS}${SHOT_FN}`;

/** The PowerShell body for one action (no screenshot), or an error the model can fix. */
export function actionBody(action: Action, args: Record<string, unknown>): { body: string } | { error: string } {
  const x = num(args.x), y = num(args.y);
  const needXY = () => (x === undefined || y === undefined || x < 0 || y < 0 ? `${action}: x and y are required (screenshot pixels, from the latest screenshot)` : undefined);
  let body = "";
  switch (action) {
    case "screenshot": break;
    case "move": { const e = needXY(); if (e) return { error: e }; body = `P ${x} ${y}`; break; }
    case "click":
    case "double_click":
    case "right_click": {
      const e = needXY(); if (e) return { error: e };
      const right = action === "right_click" || args.button === "right";
      const [d, u] = right ? [0x0008, 0x0010] : [0x0002, 0x0004];
      body = `P ${x} ${y}\nBlock-IfConsoleAtCursor\nStart-Sleep -Milliseconds 60\nBtn ${d} ${u}`;
      if (action === "double_click") body += `\nStart-Sleep -Milliseconds 80\nBtn ${d} ${u}`;
      break;
    }
    case "drag": {
      const e = needXY(); if (e) return { error: e };
      const tx = num(args.to_x), ty = num(args.to_y);
      if (tx === undefined || ty === undefined || tx < 0 || ty < 0) return { error: "drag: to_x and to_y are required" };
      body = `P ${x} ${y}\nBlock-IfConsoleAtCursor\n[Daebot.U32]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)\n` +
        `for ($i = 1; $i -le 10; $i++) { P ([int](${x} + (${tx} - ${x}) * $i / 10)) ([int](${y} + (${ty} - ${y}) * $i / 10)); Start-Sleep -Milliseconds 30 }\n` +
        `[Daebot.U32]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)`;
      break;
    }
    case "type": {
      const text = args.text;
      if (typeof text !== "string" || text === "") return { error: "type: text is required" };
      if (text.length > MAX_TEXT) return { error: `type: text is over ${MAX_TEXT} characters; send it in parts` };
      body = `Block-IfForegroundConsole\n[System.Windows.Forms.SendKeys]::SendWait(${psq(escapeSendKeys(text))})`;
      break;
    }
    case "key": {
      const combo = args.keys;
      if (typeof combo !== "string" || combo.trim() === "") return { error: 'key: keys is required, e.g. "enter", "ctrl+s", "alt+f4"' };
      const k = toSendKeys(combo);
      if ("error" in k) return k;
      if ("win" in k) {
        // SendKeys has no Windows key: press VK_LWIN (0x5B) with keybd_event, plus the one key if given.
        const vk = k.win === "" ? undefined : k.win.length === 1 ? k.win.toUpperCase().charCodeAt(0) : undefined;
        if (k.win !== "" && vk === undefined) return { error: "key: win+<key> supports one letter or digit only" };
        body = `Block-IfForegroundConsole\n[Daebot.U32]::keybd_event(0x5B, 0, 0, [IntPtr]::Zero)` +
          (vk !== undefined ? `\n[Daebot.U32]::keybd_event(${vk}, 0, 0, [IntPtr]::Zero)\n[Daebot.U32]::keybd_event(${vk}, 0, 2, [IntPtr]::Zero)` : "") +
          `\n[Daebot.U32]::keybd_event(0x5B, 0, 2, [IntPtr]::Zero)`;
      } else body = `Block-IfForegroundConsole\n[System.Windows.Forms.SendKeys]::SendWait(${psq(k.keys)})`;
      break;
    }
    case "scroll": {
      const amount = num(args.amount) ?? -3; // negative = down, like the wheel
      if (amount === 0 || Math.abs(amount) > 50) return { error: "scroll: amount must be between -50 and 50 and not 0 (negative scrolls down)" };
      body = (x !== undefined && y !== undefined ? `P ${x} ${y}\nBlock-IfConsoleAtCursor\n` : "Block-IfForegroundConsole\n") + `[Daebot.U32]::mouse_event(0x0800, 0, 0, ${amount * 120}, [IntPtr]::Zero)`;
      break;
    }
    case "wait": {
      const s = Math.min(MAX_WAIT_S, Math.max(0, Number(args.seconds) || 1));
      body = `Start-Sleep -Milliseconds ${Math.round(s * 1000)}`;
      break;
    }
  }
  return { body };
}

/** One action as a whole script: the body, then a screenshot. */
export function buildScript(action: Action, args: Record<string, unknown>): { script: string } | { error: string } {
  const b = actionBody(action, args);
  return "error" in b ? b : { script: `${HEAD}\n${b.body}\nTake-Shot ${SETTLE_MS}\nWrite-Output 'DAEBOT_DONE'` };
}

export interface BatchStep { action: Action; args: Record<string, unknown>; shot: boolean }
/** Several actions in ONE PowerShell process. A screenshot only where a step asks for one (and always at the end unless the batch says not). */
export function buildBatchScript(steps: BatchStep[], finalShot: boolean): { script: string } | { error: string } {
  const parts: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const b = actionBody(steps[i].action, steps[i].args);
    if ("error" in b) return { error: `step ${i + 1}: ${b.error}` };
    parts.push(`${b.body}\nWrite-Output 'DAEBOT_STEP ${i + 1}'`);
    if (i < steps.length - 1) parts.push(steps[i].shot ? `Take-Shot ${STEP_SETTLE_MS}` : `Start-Sleep -Milliseconds ${STEP_SETTLE_MS}`);
  }
  const last = steps.length - 1;
  if (finalShot || steps[last].shot) parts.push(`Take-Shot ${SETTLE_MS}`);
  parts.push("Write-Output 'DAEBOT_DONE'");
  return { script: `${HEAD}\n${parts.join("\n")}` };
}

export interface ShotParse { width: number; height: number; screenWidth: number; screenHeight: number; cursorX: number; cursorY: number; jpegBase64: string }
export function parseShot(stdout: string): ShotParse | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const i = lines.findIndex((l) => l.startsWith("DAEBOT_SHOT "));
  if (i < 0 || !lines[i + 1]) return undefined;
  const n = lines[i].split(/\s+/).slice(1).map(Number);
  if (n.length < 6 || n.some((v) => !Number.isFinite(v))) return undefined;
  if (!/^[A-Za-z0-9+/=]+$/.test(lines[i + 1])) return undefined;
  return { width: n[0], height: n[1], screenWidth: n[2], screenHeight: n[3], cursorX: n[4], cursorY: n[5], jpegBase64: lines[i + 1] };
}

/** Every DAEBOT_SHOT block in the output, in order. */
export function parseShots(stdout: string): ShotParse[] {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: ShotParse[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("DAEBOT_SHOT ")) continue;
    const one = parseShot(`${lines[i]}\n${lines[i + 1] ?? ""}`);
    if (one) { out.push(one); i++; }
  }
  return out;
}

/** The production runner (Windows PowerShell 5.1). */
export const runPowerShell: ScriptRunner = (script, signal) => makeRunner(SCRIPT_TIMEOUT_MS)(script, signal);

/** Offered only on the Windows desktop app: never hosted (the hosted allowlist drops it) and never on Mac/Linux for now. */
export function computerToolSupported(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DAEBOT_COMPUTER_USE === "0" || env.DAEBOT_COMPUTER_USE === "false") return false;
  return platform === "win32";
}

const STEP_PROPS = {
  action: { type: "string", enum: [...ACTIONS] },
  x: { type: "number" }, y: { type: "number" },
  to_x: { type: "number" }, to_y: { type: "number" },
  text: { type: "string" },
  keys: { type: "string" },
  amount: { type: "number" },
  seconds: { type: "number" },
  screenshot: { type: "boolean", description: "In a batch: true takes a screenshot right after this step (default only after the last)." },
} as const;

const describeStep = (action: Action, a: Record<string, unknown>): string => {
  if (action === "type") return `type ${String(a.text ?? "").length} chars`;
  if (action === "key") return `key ${String(a.keys ?? "")}`;
  if (a.x !== undefined) return `${action} at ${num(a.x)},${num(a.y)}`;
  return action;
};

export function createComputerTool(run?: ScriptRunner): Tool {
  return {
    class: "write",
    receipt: "surface",
    spec: {
      name: "computer",
      description:
        "LAST RESORT, and slow. Takes over the user's screen, mouse and keyboard: they cannot use their PC while you do. Try the `app` tool first: it clicks buttons, fills fields and reads text in a desktop app in the background, with no mouse and no screenshot. " +
        "Use computer ONLY when `app` cannot reach the control (a canvas or custom-drawn window with no UI Automation tree, for example Xactimate), or when the user asked to watch you do it on screen. " +
        "NEVER for: reading a web page or URL (use web_fetch), running a command (use bash; process for long jobs), files (read_file, write_file, glob, grep), or mail, calendar, contacts, bots and anything a connector or mind_* tool covers. " +
        "NEVER, with no override: open, focus, click into or type into a terminal, PowerShell, cmd, Windows Terminal or the Run box (win+r), or search for one in the Start menu. Those calls are refused and the script itself stops if the window is a console. Run the command with bash instead. " +
        "Before your first computer action in a task, say in one line why no background tool can do it. A call that types a URL or a shell command is refused unless you pass screen_required:true (only when the user asked to watch it on screen). " +
        "BATCH: send many actions in ONE call with actions:[{action,...},...] (up to 20). They run back to back in one process with one screenshot at the end; add screenshot:true to a step to also see the screen after it, or screenshot:false at the top level to get no screenshot. Do not call once per mouse move. " +
        "A single action returns a fresh screenshot of the primary display. x/y are pixels in the LATEST screenshot (top-left is 0,0). Start with action=screenshot, then batch what you can see. " +
        "Actions: screenshot | click | double_click | right_click | move | drag (x,y -> to_x,to_y) | type (text) | " +
        'key (keys, e.g. "enter", "tab", "ctrl+s", "alt+f4") | scroll (amount, negative = down, optional x,y) | wait (seconds, max 10).',
      parameters: {
        type: "object",
        properties: {
          ...STEP_PROPS,
          actions: { type: "array", maxItems: MAX_BATCH, items: { type: "object", properties: STEP_PROPS, required: ["action"] }, description: "A batch: run these in order in one call." },
          screen_required: { type: "boolean", description: "true only when the user asked to watch this on screen or no background tool can do it. Never lifts the terminal ban." },
        },
      },
    },
    async run(args, ctx): Promise<ToolResult> {
      const raw: Record<string, unknown>[] = Array.isArray(args.actions) ? (args.actions as Record<string, unknown>[]) : [args];
      const batch = Array.isArray(args.actions);
      if (!raw.length) return fail("computer: actions is empty");
      if (raw.length > MAX_BATCH) return fail(`computer: at most ${MAX_BATCH} actions per call; send the rest in a second call`);
      const steps: BatchStep[] = [];
      for (let i = 0; i < raw.length; i++) {
        const st = raw[i];
        const label = batch ? `step ${i + 1}: ` : "";
        if (!st || typeof st !== "object") return fail(`computer: ${label}not an action`);
        const action = st.action as Action;
        if (!ACTIONS.includes(action)) return fail(`computer: ${label}action must be one of ${ACTIONS.join(", ")}`);
        const blocked = backgroundGuard({ ...st, screen_required: args.screen_required === true || st.screen_required === true });
        if (blocked) return fail(`${label}${blocked}`);
        steps.push({ action, args: st, shot: st.screenshot === true });
      }
      const wantFinal = args.screenshot !== false && !(raw.length === 1 && raw[0].screenshot === false);
      if (steps.filter((s, i) => s.shot && i < steps.length - 1).length + (wantFinal ? 1 : 0) > MAX_SHOTS) return fail(`computer: at most ${MAX_SHOTS} screenshots per call`);
      const built = batch || !wantFinal ? buildBatchScript(steps, wantFinal) : buildScript(steps[0].action, steps[0].args);
      if ("error" in built) return fail(`computer: ${built.error}`);
      if (ctx.signal?.aborted) return fail("computer: aborted before start");
      const runner = run ?? makeRunner(Math.min(120_000, SCRIPT_TIMEOUT_MS + steps.length * 3000));
      const r = await runner(built.script, ctx.signal);
      const done = Math.max(0, ...[...r.stdout.matchAll(/^DAEBOT_STEP (\d+)/gm)].map((m) => Number(m[1])));
      const refused = parseBlocked(r.stdout);
      if (refused) return fail(`${blockedMessage("computer", refused)} Completed ${done} of ${steps.length} actions before it.`);
      const shots = parseShots(r.stdout);
      const finished = /^DAEBOT_DONE/m.test(r.stdout);
      if (r.code !== 0 || !(finished || (wantFinal && shots.length)) || (wantFinal && !shots.length)) {
        const why = (r.stderr || r.stdout.replace(/DAEBOT_SHOT[^\n]*\n[A-Za-z0-9+/=\s]*/g, "")).replace(/\s+/g, " ").trim().slice(0, 400) || `exit code ${r.code}`;
        return fail(`computer: ${steps.length > 1 ? `stopped after ${done} of ${steps.length} actions: ` : `${steps[0].action} failed: `}${why}`);
      }
      const what = steps.map((s) => describeStep(s.action, s.args)).join("; ");
      const last = shots[shots.length - 1];
      const head = steps.length === 1 && steps[0].action === "screenshot" ? "Screenshot taken" : steps.length === 1 ? `Did ${what}` : `Did ${steps.length} actions (${what})`;
      return {
        ok: true,
        output: last
          ? `${head}. Screenshot ${last.width}x${last.height} (screen ${last.screenWidth}x${last.screenHeight}), cursor at ${last.cursorX},${last.cursorY}. Use coordinates in this screenshot.${shots.length > 1 ? ` ${shots.length} screenshots, in order; the last is the current screen.` : ""}`
          : `${head}. No screenshot was taken.`,
        images: shots.map((x) => `data:image/jpeg;base64,${x.jpegBase64}`),
        meta: last ? { width: last.width, height: last.height } : undefined,
      };
    },
  };
}
