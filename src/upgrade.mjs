/**
 * `mindclaw upgrade` — opens Stripe checkout for the $10/mo Claw tier.
 * BYO LLM means the user pays MIND for the knowledge-graph layer only;
 * inference happens through whatever MCP host they're using.
 */

import { spawn } from "node:child_process";

import { loadState } from "./lib/state.mjs";
import { makeClient } from "./lib/mind-api.mjs";
import { info, ok, warn, err } from "./lib/log.mjs";

export async function openUpgradeCheckout() {
  const state = loadState();
  if (!state.apiKey) {
    err("No MIND account configured — run `mindclaw init` first.");
    return;
  }

  const client = makeClient({ baseUrl: state.baseUrl });
  try {
    const checkout = await client.upgradeCheckoutUrl({ apiKey: state.apiKey, tier: "claw" });
    if (!checkout?.url) {
      warn("MIND did not return a checkout URL. Try the web app: https://www.m-i-n-d.ai/billing");
      return;
    }
    info("Opening Stripe checkout in your browser...");
    openBrowser(checkout.url);
    process.stdout.write(`If your browser didn't open: ${checkout.url}\n`);
    ok("Once payment completes, your tier upgrades automatically.");
  } catch (e) {
    err(`Could not start checkout: ${e.message}`);
    process.stdout.write("Fall back to https://www.m-i-n-d.ai/billing\n");
  }
}

function openBrowser(url) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
}
