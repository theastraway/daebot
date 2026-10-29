import { spawn, spawnSync } from "node:child_process";
import type { Tool } from "../types.ts";
import { cap, fail } from "./util.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_CAP = 30_000;

// The shell never inherits the process environment: only these names pass (so no *_KEY, *_SECRET, *TOKEN*, OPENROUTER*, MIND_* ...).
const ENV_ALLOW = ["PATH", "HOME", "LANG", "TMPDIR", "USER", "SHELL"];
// Windows cannot start PowerShell or most programs without these (they hold paths, not secrets).
const ENV_ALLOW_WIN = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "PSModulePath", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"];
const SECRET_NAME = /(_KEY|_SECRET|TOKEN|PASSWORD|OPENROUTER|^MIND_|CREDENTIAL)/i;
export function shellEnv(src: NodeJS.ProcessEnv = process.env, platform: string = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of platform === "win32" ? [...ENV_ALLOW, ...ENV_ALLOW_WIN] : ENV_ALLOW) if (src[k] !== undefined && !SECRET_NAME.test(k)) out[k] = src[k];
  return out;
}

// The command runner. Everywhere but Windows: bash -c. Windows: bash when one is on PATH (Git for Windows, WSL), else
// Windows PowerShell, which every Windows 10/11 machine has. Probed once per process.
let winShell: "bash" | "powershell" | undefined;
export function shellCommand(command: string, platform: string = process.platform, hasBash?: () => boolean): { file: string; args: string[]; label: string } {
  if (platform !== "win32") return { file: "bash", args: ["-c", command], label: "bash" };
  if (hasBash) winShell = hasBash() ? "bash" : "powershell";
  if (!winShell) {
    const probe = spawnSync("bash", ["-c", "exit 0"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
    winShell = !probe.error && probe.status === 0 ? "bash" : "powershell";
  }
  return winShell === "bash"
    ? { file: "bash", args: ["-c", command], label: "bash" }
    : { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], label: "powershell" };
}

export const bashTool: Tool = {
  class: "write",
  receipt: "surface",
  spec: {
    name: "bash",
    description: process.platform === "win32"
      ? "Run a shell command in the working directory (bash if installed, otherwise Windows PowerShell; the output's first line says which). 120s default timeout, output capped at 30k chars. Prefer read_file/grep/glob for reading. This is how you run commands, scripts, tests, git and file conversions: never type them into a terminal on the screen (the computer tool). A job over about a minute goes to the process tool instead."
      : "Run a shell command (bash -c) in the working directory. 120s default timeout, output capped at 30k chars. Prefer read_file/grep/glob for reading. This is how you run commands, scripts, tests, git and file conversions: never type them into a terminal on the screen (the computer tool). A job over about a minute goes to the process tool instead.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number", description: "Default 120000, max 600000" },
      },
      required: ["command"],
    },
  },
  run(args, ctx) {
    const command = args.command;
    if (typeof command !== "string" || command.trim() === "") return Promise.resolve(fail("bash: command is required"));
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS)));
    return new Promise((resolve) => {
      if (ctx.signal?.aborted) return resolve(fail("bash: aborted before start"));
      const win = process.platform === "win32";
      const sh = shellCommand(command);
      // detached gives a process group on POSIX (so the whole tree can be killed); on Windows it would open a console window.
      const child = spawn(sh.file, sh.args, { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"], detached: !win, windowsHide: true, env: shellEnv() });
      let out = "";
      let hardCap = false;
      let timedOut = false;
      let aborted = false;
      const onData = (d: Buffer) => {
        if (out.length < OUTPUT_CAP * 4) out += d.toString("utf8");
        else hardCap = true;
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const killTree = () => {
        if (win) {
          try { if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { try { child.kill(); } catch { /* gone */ } }
          return;
        }
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
      };
      const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
      const onAbort = () => { aborted = true; killTree(); };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (code: number | null, extra?: string) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        let text = cap(out, OUTPUT_CAP);
        if (hardCap) text += "\n[output exceeded buffer; middle dropped]";
        if (timedOut) return resolve({ ok: false, output: `${text}\n[timed out after ${timeoutMs}ms]`.trim() });
        if (aborted) return resolve({ ok: false, output: `${text}\n[aborted]`.trim() });
        if (extra) return resolve({ ok: false, output: `bash: ${extra}` });
        if (win) text = `[${sh.label}]\n${text}`;
        resolve({ ok: code === 0, output: code === 0 ? text : `${text}\n[exit code ${code}]`.trim(), meta: { exitCode: code } });
      };
      child.on("error", (e) => finish(null, e.message));
      child.on("close", (code) => finish(code));
    });
  },
};
