#!/usr/bin/env node
// Daebot release preflight: prints which signing / notarizing / upload inputs THIS machine has, and fails with exact fix steps.
// Never prints a secret (only "set", "missing", file paths and non-secret ids).
//
//   node scripts/release-preflight.mjs                 # checks what this host can build (Mac host: mac + win + linux)
//   node scripts/release-preflight.mjs --platform mac  # mac | win | linux | all
//   node scripts/release-preflight.mjs --upload        # also require droplet SSH + gh auth (needed to publish)
//   node scripts/release-preflight.mjs --skip-network  # skip the Apple + droplet network probes
//
// Exit 0 = every REQUIRED input for the chosen platforms is present. Exit 1 = something required is missing; fixes are printed.
// The values live in the MIND document "Daebot release signing kit" (query MIND for that title). Windows is unsigned by design
// (DAEBOT_WIN_SIGN=azure is opt-in) so Windows and Linux never fail the preflight.
import { spawnSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { homedir, platform as hostPlatform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const host = hostPlatform();
const want = opt("--platform") || "auto";
const platforms = want === "all" ? ["mac", "win", "linux"] : want === "auto" ? (host === "darwin" ? ["mac", "win", "linux"] : [host === "win32" ? "win" : "linux"]) : [want];
const skipNetwork = flag("--skip-network");
const needUpload = flag("--upload");
const env = process.env;

const rows = []; // { area, name, status: ok|missing|warn|na, detail, fix }
const add = (area, name, status, detail = "", fix = "") => rows.push({ area, name, status, detail, fix });
const run = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: "utf8", timeout: 30000, ...o });
const isSet = (n) => Boolean(env[n] && String(env[n]).length);

// ---- toolchain (every platform)
const nodeMajor = Number(process.versions.node.split(".")[0]);
const nodeMinor = Number(process.versions.node.split(".")[1]);
add("toolchain", "node >= 22.18", nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 18) ? "ok" : "missing", `node ${process.versions.node}`, "Install Node 22.18 or newer (https://nodejs.org or `brew install node@22`).");
const here = fileURLToPath(new URL("..", import.meta.url));
add("toolchain", "dependencies installed (electron-builder)", existsSync(join(here, "node_modules", "electron-builder")) ? "ok" : "missing", here, `cd ${here} && npm install`);
add("toolchain", "bun (gateway binary staging)", run("bun", ["--version"]).status === 0 ? "ok" : "missing", "", "Install bun: curl -fsSL https://bun.sh/install | bash (scripts/stage-bin.mjs compiles the gateway with it).");

// ---- mac
if (platforms.includes("mac")) {
  if (host !== "darwin") {
    add("mac", "macOS host", "missing", `host is ${host}`, "Mac installers can only be built and signed on a Mac.");
  } else {
    const xc = run("xcrun", ["--find", "notarytool"]);
    add("mac", "Xcode command line tools (notarytool, stapler)", xc.status === 0 ? "ok" : "missing", "", "xcode-select --install");

    // code signing: CSC_LINK (+ password) first, else a Developer ID identity in a keychain
    let signOk = false;
    if (isSet("CSC_LINK")) {
      const v = env.CSC_LINK;
      const isFile = !/^[A-Za-z0-9+/=\s]{200,}$/.test(v) && !v.startsWith("http");
      const fileOk = isFile ? existsSync(v.replace(/^~(?=$|\/)/, homedir())) : true;
      const pw = isSet("CSC_KEY_PASSWORD");
      signOk = fileOk && pw;
      add("mac code signing", "CSC_LINK + CSC_KEY_PASSWORD (Developer ID .p12)", signOk ? "ok" : "missing",
        `CSC_LINK ${isFile ? (fileOk ? "-> file exists" : "-> file NOT found") : "set (base64 or url)"}; CSC_KEY_PASSWORD ${pw ? "set" : "NOT set"}`,
        "Set CSC_LINK to the .p12 path (or its base64) and CSC_KEY_PASSWORD to its password. Both are in the MIND doc \"Daebot release signing kit\".");
    } else {
      const f = run("security", ["find-identity", "-v", "-p", "codesigning"]);
      const m = /Developer ID Application: ANTHONY JOSEPH CONTI \(VJ44THJ238\)/.test(f.stdout || "");
      signOk = m;
      add("mac code signing", "Developer ID Application identity in a keychain, or CSC_LINK", m ? "ok" : "missing",
        m ? "found \"Developer ID Application: ANTHONY JOSEPH CONTI (VJ44THJ238)\" in a keychain" : "no Developer ID identity in any keychain and CSC_LINK is not set",
        "Easiest on this machine: export CSC_LINK=<path to Developer ID .p12> CSC_KEY_PASSWORD=<password> (kit: MIND doc \"Daebot release signing kit\"). Or import the .p12 into the login keychain (double-click it).");
    }

    // notarization: API key > apple id > keychain profile
    const keyId = isSet("APPLE_API_KEY_ID"), issuer = isSet("APPLE_API_ISSUER");
    const keyFile = isSet("APPLE_API_KEY") ? existsSync(env.APPLE_API_KEY.replace(/^~(?=$|\/)/, homedir())) : false;
    const keyB64 = isSet("APPLE_API_KEY_BASE64");
    let notarMode = null;
    if ((keyFile || keyB64) && keyId && issuer) {
      notarMode = "App Store Connect API key";
      add("mac notarization", "APPLE_API_KEY (.p8 path) or APPLE_API_KEY_BASE64 + APPLE_API_KEY_ID + APPLE_API_ISSUER", "ok", `${keyFile ? "APPLE_API_KEY file exists" : "APPLE_API_KEY_BASE64 set"}; key id set; issuer set`);
    } else if (isSet("APPLE_API_KEY") || keyB64 || keyId || issuer) {
      add("mac notarization", "App Store Connect API key (partially set)", "missing",
        `APPLE_API_KEY ${isSet("APPLE_API_KEY") ? (keyFile ? "file exists" : "FILE NOT FOUND") : "not set"}; BASE64 ${keyB64 ? "set" : "not set"}; KEY_ID ${keyId ? "set" : "NOT set"}; ISSUER ${issuer ? "set" : "NOT set"}`,
        "Need all of: (APPLE_API_KEY=<path to AuthKey_XXXX.p8> or APPLE_API_KEY_BASE64) + APPLE_API_KEY_ID + APPLE_API_ISSUER. Values: MIND doc \"Daebot release signing kit\".");
    }
    if (!notarMode && isSet("APPLE_ID") && isSet("APPLE_APP_SPECIFIC_PASSWORD") && isSet("APPLE_TEAM_ID")) {
      notarMode = "Apple ID + app-specific password";
      add("mac notarization", "APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID", "ok", "all three set");
    }
    if (!notarMode && xc.status === 0) {
      const p = skipNetwork ? { status: 1 } : run("xcrun", ["notarytool", "history", "--keychain-profile", "MINDNotarize"], { timeout: 25000 });
      if (p.status === 0) {
        notarMode = "keychain profile MINDNotarize";
        add("mac notarization", "notarytool keychain profile MINDNotarize", "ok", "profile present and accepted by Apple");
      }
    }
    if (!notarMode) {
      add("mac notarization", "any notarization credentials", "missing", "no API key, no Apple ID credentials, no working MINDNotarize profile",
        "Set APPLE_API_KEY=<path to .p8> APPLE_API_KEY_ID=<id> APPLE_API_ISSUER=<issuer uuid> (kit: MIND doc \"Daebot release signing kit\"). scripts/notarize.cjs uses them in preference to the keychain profile.");
    }
    if (isSet("CSC_LINK") && env.CSC_IDENTITY_AUTO_DISCOVERY !== "false") add("mac code signing", "CSC_IDENTITY_AUTO_DISCOVERY=false", "warn", "not set: electron-builder may also look at keychain certs on this machine", "export CSC_IDENTITY_AUTO_DISCOVERY=false so only the CSC_LINK .p12 signs the build.");
    const signSwitch = env.DAEBOT_SIGN === "1";
    add("mac", "DAEBOT_SIGN=1 for the build", signSwitch ? "ok" : "warn", signSwitch ? "set" : "not set: the Mac build will be UNSIGNED (adhoc) and must not be published", "export DAEBOT_SIGN=1 (and DAEBOT_NOTARIZE_STRICT=1 for a release) before `npm run dist:mac`.");
  }
}

// ---- windows / linux (informational: unsigned is the default and always builds)
if (platforms.includes("win")) {
  const az = env.DAEBOT_WIN_SIGN === "azure";
  add("windows", "installer signing", "ok", az ? "DAEBOT_WIN_SIGN=azure (opt-in Azure Artifact Signing; needs 7 Azure vars, see agent/DEPLOY.md)" : "unsigned (default, builds anywhere, SmartScreen asks once). Nothing required.");
  if (az) {
    const need = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "DAEBOT_AZURE_ENDPOINT", "DAEBOT_AZURE_ACCOUNT", "DAEBOT_AZURE_PROFILE", "DAEBOT_WIN_PUBLISHER"].filter((n) => !isSet(n));
    add("windows", "Azure signing variables", need.length ? "missing" : "ok", need.length ? `missing: ${need.join(", ")}` : "all 7 set", "Set the missing variables, or unset DAEBOT_WIN_SIGN to build unsigned.");
  }
}
if (platforms.includes("linux")) add("linux", "AppImage + deb signing", "ok", "unsigned by design. Nothing required.");

// ---- upload / publish (only required with --upload)
{
  const st = needUpload ? "missing" : "warn";
  const candidates = [env.DAEBOT_SSH_KEY, join(homedir(), ".ssh", "droplet_170_key"), join(homedir(), ".ssh", "dae-daebot-release"), join(homedir(), ".ssh", "daebot_release_ed25519")].filter(Boolean);
  const key = candidates.find((k) => { try { return statSync(k).isFile(); } catch { return false; } });
  if (!key) {
    add("publish", "SSH key for root@45.55.204.209", st, "none of DAEBOT_SSH_KEY, ~/.ssh/droplet_170_key, ~/.ssh/dae-daebot-release found",
      "Put the droplet key at ~/.ssh/droplet_170_key (chmod 600) or set DAEBOT_SSH_KEY=<path>. Key location: MIND doc \"Daebot release signing kit\".");
  } else if (skipNetwork) {
    add("publish", "SSH key for root@45.55.204.209", "ok", `${key} (not probed: --skip-network)`);
  } else {
    const s = run("ssh", ["-i", key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", "root@45.55.204.209", "test -d /var/www/evie/download/daebot && echo reachable"]);
    const ok = s.status === 0 && /reachable/.test(s.stdout || "");
    add("publish", "SSH to droplet 45.55.204.209 and /var/www/evie/download/daebot", ok ? "ok" : st, ok ? `via ${key}` : `ssh failed with ${key}`, "Check the key is the droplet key (MIND doc \"Daebot release signing kit\"), chmod 600, and that your IP can reach port 22.");
  }
  const gh = run("gh", ["auth", "status"]);
  add("publish", "gh CLI logged in (releases.json PR)", gh.status === 0 ? "ok" : st, "", "gh auth login (account needs push to theastraway/daebot).");
}

// ---- report
const icon = { ok: "OK     ", missing: "MISSING", warn: "WARN   ", na: "n/a    " };
let area = "";
for (const r of rows) {
  if (r.area !== area) { area = r.area; console.log(`\n[${area}]`); }
  console.log(`  ${icon[r.status]} ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
const missing = rows.filter((r) => r.status === "missing");
console.log(`\nHost: ${host}; platforms checked: ${platforms.join(", ")}${needUpload ? "; publish inputs required" : ""}`);
if (missing.length) {
  console.log(`\nPREFLIGHT FAILED: ${missing.length} required input(s) missing. Fix steps:`);
  missing.forEach((r, i) => console.log(`  ${i + 1}. ${r.name}\n     -> ${r.fix}`));
  console.log("\nValues for every name above live in the MIND document \"Daebot release signing kit\". Then re-run this script.");
  process.exit(1);
}
console.log("\nPREFLIGHT OK: this machine has every required input.");
