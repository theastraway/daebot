/**
 * Bootstrap the 16 MIND Front Layer templates into the user's tenant.
 *
 * Two strategies, in order of preference:
 *   1. Call `/v1/templates/bootstrap` — single API call, server-side seed.
 *   2. Fall back to `/v1/templates/save` per-template using the local copies
 *      bundled in `templates/front-layer/*.template.md`.
 *
 * Templates teach an agent how to *think* in MIND-shaped nouns: SOUL,
 * IDENTITY, BELIEFS, USER, AGENTS, TOOLS, SENSES, SKILLS, BEHAVIOR, LESSON,
 * DECISION, POLICY, WORKFLOW, PREFERENCE, GOAL, RELATIONSHIP.  Once seeded,
 * any agent can ask "what should I fill out for SOUL?" and the spec comes
 * back from the user's own knowledge graph.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadState } from "./lib/state.mjs";
import { makeClient } from "./lib/mind-api.mjs";
import { info, ok, warn } from "./lib/log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(HERE, "..", "templates", "front-layer");

const FRONT_LAYER_TYPES = [
  "SOUL", "IDENTITY", "BELIEFS", "USER", "AGENTS", "TOOLS", "SENSES",
  "SKILLS", "BEHAVIOR", "LESSON", "DECISION", "POLICY", "WORKFLOW",
  "PREFERENCE", "GOAL", "RELATIONSHIP",
];

export async function seedTemplates({ silent = false } = {}) {
  const state = loadState();
  if (!state.apiKey) {
    throw new Error("No MIND API key on file. Run `mindclaw init` first.");
  }
  const client = makeClient({ baseUrl: state.baseUrl });

  if (!silent) info("Seeding the 16 Front Layer templates into your MIND...");

  try {
    const result = await client.bootstrapTemplates({ apiKey: state.apiKey });
    const count = result?.bootstrapped ?? result?.count ?? FRONT_LAYER_TYPES.length;
    if (!silent) ok(`Seeded ${count} templates.`);
    return { strategy: "server", count };
  } catch (serverErr) {
    if (!silent) warn(`Server bootstrap unavailable (${serverErr.message}); falling back to per-template upload.`);
  }

  let written = 0;
  const available = new Set(readdirSync(TEMPLATES_DIR));
  for (const type of FRONT_LAYER_TYPES) {
    const filename = `${type}.template.md`;
    if (!available.has(filename)) continue;
    const content = readFileSync(join(TEMPLATES_DIR, filename), "utf-8");
    try {
      await client.saveTyped({
        apiKey: state.apiKey,
        type,
        title: `${type} — Template`,
        content,
        tags: ["front-layer", "template", type.toLowerCase()],
      });
      written += 1;
    } catch (e) {
      if (!silent) warn(`Skipped ${type}: ${e.message}`);
    }
  }
  if (!silent) ok(`Seeded ${written} templates via fallback.`);
  return { strategy: "fallback", count: written };
}
