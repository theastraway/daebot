/**
 * Interactive first-run wizard.
 *
 * Two paths:
 *   1. "I have a MIND account" — paste an existing API key
 *   2. "Create one for me" — register via the public MIND endpoint, then
 *      offer to upgrade to the $10/mo Claw tier (BYO LLM, KG-only).
 *
 * The wizard NEVER ships secrets or partner keys.  All HTTP calls hit the
 * public m-i-n-d.ai endpoints the web app uses.  After collecting the key,
 * it writes the OpenClaw plugin config + the ~/.openclaw/.env file so the
 * runtime + plugin are wired without an extra `openclaw mind init` step.
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { loadState, saveState } from "./lib/state.mjs";
import { makeClient } from "./lib/mind-api.mjs";
import { writePluginConfig, writeEnv, envPath, pluginConfigPath } from "./lib/openclaw-config.mjs";
import { googleSignIn } from "./lib/google-oauth.mjs";
import { seedTemplates } from "./seed.mjs";
import { info, ok, warn, err, dim } from "./lib/log.mjs";

async function ask(rl, prompt, { mask = false } = {}) {
  if (!mask) return (await rl.question(prompt)).trim();

  // Minimal masked-input — works on most terminals without extra deps.
  const answer = await new Promise((resolve) => {
    output.write(prompt);
    let buf = "";
    const onData = (data) => {
      const ch = data.toString("utf-8");
      if (ch === "\r" || ch === "\n") {
        input.removeListener("data", onData);
        input.setRawMode?.(false);
        output.write("\n");
        resolve(buf);
        return;
      }
      if (ch === "") process.exit(130); // Ctrl-C
      if (ch === "") {
        buf = buf.slice(0, -1);
        return;
      }
      buf += ch;
      output.write("*");
    };
    input.setRawMode?.(true);
    input.resume();
    input.on("data", onData);
  });
  return answer.trim();
}

function looksLikeMindKey(s) {
  return typeof s === "string" && /^mind_[A-Za-z0-9_-]{16,}$/.test(s);
}

export async function runOnboarding({ force = false } = {}) {
  const state = loadState();
  if (!force && state.apiKey) {
    info("MIND already configured — pass `mindclaw init` to re-run.");
    return state;
  }

  const rl = createInterface({ input, output });
  const baseUrl = process.env.MIND_BASE_URL ?? state.baseUrl ?? "https://www.m-i-n-d.ai";
  const client = makeClient({ baseUrl });

  output.write("\n");
  info("Welcome to MINDClaw — every agent turn, backed by your knowledge graph.\n");
  output.write("Pick how you want to connect:\n");
  output.write("  1) Sign in with Google (browser pop-up)\n");
  output.write("  2) I already have a MIND API key (paste it)\n");
  output.write("  3) Create an account with email + password\n");
  output.write("  4) Create an account and upgrade to Claw ($10/mo, BYO LLM)\n\n");

  const choice = await ask(rl, "Choice [1/2/3/4]: ");
  let apiKey, username, email, tier = "free";
  let upgradeAfter = false;

  try {
    if (choice === "1") {
      info("Opening Google sign-in in your browser...");
      const oauth = await googleSignIn({ baseUrl });
      username = oauth.username;
      const keyResp = await client.issueApiKey({ jwt: oauth.token, name: "MINDClaw" });
      apiKey = keyResp.api_key ?? keyResp.key;
      if (!looksLikeMindKey(apiKey ?? "")) {
        throw new Error("MIND did not return a valid API key after Google sign-in.");
      }
      const me = await client.me({ apiKey }).catch(() => null);
      email = me?.email ?? null;
      tier = me?.subscription?.tier ?? "free";
      ok(`Signed in as ${username}${oauth.isNewUser ? " (new account)" : ""}.`);
    } else if (choice === "2") {
      const key = await ask(rl, "MIND API key (mind_...): ", { mask: true });
      if (!looksLikeMindKey(key)) {
        rl.close();
        throw new Error("That doesn't look like a MIND key. It should start with `mind_`.");
      }
      apiKey = key;
      const me = await client.me({ apiKey }).catch(() => null);
      username = me?.username ?? null;
      email = me?.email ?? null;
      tier = me?.subscription?.tier ?? state.tier ?? "free";
    } else if (choice === "3" || choice === "4") {
      email = await ask(rl, "Email: ");
      username = await ask(rl, "Username (lowercase, no spaces): ");
      const password = await ask(rl, "Password (12+ chars): ", { mask: true });

      info("Creating your MIND account...");
      const reg = await client
        .register({ email, username, password, source: "mindclaw" })
        .catch(async (e) => {
          if (e.status === 409 || /exists/i.test(e.message)) {
            warn("Account exists — logging in instead.");
            return client.login({ username, password });
          }
          throw e;
        });

      const jwt = reg.access_token ?? reg.token ?? reg.jwt;
      if (!jwt) throw new Error("MIND did not return an auth token.");
      const keyResp = await client.issueApiKey({ jwt, name: "MINDClaw" });
      apiKey = keyResp.api_key ?? keyResp.key;
      if (!looksLikeMindKey(apiKey ?? "")) {
        throw new Error("MIND did not return a valid API key.");
      }
      ok(`Account ready (${username}).`);
      upgradeAfter = choice === "4";
    } else {
      rl.close();
      throw new Error("Invalid choice.");
    }

    if (upgradeAfter) {
      try {
        const checkout = await client.upgradeCheckoutUrl({ apiKey, tier: "claw" });
        if (checkout?.url) {
          info(`Opening Stripe checkout for the Claw tier...`);
          await openInBrowser(checkout.url);
          output.write(`If your browser didn't open: ${checkout.url}\n`);
          tier = "claw_pending";
        } else {
          warn("Couldn't start checkout. You can run `mindclaw upgrade` later.");
        }
      } catch (e) {
        warn(`Checkout error (${e.message}). Try \`mindclaw upgrade\` later.`);
      }
    }
  } finally {
    rl.close();
  }

  writePluginConfig({ apiKey, baseUrl });
  writeEnv({ apiKey, baseUrl });
  saveState({
    apiKey,
    baseUrl,
    username,
    email,
    tier,
    onboardedAt: new Date().toISOString(),
  });

  ok(`Wrote MIND config:`);
  dim(`  ${pluginConfigPath()}`);
  dim(`  ${envPath()}`);

  // Best-effort template seed — non-fatal if it fails.
  try {
    await seedTemplates({ silent: false });
  } catch (e) {
    warn(`Template seed skipped: ${e.message}`);
  }

  ok("MIND is ready. Run `mindclaw status` any time.");
  return loadState();
}

async function openInBrowser(url) {
  const { spawn } = await import("node:child_process");
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
}
