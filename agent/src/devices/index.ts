import { spawnSync } from "node:child_process";
import { MSG_UNAVAILABLE } from "./simulator-mac.ts";

// What this machine can attach for later device slices. No agent tool yet: the gateway only reports it.
// `which` is injected in tests. The default looks the binary up on PATH (`xcrun --find simctl` for the simulator).

export type WhichFn = (name: string) => string | boolean | null | undefined;

export interface DeviceSupport {
  terminal: { available: boolean; pty: false; note: string };
  browser: { available: false; note: string };
  ios_simulator: { available: boolean; note: string };
}

function hit(which: WhichFn, name: string): boolean {
  try {
    const v = which(name);
    return typeof v === "string" ? v.trim().length > 0 : !!v;
  } catch {
    return false;
  }
}

/** `simctl` is an xcrun subcommand, not its own binary. */
function defaultWhich(name: string): string | undefined {
  if (name === "simctl" || name === "xcrun simctl") {
    if (process.platform !== "darwin") return undefined;
    const r = spawnSync("xcrun", ["--find", "simctl"], { encoding: "utf8", timeout: 4000, windowsHide: true });
    const out = (r.stdout ?? "").trim();
    return r.status === 0 && out ? out.split(/\r?\n/)[0] : undefined;
  }
  const cmd = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(cmd, [name], { encoding: "utf8", timeout: 3000, windowsHide: true });
  if (r.status !== 0) return undefined;
  const line = (r.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line;
}

function simctlFound(which: WhichFn): boolean {
  return hit(which, "simctl") || hit(which, "xcrun simctl");
}

/**
 * Device support for one platform. `terminal.pty` is always false in this slice (pipes, not a PTY).
 * `browser` is not built. `ios_simulator` is available only on darwin when xcrun simctl is found.
 */
export function deviceSupport(platform: string, which: WhichFn = defaultWhich): DeviceSupport {
  const shell = hit(which, "bash") || hit(which, "pwsh") || hit(which, "powershell") || hit(which, "cmd");
  const mac = platform === "darwin";
  const sim = mac && simctlFound(which);
  return {
    terminal: {
      available: shell,
      pty: false,
      note: shell
        ? "A hidden pipe shell is available (no PTY). The terminal pane can show it read-only; full-screen programs do not work."
        : "No shell was found on this machine, so there is no terminal session to show (no PTY either).",
    },
    browser: { available: false, note: "not built yet" },
    ios_simulator: {
      available: sim,
      note: !mac
        ? MSG_UNAVAILABLE
        : sim
          ? "xcrun simctl is available on this Mac."
          : "xcrun simctl was not found on this Mac.",
    },
  };
}
