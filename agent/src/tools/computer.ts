import { spawn } from "node:child_process";
import type { Tool, ToolResult } from "../types.ts";
import { fail } from "./util.ts";
import { backgroundGuard } from "../routing.ts";

// Screen control for desktop apps with no API (Xactimate is the first). Windows only: every action is one short PowerShell
// script (System.Windows.Forms + user32), so the compiled gateway needs no native module. Coordinates are always in the
// SCREENSHOT's pixel space; the script maps them to the real screen, so the model never has to know the display scale.

export const SHOT_MAX_WIDTH = 1366;
const SCRIPT_TIMEOUT_MS = 30_000;
const SETTLE_MS = 600;
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
// A PowerShell single-quoted string: only ' needs escaping (doubled).
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

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

const SHOT = `
Start-Sleep -Milliseconds ${SETTLE_MS}
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
`;

/** The PowerShell body for one action (the screenshot is always appended), or an error the model can fix. */
export function buildScript(action: Action, args: Record<string, unknown>): { script: string } | { error: string } {
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
      body = `P ${x} ${y}\nStart-Sleep -Milliseconds 60\nBtn ${d} ${u}`;
      if (action === "double_click") body += `\nStart-Sleep -Milliseconds 80\nBtn ${d} ${u}`;
      break;
    }
    case "drag": {
      const e = needXY(); if (e) return { error: e };
      const tx = num(args.to_x), ty = num(args.to_y);
      if (tx === undefined || ty === undefined || tx < 0 || ty < 0) return { error: "drag: to_x and to_y are required" };
      body = `P ${x} ${y}\n[Daebot.U32]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)\n` +
        `for ($i = 1; $i -le 10; $i++) { P ([int](${x} + (${tx} - ${x}) * $i / 10)) ([int](${y} + (${ty} - ${y}) * $i / 10)); Start-Sleep -Milliseconds 30 }\n` +
        `[Daebot.U32]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)`;
      break;
    }
    case "type": {
      const text = args.text;
      if (typeof text !== "string" || text === "") return { error: "type: text is required" };
      if (text.length > MAX_TEXT) return { error: `type: text is over ${MAX_TEXT} characters; send it in parts` };
      body = `[System.Windows.Forms.SendKeys]::SendWait(${psq(escapeSendKeys(text))})`;
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
        body = `[Daebot.U32]::keybd_event(0x5B, 0, 0, [IntPtr]::Zero)` +
          (vk !== undefined ? `\n[Daebot.U32]::keybd_event(${vk}, 0, 0, [IntPtr]::Zero)\n[Daebot.U32]::keybd_event(${vk}, 0, 2, [IntPtr]::Zero)` : "") +
          `\n[Daebot.U32]::keybd_event(0x5B, 0, 2, [IntPtr]::Zero)`;
      } else body = `[System.Windows.Forms.SendKeys]::SendWait(${psq(k.keys)})`;
      break;
    }
    case "scroll": {
      const amount = num(args.amount) ?? -3; // negative = down, like the wheel
      if (amount === 0 || Math.abs(amount) > 50) return { error: "scroll: amount must be between -50 and 50 and not 0 (negative scrolls down)" };
      body = (x !== undefined && y !== undefined ? `P ${x} ${y}\n` : "") + `[Daebot.U32]::mouse_event(0x0800, 0, 0, ${amount * 120}, [IntPtr]::Zero)`;
      break;
    }
    case "wait": {
      const s = Math.min(MAX_WAIT_S, Math.max(0, Number(args.seconds) || 1));
      body = `Start-Sleep -Milliseconds ${Math.round(s * 1000)}`;
      break;
    }
  }
  return { script: `${PRELUDE}\n${body}\n${SHOT}` };
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

export type ScriptRunner = (script: string, signal?: AbortSignal) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Runs one script through Windows PowerShell 5.1 (always present on Windows 10/11), passed as -EncodedCommand (UTF-16LE). */
export const runPowerShell: ScriptRunner = (script, signal) => new Promise((resolve) => {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-EncodedCommand", encoded], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
  child.stderr.on("data", (d: Buffer) => { if (stderr.length < 8000) stderr += d.toString("utf8"); });
  const kill = () => { try { child.kill(); } catch { /* gone */ } };
  const timer = setTimeout(kill, SCRIPT_TIMEOUT_MS);
  signal?.addEventListener("abort", kill, { once: true });
  child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: e.message }); });
  child.on("close", (code) => { clearTimeout(timer); signal?.removeEventListener("abort", kill); resolve({ code, stdout, stderr }); });
});

/** Offered only on the Windows desktop app: never hosted (the hosted allowlist drops it) and never on Mac/Linux for now. */
export function computerToolSupported(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DAEBOT_COMPUTER_USE === "0" || env.DAEBOT_COMPUTER_USE === "false") return false;
  return platform === "win32";
}

export function createComputerTool(run: ScriptRunner = runPowerShell): Tool {
  return {
    class: "write",
    receipt: "surface",
    spec: {
      name: "computer",
      description:
        "LAST RESORT. Takes over the user's screen, mouse and keyboard: they cannot use their PC while you do. Use it ONLY for a desktop app that has no API, CLI or connector (for example Xactimate), or when the user asked to watch you do it on screen. " +
        "NEVER for: reading a web page or URL (use web_fetch), running a command or opening a terminal (use bash; process for long jobs), files (read_file, write_file, glob, grep), or mail, calendar, contacts, bots and anything a connector or mind_* tool covers. " +
        "Before your first computer action in a task, say in one line why no background tool can do it. A call that types a URL or a shell command is refused unless you pass screen_required:true (only when the user asked to watch it on screen). " +
        "Every action returns a fresh screenshot of the primary display. x/y are pixels in the LATEST screenshot (top-left is 0,0). " +
        "Start with action=screenshot, act, then read the new screenshot before the next step. " +
        "Actions: screenshot | click | double_click | right_click | move | drag (x,y -> to_x,to_y) | type (text) | " +
        'key (keys, e.g. "enter", "tab", "ctrl+s", "alt+f4", "win+r") | scroll (amount, negative = down, optional x,y) | wait (seconds, max 10).',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...ACTIONS] },
          x: { type: "number" }, y: { type: "number" },
          to_x: { type: "number" }, to_y: { type: "number" },
          text: { type: "string" },
          keys: { type: "string" },
          amount: { type: "number" },
          seconds: { type: "number" },
          screen_required: { type: "boolean", description: "true only when the user asked to watch this on screen or no background tool can do it" },
        },
        required: ["action"],
      },
    },
    async run(args, ctx): Promise<ToolResult> {
      const action = args.action as Action;
      if (!ACTIONS.includes(action)) return fail(`computer: action must be one of ${ACTIONS.join(", ")}`);
      const blocked = backgroundGuard(args);
      if (blocked) return fail(blocked);
      const built = buildScript(action, args);
      if ("error" in built) return fail(`computer: ${built.error}`);
      if (ctx.signal?.aborted) return fail("computer: aborted before start");
      const r = await run(built.script, ctx.signal);
      const shot = parseShot(r.stdout);
      if (r.code !== 0 || !shot) {
        const why = (r.stderr || r.stdout).replace(/\s+/g, " ").trim().slice(0, 400) || `exit code ${r.code}`;
        return fail(`computer: ${action} failed: ${why}`);
      }
      const did = action === "screenshot" ? "Screenshot taken" : `Did ${action}${args.x !== undefined ? ` at ${num(args.x)},${num(args.y)}` : ""}`;
      return {
        ok: true,
        output: `${did}. Screenshot ${shot.width}x${shot.height} (screen ${shot.screenWidth}x${shot.screenHeight}), cursor at ${shot.cursorX},${shot.cursorY}. Use coordinates in this screenshot.`,
        images: [`data:image/jpeg;base64,${shot.jpegBase64}`],
        meta: { width: shot.width, height: shot.height },
      };
    },
  };
}
