// Copies the agent core (src/, web/, package.json) into desktop/build/agent so electron-builder can ship it as
// extraResources. The agent stays dependency-free; no node_modules are copied. Tests/evals are excluded.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agent = join(here, "..", "..");
const out = join(here, "..", "build", "agent");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const d of ["src", "web"]) cpSync(join(agent, d), join(out, d), { recursive: true, filter: (p) => !p.includes("node_modules") });
cpSync(join(agent, "package.json"), join(out, "package.json"));
console.log("staged agent ->", out);
