import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONSOLE_PROCESSES, CONSOLE_WINDOW_CLASSES, RUN_DIALOG_TITLE } from "../routing.ts";

// Shared Windows PowerShell pieces for the `computer` and `app` tools.

/** A PowerShell single-quoted string: only ' needs escaping (doubled). */
export const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export type ScriptRunner = (script: string, signal?: AbortSignal) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/**
 * The console check. After this block runs, `Block-IfConsole (Win-Facts <hwnd>)` ends the script with exit code 3 and one
 * `DAEBOT_BLOCKED proc | class | title` line when the window is a terminal, a console host or the Run box. The decision mirrors
 * isConsoleWindow() in routing.ts (same lists, generated from the same constants).
 */
export const CONSOLE_CHECK_PS = `
Add-Type -Namespace Daebot -Name Win -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(PT p);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
'@
$ConsoleProcs = @(${CONSOLE_PROCESSES.map(psq).join(", ")})
$ConsoleClasses = @(${CONSOLE_WINDOW_CLASSES.map(psq).join(", ")})
function Win-Facts([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return $null }
  $r = [Daebot.Win]::GetAncestor($h, 2); if ($r -ne [IntPtr]::Zero) { $h = $r }
  $p = [uint32]0; [void][Daebot.Win]::GetWindowThreadProcessId($h, [ref]$p)
  $sb = New-Object System.Text.StringBuilder 256; [void][Daebot.Win]::GetClassName($h, $sb, 256)
  $sb2 = New-Object System.Text.StringBuilder 256; [void][Daebot.Win]::GetWindowText($h, $sb2, 256)
  $name = ''; try { $name = (Get-Process -Id $p -ErrorAction Stop).ProcessName } catch { }
  [pscustomobject]@{ Proc = $name; Class = $sb.ToString(); Title = $sb2.ToString() }
}
function Test-Console($f) {
  if ($null -eq $f) { return $false }
  $pn = $f.Proc.ToLower()
  if ($ConsoleProcs -contains $pn) { return $true }
  if ($ConsoleClasses -contains $f.Class) { return $true }
  if ($f.Class -eq '#32770' -and $f.Title -eq ${psq(RUN_DIALOG_TITLE)} -and $pn -eq 'explorer') { return $true }
  return $false
}
function Block-IfConsole($f) {
  if (Test-Console $f) { Write-Output ("DAEBOT_BLOCKED {0} | {1} | {2}" -f $f.Proc, $f.Class, $f.Title); exit 3 }
}
function Block-IfForegroundConsole { Block-IfConsole (Win-Facts ([Daebot.Win]::GetForegroundWindow())) }
function Block-IfConsoleAtCursor {
  $c = [System.Windows.Forms.Cursor]::Position
  $q = New-Object Daebot.Win+PT; $q.X = $c.X; $q.Y = $c.Y
  Block-IfConsole (Win-Facts ([Daebot.Win]::WindowFromPoint($q)))
}
`;

/** The `DAEBOT_BLOCKED proc | class | title` line a script prints when it refused to act on a console. */
export function parseBlocked(stdout: string): string | undefined {
  const m = /^DAEBOT_BLOCKED (.*)$/m.exec(stdout);
  return m ? m[1].trim() : undefined;
}

export const blockedMessage = (tool: string, what: string): string =>
  `${tool}: refused. The target is a terminal, console or Run box (${what}). This rule has no override. Run the command with the bash tool (short), the process tool (long, background) or the terminal tool (interactive, hidden). Never on screen.`;

// CreateProcess caps the command line at 32,767 characters. Up to this much goes as -EncodedCommand (the proven path);
// a bigger script (a long batch) is written to a temp .ps1 and run with -File.
const ENCODED_MAX = 24_000;

/** Windows PowerShell 5.1 (always present on Windows 10/11). Short scripts as -EncodedCommand (UTF-16LE), long ones via a temp file. */
export const runPowerShell = (timeoutMs: number, opts: { mta?: boolean } = {}): ScriptRunner => (script, signal) => new Promise((resolve) => {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  let file: string | undefined;
  const base = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", opts.mta ? "-MTA" : "-STA"];
  let args: string[];
  if (encoded.length <= ENCODED_MAX) args = [...base, "-EncodedCommand", encoded];
  else {
    file = join(tmpdir(), `daebot-${randomBytes(6).toString("hex")}.ps1`);
    try { writeFileSync(file, "\uFEFF" + script, "utf8"); } catch (e) { return resolve({ code: null, stdout: "", stderr: `could not write the script file: ${(e as Error).message}` }); }
    args = [...base, "-File", file];
  }
  const done = (r: { code: number | null; stdout: string; stderr: string }) => { if (file) { try { unlinkSync(file); } catch { /* gone */ } } resolve(r); };
  const child = spawn("powershell.exe", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
  child.stderr.on("data", (d: Buffer) => { if (stderr.length < 8000) stderr += d.toString("utf8"); });
  const kill = () => { try { child.kill(); } catch { /* gone */ } };
  const timer = setTimeout(kill, timeoutMs);
  signal?.addEventListener("abort", kill, { once: true });
  child.on("error", (e) => { clearTimeout(timer); done({ code: null, stdout, stderr: e.message }); });
  child.on("close", (code) => { clearTimeout(timer); signal?.removeEventListener("abort", kill); done({ code, stdout, stderr }); });
});
