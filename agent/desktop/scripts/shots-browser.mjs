// Dev-only. Serves the shop page on 127.0.0.1, then runs the desktop twice under the current display
// (use xvfb-run). Capture goes through the generic shots harness (--daebot-devices-pane=browser).
// The second run is the restart proof: same userData, same origin, still signed in.
// Never prints cookie values.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startPageServer } from "../src/lib/shots-browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const shotsDir = process.argv[2] || join(desktopDir, "..", "..", "..", "shots", "browser");
const electronPath = createRequire(join(desktopDir, "package.json"))("electron");

function run(phase, pageUrl) {
  return new Promise((resolve) => {
    const args = [
      ".",
      "--mindclaw-smoke",
      "--no-sandbox",
      `--daebot-devices-shots=${shotsDir}`,
      "--daebot-devices-pane=browser",
      `--daebot-browser-page=${pageUrl}`,
    ];
    if (phase === "persist") args.push("--daebot-browser-phase=persist");
    const child = spawn(electronPath, args, { cwd: desktopDir, stdio: "inherit", env: { ...process.env, DAEBOT_BROWSER_SHOTS: "1" } });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

mkdirSync(shotsDir, { recursive: true });
const page = await startPageServer();
process.stderr.write(`[shots-browser] page ${page.url}\n`);
let code = 0;
try {
  const capture = await run("capture", page.url);
  if (capture !== 0) code = capture || 1;
  else {
    const persist = await run("persist", page.url);
    if (persist !== 0) code = persist || 1;
  }
} finally {
  await page.close();
}
process.exit(code);
