// electron-builder configuration for Daebot (Mac universal, Windows x64 + arm64, Linux x64).
// Unsigned by default, so local and CI builds never touch the keychain. The same DAEBOT_SIGN=1 switch turns on
// Developer ID signing, hardened runtime and the MINDNotarize notarization hook (see scripts/notarize.cjs) on the
// signing Mac. Windows is unsigned unless DAEBOT_WIN_SIGN=azure (see azureSignOptions below).
// node-pty is rebuilt for Electron's ABI (npmRebuild + buildDependenciesFromSource). Windows signing of conpty.dll,
// OpenConsole.exe and winpty goes through scripts/sign-pty-win.mjs (packager.signIf), and only when DAEBOT_WIN_SIGN=azure.
import { macPtyBinaries, PTY_ASAR_UNPACK, PTY_WIN_SIGN_EXTS, PTY_X64_ARCH_FILES } from "./src/lib/pty-pack.mjs";
import { signPtyWindows } from "./scripts/sign-pty-win.mjs";

const sign = process.env.DAEBOT_SIGN === "1";

// Windows signing is OPT-IN: unsigned Windows installers are the default and build on any machine (including cross-built from a Mac).
// Set DAEBOT_WIN_SIGN=azure on a Windows signing host to sign through Azure Artifact Signing (formerly Trusted Signing).
// Nothing else turns it on (DAEBOT_SIGN=1 is the Mac Developer ID switch only), and an unset DAEBOT_WIN_SIGN never blocks a build.
// electron-builder signs the app, its exes and the NSIS installer through the TrustedSigning PowerShell module (it installs it itself).
// Azure sign-in comes only from the environment, never from this file: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
// (an Entra ID app registration with the "Artifact Signing Certificate Profile Signer" role on the signing account).
// The account details are environment variables too:
//   DAEBOT_AZURE_ENDPOINT   regional endpoint of the signing account, e.g. https://eus.codesigning.azure.net/
//   DAEBOT_AZURE_ACCOUNT    Artifact Signing account name
//   DAEBOT_AZURE_PROFILE    certificate profile name (Public Trust)
//   DAEBOT_WIN_PUBLISHER    publisher name exactly as on the certificate (the validated legal name)
const winSignEnv = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "DAEBOT_AZURE_ENDPOINT", "DAEBOT_AZURE_ACCOUNT", "DAEBOT_AZURE_PROFILE", "DAEBOT_WIN_PUBLISHER"];
const buildingWin = process.argv.includes("--win") || process.argv.includes("-w");
const winSign = process.env.DAEBOT_WIN_SIGN === "azure";
if (winSign && buildingWin) {
  const missing = winSignEnv.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`DAEBOT_WIN_SIGN=azure Windows build is missing: ${missing.join(", ")} (unset DAEBOT_WIN_SIGN for an unsigned Windows build)`);
}
if (buildingWin && !winSign) {
  // A Mac Developer ID .p12 in CSC_LINK must never be applied to Windows binaries: electron-builder would try to sign them with it and fail.
  for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]) delete process.env[name];
}
const azureSignOptions = winSign && buildingWin
  ? {
      publisherName: process.env.DAEBOT_WIN_PUBLISHER,
      endpoint: process.env.DAEBOT_AZURE_ENDPOINT,
      codeSigningAccountName: process.env.DAEBOT_AZURE_ACCOUNT,
      certificateProfileName: process.env.DAEBOT_AZURE_PROFILE,
    }
  : null;

export default {
  appId: "ai.daebot.desktop",
  productName: "Daebot",
  copyright: "Copyright © 2026 Astra AI",
  directories: { output: "dist", buildResources: "build-resources" },
  files: ["src/**/*", "package.json", "node_modules/node-pty/**/*"],
  npmRebuild: true,
  buildDependenciesFromSource: true,
  asarUnpack: PTY_ASAR_UNPACK,
  // Auto-update feed (electron-updater, generic provider): the installers and the latest*.yml files live in this one folder.
  // Windows on ARM is built with DAEBOT_FEED_CHANNEL=latest-arm64 (-> latest-arm64.yml) so it does not collide with the x64 latest.yml;
  // the app picks its channel by process.arch (src/lib/updater.mjs). Mac -> latest-mac.yml (zip + dmg), Linux -> latest-linux.yml.
  publish: [{ provider: "generic", url: "https://download.m-i-n-d.ai/download/daebot/", channel: process.env.DAEBOT_FEED_CHANNEL || "latest" }],
  asar: false,
  // The gateway is a bun-compiled binary that embeds the web UI (scripts/stage-bin.mjs puts it in build/bin).
  // Each platform ships only its own binaries: both Mac arches (a universal app runs on either), the matching one on Windows/Linux.
  extraResources: [],
  mac: {
    category: "public.app-category.developer-tools",
    icon: "build-resources/icon.icns",
    target: [{ target: "dmg", arch: ["universal"] }, { target: "zip", arch: ["universal"] }],
    artifactName: "Daebot-${version}-mac-${arch}.${ext}",
    hardenedRuntime: true,
    // electron-builder would notarize on its own whenever APPLE_API_KEY* / APPLE_ID* are in the environment; scripts/notarize.cjs (afterSign) is the one
    // notarize-and-staple path, so the built-in one is off to avoid submitting the same app to Apple twice.
    notarize: false,
    // The text macOS shows in its microphone and Calendar prompts. The Calendar helper runs inside the app, so the prompt is Daebot's own.
    extendInfo: {
      NSScreenCaptureUsageDescription: "Daebot looks at your screen while you have Let Daebot watch my screen turned on, or when you ask it to take a screenshot or operate your screen, so it can see what you see.",
      NSAppleEventsUsageDescription: "Daebot types and presses keys in your apps through System Events only when you ask it to operate your screen, and you approve each action.",
      NSMicrophoneUsageDescription: "Daebot uses the microphone when you press the mic button or turn on hands-free voice.",
      NSCalendarsUsageDescription: "Daebot reads and adds events in your Apple Calendar when you ask it to.",
      NSCalendarsFullAccessUsageDescription: "Daebot reads and adds events in your Apple Calendar when you ask it to.",
    },
    gatekeeperAssess: false,
    entitlements: "build-resources/entitlements.mac.plist",
    entitlementsInherit: "build-resources/entitlements.mac.plist",
    // Signing identity by name. With CSC_LINK + CSC_KEY_PASSWORD (the Developer ID .p12, path or base64) electron-builder imports the .p12 into a
    // throwaway keychain and looks the name up only there, so any Mac can sign; CSC_IDENTITY_AUTO_DISCOVERY=false keeps the machine's own keychain out.
    // Without CSC_LINK it uses the login keychain identity.
    identity: sign ? "ANTHONY JOSEPH CONTI (VJ44THJ238)" : null,
    // Signs by certificate hash out of the CSC_LINK keychain, so a same-named older cert in the machine's own keychain cannot make codesign ambiguous.
    sign: sign ? "scripts/mac-sign.cjs" : undefined,
    // daebot-calendar is the universal EventKit helper for Apple Calendar (scripts/build-calendar-helper.mjs); it is signed with the app.
    extraResources: [{ from: "build/bin", to: "bin", filter: ["daebot-darwin-*", "daebot-calendar"] }],
    // Both thin gateway binaries (and the already-universal Calendar helper) are identical in the arm64 and x64 halves of the universal app.
    // The gateways must not be merged into one fat Mach-O (bun finds its embedded payload at the end of its own file), so all are copied through as they are.
    // Prebuilt darwin pty.node and spawn-helper are byte-identical in both arch folders, so the universal merge must not lipo them.
    // build/Release differs per arch (electron-rebuild) and is merged. spawn-helper is signed with the app (hardened runtime).
    x64ArchFiles: PTY_X64_ARCH_FILES,
    mergeASARs: true,
    binaries: macPtyBinaries(false),
  },
  dmg: { title: "Daebot", sign },
  afterSign: sign ? "scripts/notarize.cjs" : undefined,
  afterPack: (context) => signPtyWindows(context),
  win: {
    icon: "build-resources/icon.ico",
    target: [{ target: "nsis", arch: ["x64", "arm64"] }],
    artifactName: "Daebot-Setup-${version}-${arch}.${ext}",
    extraResources: [{ from: "build/bin", to: "bin", filter: ["daebot-windows-${arch}.exe"] }],
    // Unsigned unless DAEBOT_WIN_SIGN=azure (see azureSignOptions above). .dll and .node cover ConPTY and the pty addon when signing.
    azureSignOptions,
    ...(winSign ? { signExts: PTY_WIN_SIGN_EXTS } : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Daebot",
  },
  linux: {
    icon: "build-resources/icon.png",
    category: "Development",
    syncDesktopName: true,
    target: [{ target: "AppImage", arch: ["x64"] }, { target: "deb", arch: ["x64"] }],
    artifactName: "Daebot-${version}-linux-${arch}.${ext}",
    maintainer: "Astra AI <anthony@theastraway.com>",
    synopsis: "Daebot, a private agent that checks every claim",
    extraResources: [{ from: "build/bin", to: "bin", filter: ["daebot-linux-${arch}"] }],
  },
  deb: { depends: ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0"] },
};
