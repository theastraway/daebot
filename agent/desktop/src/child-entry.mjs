// Entry run by the system `node` (or Electron-as-node): starts the MINDClaw gateway on a random localhost port and
// prints ONE JSON line to stdout: {"mindclaw":"ready","url":...,"token":...}. The token goes only over this pipe.
// Imports the agent's TypeScript directly (Node >= 22.18 strips types by default).
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = process.env.MINDCLAW_AGENT_ROOT || join(fileURLToPath(new URL("..", import.meta.url)), "..");
const imp = (rel) => import(pathToFileURL(join(root, rel)).href);
const say = (o) => process.stdout.write(JSON.stringify({ mindclaw: o.state, ...o.data }) + "\n");

try {
  const { startGateway } = await imp("src/gateway/index.ts");
  let runtime;
  let cfg;
  if (process.env.MINDCLAW_DESKTOP_FAKE === "1") {
    const { createFakeRuntime } = await imp("src/gateway/dev-fake.ts");
    runtime = createFakeRuntime();
  } else {
    const { loadConfig } = await imp("src/config.ts");
    cfg = loadConfig();
    if (!cfg.openrouterKey) {
      say({ state: "error", data: { message: "OPENROUTER_API_KEY is not set (env or ~/.mindclaw/config.json)." } });
      process.exit(1);
    }
    const { createRuntime } = await imp("src/runtime.ts");
    runtime = createRuntime(cfg);
  }
  const gw = await startGateway({ runtime, cfg, port: 0, host: "127.0.0.1", tokenPath: process.env.MINDCLAW_DESKTOP_TOKEN_PATH || undefined });
  say({ state: "ready", data: { url: gw.url, token: gw.token } });
  const shutdown = () => { gw.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 2500).unref(); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // If the parent dies without signalling us, our stdin pipe closes; do not linger as an orphan.
  process.stdin.on("end", shutdown);
  process.stdin.resume();
} catch (e) {
  say({ state: "error", data: { message: String(e?.message ?? e).slice(0, 300) } });
  process.exit(1);
}
