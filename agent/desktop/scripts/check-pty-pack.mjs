// Assert a packed app directory contains the node-pty native module and the helpers for that target.
//   node scripts/check-pty-pack.mjs <resources/app dir> <linux-x64|darwin-x64|darwin-arm64|darwin-universal|win32-x64|win32-arm64>
import { checkPtyPack } from "../src/lib/pty-pack.mjs";

const [appDir, target] = process.argv.slice(2);
if (!appDir || !target) {
  process.stderr.write("usage: node scripts/check-pty-pack.mjs <app-dir> <target>\n");
  process.exit(2);
}
const result = checkPtyPack(appDir, target);
if (!result.ok) {
  process.stderr.write(result.missing.join("\n") + "\n");
  process.exit(1);
}
process.stdout.write(`pty pack ok for ${target}\n`);
