/**
 * Read/write the OpenClaw runtime config so the @astramindapp/openclaw-mind
 * plugin picks up the MIND API key the wrapper just collected.
 *
 * OpenClaw stores its plugin config under ~/.openclaw/plugins/<plugin>.yaml
 * and additionally accepts secrets via the MIND_API_KEY env var.  We write
 * BOTH so the plugin works even if the user's shell doesn't load the env.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PLUGIN_ID = "openclaw-mind";
const OPENCLAW_DIR = join(homedir(), ".openclaw");
const PLUGINS_DIR = join(OPENCLAW_DIR, "plugins");
const PLUGIN_CONFIG = join(PLUGINS_DIR, `${PLUGIN_ID}.yaml`);
const ENV_FILE = join(OPENCLAW_DIR, ".env");

function ensureDirs() {
  if (!existsSync(OPENCLAW_DIR)) mkdirSync(OPENCLAW_DIR, { recursive: true });
  if (!existsSync(PLUGINS_DIR)) mkdirSync(PLUGINS_DIR, { recursive: true });
}

function yamlEscape(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

export function writePluginConfig({ apiKey, baseUrl }) {
  ensureDirs();
  const cfg = [
    `# Written by mindclaw — do not edit by hand. Re-run \`mindclaw init\` to refresh.`,
    `apiKey: \${MIND_API_KEY}`,
    baseUrl ? `baseUrl: ${yamlEscape(baseUrl)}` : null,
    `autoCapture: true`,
    `autoRecall: true`,
    `topK: 10`,
    `searchThreshold: 0.5`,
    `queryMode: hybrid`,
    `enableMindsense: true`,
    `enableLifeIntegration: true`,
    `enableCrmLogging: true`,
    `skills:`,
    `  triage:`,
    `    enabled: true`,
    `  recall:`,
    `    enabled: true`,
    `    strategy: smart`,
    `  dream:`,
    `    enabled: true`,
    `    auto: true`,
    `  emotionalEncoding:`,
    `    enabled: true`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(PLUGIN_CONFIG, cfg, { mode: 0o600 });
}

export function writeEnv({ apiKey, baseUrl }) {
  ensureDirs();
  let body = "";
  if (existsSync(ENV_FILE)) body = readFileSync(ENV_FILE, "utf-8");

  const lines = body.split("\n").filter((line) => {
    if (line.startsWith("MIND_API_KEY=")) return false;
    if (line.startsWith("MIND_BASE_URL=")) return false;
    return true;
  });
  lines.push(`MIND_API_KEY=${apiKey}`);
  if (baseUrl) lines.push(`MIND_BASE_URL=${baseUrl}`);
  writeFileSync(ENV_FILE, lines.filter(Boolean).join("\n") + "\n", { mode: 0o600 });
}

export function pluginConfigPath() {
  return PLUGIN_CONFIG;
}

export function envPath() {
  return ENV_FILE;
}
