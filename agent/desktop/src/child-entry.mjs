// Entry run by the system `node` (or Electron-as-node) in development and when no bundled binary exists: starts the Daebot gateway
// on a random localhost port and prints ONE JSON line to stdout: {"mindclaw":"ready","url":...,"token":...}. The token goes only
// over this pipe. Packaged apps run the bun-compiled binary (`daebot serve --port 0`) instead; both behave the same:
//   - sessions persist to the file store (DATA_DIR, default ~/.daebot/data)
//   - DAEBOT_BILLING=mind bills the user's MIND account (MIND_API_KEY from the desktop sign-in), so no OpenRouter key is needed
//   - local mode: bash/fs tools stay available and the kernel is enforced (MINDCLAW_KERNEL / MINDCLAW_SHADOW from the menu)
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
  let sessionStore;
  if (process.env.MINDCLAW_DESKTOP_FAKE === "1") {
    const { createFakeRuntime } = await imp("src/gateway/dev-fake.ts");
    runtime = createFakeRuntime();
  } else {
    const { loadConfig } = await imp("src/config.ts");
    cfg = loadConfig();
    if (cfg.billing === "mind") {
      if (!cfg.mindApiKey) {
        say({ state: "error", data: { message: "Daebot needs your MIND API key. Open the app again to sign in." } });
        process.exit(1);
      }
    } else if (!cfg.openrouterKey) {
      say({ state: "error", data: { message: "Sign in with a MIND API key, or set OPENROUTER_API_KEY (env or ~/.daebot/config.json)." } });
      process.exit(1);
    }
    const { createRuntime } = await imp("src/runtime.ts");
    const { createFileStore, dataDir } = await imp("src/persist.ts");
    sessionStore = createFileStore(dataDir());
    const credits = cfg.billing === "mind" ? new (await imp("src/provider/mind.ts")).MindCredits({ mindBaseUrl: cfg.mindBaseUrl }) : undefined;
    runtime = createRuntime(cfg, { store: sessionStore, credits });
  }
  const gw = await startGateway({ runtime, cfg, port: 0, host: "127.0.0.1", sessionStore, tokenPath: process.env.MINDCLAW_DESKTOP_TOKEN_PATH || undefined });
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
