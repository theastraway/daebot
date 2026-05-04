/**
 * Ensure the upstream OpenClaw runtime and the @astramindapp/openclaw-mind
 * plugin are installed and discoverable.  Idempotent — safe to call on every
 * invocation.  Uses the user's existing global npm root if available.
 */

import { spawnSync } from "node:child_process";
import { info, ok, warn } from "./lib/log.mjs";

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    encoding: "utf-8",
  });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : null;
}

function npmInstallGlobal(pkg) {
  const args = ["install", "--global", pkg];
  const result = spawnSync("npm", args, { stdio: "inherit" });
  return result.status === 0;
}

function pluginIsInstalled() {
  const r = spawnSync("openclaw", ["plugins", "list"], { encoding: "utf-8" });
  if (r.status !== 0) return false;
  return /openclaw-mind/.test(r.stdout);
}

function installPlugin() {
  const r = spawnSync("openclaw", ["plugins", "install", "@astramindapp/openclaw-mind"], {
    stdio: "inherit",
  });
  return r.status === 0;
}

export async function ensureRuntime() {
  if (!which("openclaw")) {
    info("Installing OpenClaw runtime (one-time)...");
    if (!npmInstallGlobal("openclaw")) {
      throw new Error(
        "Could not install openclaw globally. Run `npm install -g openclaw` manually and retry."
      );
    }
    ok("OpenClaw installed.");
  }

  if (!pluginIsInstalled()) {
    info("Installing MIND plugin (one-time)...");
    if (!installPlugin()) {
      warn(
        "openclaw plugins install failed — try running `openclaw plugins install @astramindapp/openclaw-mind` manually."
      );
    } else {
      ok("MIND plugin installed.");
    }
  }
}
