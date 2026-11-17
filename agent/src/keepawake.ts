// Keep the computer awake while a plain `daebot serve` gateway runs (a Mac mini, a self-host box): the desktop app already
// holds an Electron power assertion ("Keep working in the background"), this is the same for the bare gateway. macOS: a
// `caffeinate -i -w <pid>` child (ends when the gateway exits). Linux: `systemd-inhibit` when it exists. Windows: nothing here
// (the desktop app covers it). Hosted servers never need it. DAEBOT_KEEP_AWAKE=off turns it off.
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface KeepAwake { tool: string; stop(): void }

export function keepAwakeWanted(env: Record<string, string | undefined> = process.env, hosted = false): boolean {
  if (hosted) return false;
  return !/^(0|off|false|no)$/i.test((env.DAEBOT_KEEP_AWAKE ?? "").trim());
}

/** The command for this platform, or undefined when there is nothing to run. */
export function keepAwakeCommand(platform: string, pid: number): { cmd: string; args: string[] } | undefined {
  if (platform === "darwin") return { cmd: "caffeinate", args: ["-i", "-w", String(pid)] };
  if (platform === "linux") return { cmd: "systemd-inhibit", args: ["--what=idle:sleep", "--who=Daebot", "--why=Daebot is working", "--mode=block", "sleep", "infinity"] };
  return undefined;
}

/** Starts the helper. Never throws: a missing tool just means the machine may sleep, which is what it did before. */
export function startKeepAwake(o: { platform?: string; pid?: number; env?: Record<string, string | undefined>; hosted?: boolean; spawnImpl?: typeof nodeSpawn } = {}): KeepAwake | undefined {
  if (!keepAwakeWanted(o.env, o.hosted)) return undefined;
  const c = keepAwakeCommand(o.platform ?? process.platform, o.pid ?? process.pid);
  if (!c) return undefined;
  let child: ChildProcess | undefined;
  try {
    child = (o.spawnImpl ?? nodeSpawn)(c.cmd, c.args, { stdio: "ignore" });
    child.on("error", () => { child = undefined; });
  } catch { return undefined; }
  const stop = () => { try { child?.kill(); } catch { /* already gone */ } child = undefined; };
  process.once("exit", stop);
  return { tool: c.cmd, stop };
}
