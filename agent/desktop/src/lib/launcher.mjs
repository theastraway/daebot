// Builds the spawn plan for the gateway child. This is the ONE place that decides how the gateway runs:
//   1. the per-platform bun-compiled `daebot` binary bundled in the app's resources (packaged builds), else
//   2. a system `node` running child-entry.mjs against the agent source (development), else
//   3. Electron's own Node (ELECTRON_RUN_AS_NODE) running the same entry.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { envForKernelMode } from "./kernel.mjs";

const NODE_CANDIDATES = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];

/** Locate a system `node` >= 22.18 is the caller's concern; here we only find an executable. */
export function findNode({ env = process.env, exists = existsSync, platform = process.platform } = {}) {
  if (env.MINDCLAW_NODE && exists(env.MINDCLAW_NODE)) return env.MINDCLAW_NODE;
  const exe = platform === "win32" ? "node.exe" : "node";
  for (const dir of (env.PATH || "").split(delimiter).filter(Boolean)) {
    const p = join(dir, exe);
    if (exists(p)) return p;
  }
  for (const p of NODE_CANDIDATES) if (exists(p)) return p;
  return null;
}

/** File name of the bundled binary for a platform/arch, matching agent/scripts/build-bin.mjs (daebot-<os>-<arch>[.exe]). */
export function binaryName(platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "windows" : platform;
  return `daebot-${os}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

/** The bundled binary under <resources>/bin, or null (development runs, or a build without it). */
export function findBundledBinary({ resourcesPath, platform = process.platform, arch = process.arch, exists = existsSync } = {}) {
  if (!resourcesPath) return null;
  const p = join(resourcesPath, "bin", binaryName(platform, arch));
  return exists(p) ? p : null;
}

/**
 * @param {object} o
 * @param {string} o.agentRoot  directory holding src/ (the agent core) and web/ (used by the node path)
 * @param {string} o.entry      absolute path of child-entry.mjs (used by the node path)
 * @param {string} o.kernelMode enforced | shadow | off
 * @param {string|null} [o.binaryPath] bundled bun binary; when set it wins over node
 * @param {string|null} o.nodePath system node, or null to fall back to ELECTRON_RUN_AS_NODE with `electronPath`
 * @param {string} o.electronPath process.execPath of Electron
 * @param {Record<string,string|undefined>} o.baseEnv
 * @param {string} [o.mindKey] MIND API key for DAEBOT_BILLING=mind; goes into the child's env only
 * @param {boolean} [o.fake] use the scripted fake runtime (smoke test only; node path)
 * @param {string} [o.tokenPath] override token file (smoke test only; node path)
 * @param {string} [o.home] working directory for the binary (the user's home by default)
 */
export function buildSpawnPlan(o) {
  const env = { ...o.baseEnv, ...envForKernelMode(o.kernelMode), MINDCLAW_AGENT_ROOT: o.agentRoot, MINDCLAW_PARENT_PIPE: "1" };
  if (o.mindKey) { env.DAEBOT_BILLING = "mind"; env.MIND_API_KEY = o.mindKey; }
  if (o.fake) env.MINDCLAW_DESKTOP_FAKE = "1";
  if (o.tokenPath) env.MINDCLAW_DESKTOP_TOKEN_PATH = o.tokenPath;
  let plan;
  if (o.binaryPath && !o.fake) {
    // The compiled binary serves its own embedded web UI; `--port 0` picks a free loopback port and the ready line carries it.
    plan = { command: o.binaryPath, args: ["serve", "--port", "0", "--host", "127.0.0.1"], cwd: o.home ?? homedir() };
  } else {
    let command = o.nodePath;
    if (!command) {
      command = o.electronPath; // Electron's bundled Node (>= 22.18 on Electron 43) runs the entry; no Dock icon.
      env.ELECTRON_RUN_AS_NODE = "1";
    }
    plan = { command, args: [o.entry], cwd: o.agentRoot };
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return { ...plan, env };
}
