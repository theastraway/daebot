// Sign node-pty's Windows binaries after pack. asar is false, so electron-builder's default walk
// does not see files nested under resources/app. signIf is the same hook the Azure Artifact Signing
// config uses: when that branch adds win.azureSignOptions, signIf prefers it. This file does not
// read those env vars and does nothing unless DAEBOT_WIN_SIGN=azure.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PTY_WIN_SIGN_REL } from "../src/lib/pty-pack.mjs";

export async function signPtyWindows(context) {
  if (process.env.DAEBOT_WIN_SIGN !== "azure") return;
  if (!context || context.electronPlatformName !== "win32") return;
  if (typeof context.packager?.signIf !== "function") return;
  const roots = [
    join(context.appOutDir, "resources", "app", "node_modules", "node-pty"),
    join(context.appOutDir, "resources", "app.asar.unpacked", "node_modules", "node-pty"),
  ];
  for (const root of roots) {
    for (const rel of PTY_WIN_SIGN_REL) {
      const file = join(root, rel);
      if (!existsSync(file)) continue;
      await context.packager.signIf(file);
    }
  }
}
