/**
 * `mindclaw status` — health check.
 * Reports plugin/runtime presence, MIND connection, account tier, template seed.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { loadState } from "./lib/state.mjs";
import { pluginConfigPath, envPath } from "./lib/openclaw-config.mjs";
import { makeClient } from "./lib/mind-api.mjs";
import { info, ok, warn, err, dim } from "./lib/log.mjs";

function checkBin(name) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [name]);
  return r.status === 0;
}

export async function showStatus() {
  const state = loadState();

  process.stdout.write("\nMINDClaw status\n───────────────\n");

  if (checkBin("openclaw")) ok("openclaw runtime: installed");
  else err("openclaw runtime: missing — run `mindclaw init`");

  const pluginCheck = spawnSync("openclaw", ["plugins", "list"], { encoding: "utf-8" });
  if (pluginCheck.status === 0 && /openclaw-mind/.test(pluginCheck.stdout)) {
    ok("MIND plugin: installed");
  } else {
    warn("MIND plugin: not detected");
  }

  if (existsSync(pluginConfigPath())) ok(`plugin config: ${pluginConfigPath()}`);
  else warn(`plugin config: missing (${pluginConfigPath()})`);

  if (existsSync(envPath())) ok(`env file: ${envPath()}`);
  else warn(`env file: missing (${envPath()})`);

  if (state.apiKey) {
    const client = makeClient({ baseUrl: state.baseUrl });
    try {
      const me = await client.me({ apiKey: state.apiKey });
      ok(`MIND account: ${me?.username ?? state.username ?? "(unknown)"}`);
      const tier = me?.subscription?.tier ?? state.tier ?? "?";
      const credits = me?.subscription?.credits_balance;
      const storage = me?.subscription?.storage_used_mb;
      info(`tier: ${tier}${credits != null ? `   credits: ${credits}` : ""}${storage != null ? `   storage: ${storage} MB` : ""}`);
    } catch (e) {
      warn(`MIND connection failed: ${e.message}`);
    }
  } else {
    warn("no MIND API key configured — run `mindclaw init`");
  }

  if (state.templatesSeededAt) ok(`templates seeded: ${state.templatesSeededAt}`);
  else dim("templates not yet seeded — run `mindclaw seed-templates`");

  process.stdout.write("\n");
}
