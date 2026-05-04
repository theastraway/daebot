#!/usr/bin/env node
/**
 * MINDClaw — OpenClaw with MIND baked in.
 *
 * The `mindclaw` CLI is a thin wrapper around the upstream `openclaw` runtime.
 * It pre-installs the @astramindapp/openclaw-mind plugin, runs first-time
 * onboarding (account or API key), seeds the 16 MIND Front Layer templates
 * into the user's knowledge graph, and then forwards every other command to
 * `openclaw` so muscle memory carries over.
 *
 * Usage:
 *   mindclaw                  # first-run wizard, then opens an interactive session
 *   mindclaw init             # explicit onboarding
 *   mindclaw seed-templates   # bootstrap the 16 typed-doc templates into MIND
 *   mindclaw status           # show MIND connection + plugin state
 *   mindclaw upgrade          # upgrade to the $10/mo Claw tier
 *   mindclaw <anything else>  # forwarded verbatim to openclaw
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { runOnboarding } from "../src/onboard.mjs";
import { ensureRuntime } from "../src/install.mjs";
import { showStatus } from "../src/status.mjs";
import { seedTemplates } from "../src/seed.mjs";
import { openUpgradeCheckout } from "../src/upgrade.mjs";
import { logo, tagline, info, ok, warn, err } from "../src/lib/log.mjs";

const STATE_DIR = join(homedir(), ".mindclaw");
const STATE_FILE = join(STATE_DIR, "state.json");

function isFirstRun() {
  return !existsSync(STATE_FILE);
}

async function forwardToOpenclaw(args) {
  await ensureRuntime();
  const child = spawn("openclaw", args, { stdio: "inherit" });
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  // Help and version are pure — no side effects, no install, no banner.
  if (cmd === "--version" || cmd === "-v") {
    const pkg = await import("../package.json", { with: { type: "json" } });
    process.stdout.write(`mindclaw v${pkg.default.version}\n`);
    return 0;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    logo();
    tagline();
    printHelp();
    return 0;
  }

  // Banner shown for first-run / init / bare invocation / upgrade.
  if (!cmd || cmd === "init" || cmd === "upgrade") {
    logo();
    tagline();
  }

  switch (cmd) {
    case "init":
      await runOnboarding({ force: true });
      return 0;

    case "seed-templates":
      await seedTemplates();
      return 0;

    case "status":
      await showStatus();
      return 0;

    case "upgrade":
      await openUpgradeCheckout();
      return 0;

    case undefined: {
      // Bare `mindclaw`: first-run wizard if needed, then drop into openclaw.
      if (isFirstRun()) {
        info("First run detected — let's get you set up.");
        await ensureRuntime();
        await runOnboarding({ force: false });
        ok("MINDClaw is ready. Launching...");
      }
      return forwardToOpenclaw([]);
    }

    default:
      // Anything we don't own goes straight to the upstream runtime.
      return forwardToOpenclaw([cmd, ...rest]);
  }
}

function printHelp() {
  process.stdout.write(`
MINDClaw — OpenClaw with MIND baked in.

Native commands:
  mindclaw                 First-run wizard, then start an interactive session
  mindclaw init            Re-run onboarding (replaces existing config)
  mindclaw seed-templates  Bootstrap the 16 MIND Front Layer templates into your KG
  mindclaw status          Show MIND connection + plugin state
  mindclaw upgrade         Upgrade to the $10/mo Claw tier (BYO LLM, full KG access)
  mindclaw help            This message

Anything else is forwarded to \`openclaw\`. Examples:
  mindclaw run "Plan my Tuesday"
  mindclaw plugins list
  mindclaw mind search "what did we decide about pricing?"

Docs: https://www.m-i-n-d.ai/mindclaw.html
`);
}

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    err(e?.message ?? String(e));
    if (process.env.MINDCLAW_DEBUG) {
      err(e?.stack ?? "");
    }
    process.exit(1);
  }
);
