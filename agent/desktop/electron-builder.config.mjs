// electron-builder configuration for Daebot (Mac universal, Windows x64 + arm64, Linux x64).
// Unsigned by default, so local and CI builds never touch the keychain. DAEBOT_SIGN=1 turns on Developer ID signing,
// hardened runtime and the MINDNotarize notarization hook (see scripts/notarize.cjs); run it only on the signing Mac.
const sign = process.env.DAEBOT_SIGN === "1";

export default {
  appId: "ai.daebot.desktop",
  productName: "Daebot",
  copyright: "Copyright © 2026 Astra AI",
  directories: { output: "dist", buildResources: "build-resources" },
  files: ["src/**/*", "package.json"],
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
    // The text macOS shows in its microphone and Calendar prompts. The Calendar helper runs inside the app, so the prompt is Daebot's own.
    extendInfo: {
      NSMicrophoneUsageDescription: "Daebot uses the microphone when you press the mic button or turn on hands-free voice.",
      NSCalendarsUsageDescription: "Daebot reads and adds events in your Apple Calendar when you ask it to.",
      NSCalendarsFullAccessUsageDescription: "Daebot reads and adds events in your Apple Calendar when you ask it to.",
    },
    gatekeeperAssess: false,
    entitlements: "build-resources/entitlements.mac.plist",
    entitlementsInherit: "build-resources/entitlements.mac.plist",
    identity: sign ? "ANTHONY JOSEPH CONTI (VJ44THJ238)" : null,
    // daebot-calendar is the universal EventKit helper for Apple Calendar (scripts/build-calendar-helper.mjs); it is signed with the app.
    extraResources: [{ from: "build/bin", to: "bin", filter: ["daebot-darwin-*", "daebot-calendar"] }],
    // Both thin gateway binaries (and the already-universal Calendar helper) are identical in the arm64 and x64 halves of the universal app.
    // The gateways must not be merged into one fat Mach-O (bun finds its embedded payload at the end of its own file), so all are copied through as they are.
    x64ArchFiles: "Contents/Resources/bin/*",
  },
  dmg: { title: "Daebot", sign },
  afterSign: sign ? "scripts/notarize.cjs" : undefined,
  win: {
    icon: "build-resources/icon.ico",
    target: [{ target: "nsis", arch: ["x64", "arm64"] }],
    artifactName: "Daebot-Setup-${version}-${arch}.${ext}",
    extraResources: [{ from: "build/bin", to: "bin", filter: ["daebot-windows-${arch}.exe"] }],
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
