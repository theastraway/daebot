// Builds the spawn plan for the gateway child. This is the ONE place that decides how the gateway runs; swap it to
// run in-process or via `bun`/a compiled binary later without touching the lifecycle code.
import { existsSync } from "node:fs";
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

/**
 * @param {object} o
 * @param {string} o.agentRoot  directory holding src/ (the agent core) and web/
 * @param {string} o.entry      absolute path of child-entry.mjs
 * @param {string} o.kernelMode enforced | shadow | off
 * @param {string|null} o.nodePath system node, or null to fall back to ELECTRON_RUN_AS_NODE with `electronPath`
 * @param {string} o.electronPath process.execPath of Electron
 * @param {Record<string,string|undefined>} o.baseEnv
 * @param {boolean} [o.fake] use the scripted fake runtime (smoke test only)
 * @param {string} [o.tokenPath] override token file (smoke test only)
 */
export function buildSpawnPlan(o) {
  const env = { ...o.baseEnv, ...envForKernelMode(o.kernelMode), MINDCLAW_AGENT_ROOT: o.agentRoot };
  if (o.fake) env.MINDCLAW_DESKTOP_FAKE = "1";
  if (o.tokenPath) env.MINDCLAW_DESKTOP_TOKEN_PATH = o.tokenPath;
  let command = o.nodePath;
  if (!command) {
    command = o.electronPath; // Electron's bundled Node (>= 22.18 on Electron 43) runs the entry; no Dock icon.
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return { command, args: [o.entry], env, cwd: o.agentRoot };
}
