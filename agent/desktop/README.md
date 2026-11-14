# Daebot Desktop

Thin Electron shell around the Daebot gateway and its web UI (`agent/web/`). Mac (universal), Windows (x64 + arm64) and Linux (x64).
It never imports the agent loop, provider or kernel: it starts the gateway as a child process and shows the web UI.

## How it works
- `src/main.mjs` is glue; every decision lives in `src/lib/*` (unit-tested).
- **Gateway child** (`src/lib/launcher.mjs` is the ONE function to swap). Packaged apps run the bun-compiled `daebot` binary from
  `resources/bin/daebot-<os>-<arch>` (`daebot serve --port 0 --host 127.0.0.1`; it embeds the web UI, so no node and no source tree
  are needed). Development (no bundled binary) runs `src/child-entry.mjs` with the system `node`
  (`MINDCLAW_NODE`, then `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`), falling back to Electron's bundled Node
  (`ELECTRON_RUN_AS_NODE`, Node 24 with type stripping). The entry imports `agent/src/gateway/index.ts` and starts on a random
  loopback port. Both paths print one JSON line with the real port and the token (`{"mindclaw":"ready",...}` from the entry file,
  `{"mindclawGateway":{...}}` from the binary). The token only travels over that pipe and
  is never logged. Both persist sessions to `~/.daebot/data`, bill the user's MIND account (`DAEBOT_BILLING=mind`) and keep the
  local bash/fs tools with the kernel enforced.
- Main waits for `/health`, then loads `http://127.0.0.1:<port>/?token=...` (token in the query once; the web UI scrubs it).
- Window: `contextIsolation`, no `nodeIntegration`, `sandbox`, in-memory session partition, all permission requests denied,
  navigation limited to the exact gateway origin; http(s)/mailto links open in the default browser; everything else is dropped.
- Menu bar item: Show/Hide, New Session, Kernel mode (Enforced / Shadow / Off), Sign out of MIND, Quit. Kernel mode restarts the child with
  `MINDCLAW_KERNEL` / `MINDCLAW_SHADOW` and is remembered in `desktop.json`.
- Confirm notifications: main opens its own WebSocket to `/ws`, resumes each live session by id (which only subscribes) and
  raises a native notification for `confirm` events while the window is hidden or unfocused. No web/ changes needed.
- Optional hook: `window.mindclawDesktop.notify({ title, body })` (validated, rate limited, honored only from the gateway origin).
- Quit stops only the child it spawned (SIGTERM, SIGKILL after 3s). The child also exits if its stdin closes.
- Keep working in the background (tray checkbox, `keepWorking`, default on): closing the window only hides it (the "close" handler calls
  `preventDefault` + `hide`; only Quit, sign-out or an update install stops the app), and hiding or trimming the idle renderer never aborts a
  turn, because the gateway is a separate process whose runs are server-owned and stop only on an explicit abort. While the setting is on the
  app holds a `powerSaveBlocker("prevent-app-suspension")` so the machine does not idle-sleep mid-job; it changes no OS security setting.
  The agent's `process` tool (start/status/tail/kill) runs long jobs as children of the gateway. While the screen is LOCKED those keep running
  (plain processes, not tied to the session desktop), but screen capture and mouse/keyboard injection do not work (they need an unlocked,
  interactive desktop). Background processes stop when the gateway quits (Quit, sign-out, update install), not when the window closes.
- Single-instance lock; Cmd+N new session, Cmd+W hide window, Cmd+Q quit; dark/light follows the system.

## Home folder: `~/.daebot`
Everything Daebot keeps on the machine (config, sign-in, accounts, chats) lives in `~/.daebot` (Windows: `%USERPROFILE%\.daebot`). `DAEBOT_HOME` (or the older `MINDCLAW_DESKTOP_HOME`) overrides it. An install from before the rename has `~/.mindclaw`: on first start it is renamed to `~/.daebot` once and `~/.mindclaw` is left as a link to it, so an older Daebot still finds its files. If the rename cannot be done (another disk, a locked file on Windows) that run keeps using `~/.mindclaw` and tries again next time; when both folders exist `~/.daebot` is used and `~/.mindclaw` is never touched. Code: `src/lib/home.mjs` (mirrors `agent/src/home.ts`).

## Config: `~/.daebot/desktop.json`
```json
{ "shortcut": "CommandOrControl+Shift+Space", "kernelMode": "enforced", "idleTrimSeconds": 300, "keepWorking": true }
```
`shortcut` is the global Summon Daebot shortcut, an Electron accelerator (`null` disables it); the default is Cmd+Shift+Space on a Mac and Ctrl+Shift+Space elsewhere, and it is rebindable in the app under Keyboard shortcuts. The hold-to-talk keys (Right Option/Alt = Dictation, Right Command/Ctrl = Voice) work while the Daebot window is focused: Electron has no global solo-modifier hook without native modules. Window bounds live in `~/.daebot/desktop-state.json`.
Credentials: see Sign-in below. Without any usable key the gateway child reports why and the window shows a plain error page.

## Screen watching ("Let Daebot watch my screen")

Off by default. The user turns it on in the account menu (or the tray); `watchScreen` in `desktop.json` remembers the choice. While it is on the tray icon is a red dot and the first tray item stops it; the window shows a red "Daebot is watching your screen" pill with a Stop button.

- Capture runs in the main process (`lib/screen-capture.mjs`, Electron `desktopCapturer`): the primary display at 2 fps (configurable, max 5), downscaled to at most 1366 wide, JPEG q60, plus a 64x36 luma signature for change detection. Each frame is POSTed to the local gateway's `/screen/frame` and kept in an in-memory ring buffer (last 30 s). Nothing is written to disk unless the user asks Daebot to `screen save`; turning the switch off clears the buffer. A hosted server never mounts these routes.
- macOS Screen Recording permission is the user's to grant. `systemPreferences.getMediaAccessStatus('screen')` is read; if it is not granted the window shows a card with an Open System Settings button (`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`). Daebot never changes an OS permission. After the user allows it, macOS may ask to quit and reopen Daebot. Windows needs no permission.
- The agent side is `src/screen/feed.ts`, the `screen` tool (`look`, `wait_for_change`, `clip`, `status`, `save`) and the `computer` tool, which uses the live frame instead of a PowerShell screenshot while the feed is on.

## Sign-in (first run)
No OpenRouter key is needed. On first launch the app shows a small window asking for a MIND API key (m-i-n-d.ai, Settings, Developer,
API Keys). It checks the key against MIND (`GET <MIND_BASE_URL>/profile`), then stores it in `~/.daebot/mind-key` (mode 0600, inside a
0700 folder). The key reaches the gateway child through its environment (`MIND_API_KEY` + `DAEBOT_BILLING=mind`), never argv, a URL
or a log line. Closing the window quits the app. The menu bar item has **Sign out of MIND** (deletes the file and asks again).
Developer setups keep working: with `OPENROUTER_API_KEY` (env or `~/.daebot/config.json`) and no MIND key, the app skips the prompt
and bills OpenRouter as before; `MIND_API_KEY` in the env or `mindApiKey` in `config.json` is used as is.

## Run
```
cd agent/desktop && npm install
npm run dev        # Electron + the real gateway from ../src (system node)
npm test           # node --test --test-concurrency=2 test/*.test.mjs
DAEBOT_TEST_BINARY=/path/to/daebot-<os>-<arch> npm test   # also runs the real compiled binary through the app's launcher
npm run smoke      # headless: hidden window, scripted fake runtime, 20s hard timeout, writes smoke/ui.png and smoke/result.json
```

## Build installers
Every build first compiles the gateway binary for the platform being packaged (`scripts/stage-bin.mjs`, needs `bun` on PATH; bun
cross-compiles every target from any host) into `build/bin/`, and electron-builder ships it under `resources/bin/`.
```
npm run dist:mac     # stage mac binaries (arm64 + x64), universal DMG + zip     -> dist/Daebot-<v>-mac-universal.{dmg,zip}
npm run dist:win     # NSIS installers, x64 and arm64                            -> dist/Daebot-Setup-<v>-{x64,arm64}.exe
npm run dist:linux   # AppImage + deb, x64                                       -> dist/Daebot-<v>-linux-{x86_64.AppImage,amd64.deb}
npm run pack         # host-arch unpacked app only (--dir), for a quick packaging check
```
App id `ai.daebot.desktop`, product name `Daebot`; config in `electron-builder.config.mjs`. Icons (`build-resources/icon.{png,icns,ico}`)
are the approved mascot (`agent/web/brand/icon-512.png`), packaged by `npm run icons` (macOS: sips + iconutil); nothing is redrawn.

### Mac signing and notarization (owner, on the signing Mac)
Default builds are UNSIGNED so they can be made and checked anywhere without touching the keychain. To ship:
```
cd agent/desktop && npm install
DAEBOT_SIGN=1 npm run dist:mac
```
`DAEBOT_SIGN=1` turns on identity `ANTHONY JOSEPH CONTI (VJ44THJ238)`, hardened runtime with `build-resources/entitlements.mac.plist`
(JIT entitlements for Electron and for the bun-compiled gateway), and the `afterSign` hook `scripts/notarize.cjs` (copied from MINDbots:
notarizes through the `MINDNotarize` keychain profile, then staples). If notarization fails the hook logs the exact error and the
build is signed but not notarized; say so in the release notes. Check with `spctl -a -vv dist/mac-universal/Daebot.app` and
`xcrun stapler validate`. An unsigned Mac build needs right-click, Open on first launch.

### Windows and Linux
CI (`.github/workflows/daebot-desktop.yml`, manual run or a `daebot-v*` tag) builds both with no secrets. Those CI Windows installers
are unsigned, so SmartScreen asks to confirm the first launch. The Mac CI job is skipped unless the
`CSC_LINK` secret exists; it cannot notarize (no `MINDNotarize` profile on runners).

A signed Windows installer is opt-in: Azure Artifact Signing (formerly Trusted Signing), switched on only by `DAEBOT_WIN_SIGN=azure`.
Without it Windows builds unsigned on any machine, including cross-built from a Mac, and nothing blocks. From `agent/desktop`, on a Windows host:

```
DAEBOT_WIN_SIGN=azure npm run dist:win
```

With `DAEBOT_WIN_SIGN=azure` the config reads seven environment variables and throws `DAEBOT_WIN_SIGN=azure Windows build is missing: ...` if any is unset. Values stay
in the environment, never in this repo:

- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` — an Entra app with the Artifact Signing Certificate Profile Signer role
- `DAEBOT_AZURE_ENDPOINT` — regional endpoint of the signing account, for example `https://eus.codesigning.azure.net/`
- `DAEBOT_AZURE_ACCOUNT` — Artifact Signing account name
- `DAEBOT_AZURE_PROFILE` — certificate profile name
- `DAEBOT_WIN_PUBLISHER` — publisher name, the exact certificate subject

electron-builder installs the TrustedSigning PowerShell module itself and signs the app, the NSIS installer, and the bundled
`resources/bin/daebot-windows-<arch>.exe` (an `.exe` extra resource; no `signExts` and no extra sign step). Signing runs
`Invoke-TrustedSigning` through Windows PowerShell: native `pwsh.exe`, or `powershell.exe` if that is missing. A Mac-only `pwsh`
install is not a supported way to ship. The reliable path is a Windows host or Windows CI runner. A Mac works only when
electron-builder can drive a Parallels Desktop Windows 10 or 11 VM. `DAEBOT_SIGN=1` is the Mac Developer ID switch only and never
affects Windows; a Mac `CSC_LINK` is cleared for Windows packs that are not Azure-signed.

### Publishing a release
1. Bump `version` in `agent/package.json` and `agent/desktop/package.json`; build on each platform (or run the workflow).
2. Upload the files to `https://download.m-i-n-d.ai/daebot/<version>/`.
3. `node agent/scripts/release-manifest.mjs <folder-with-the-files> <version>` fills `agent/web/download/releases.json` (size, sha256,
   URL; a missing file stays "Coming soon"). Merge it and deploy; `daebot.live/download` updates.

#### The script does all of it: `agent/desktop/scripts/publish-release.sh`
```
agent/desktop/scripts/publish-release.sh <artifactsDir> <version> --notes "..." \
    [--platforms mac,windows,linux] [--dry-run] [--force] [--skip-registry]
```
`<artifactsDir>` is what electron-builder wrote (`agent/desktop/dist`). It uploads atomically (`scp` to
`.tmp`, then `mv`), skips a file already present with the same sha256, refuses to overwrite a different one
without `--force`, verifies every file over HTTPS (200 + matching `content-length`), writes the download
manifest, registers each `(platform, arch)` with MIND, and prints a receipt with the sha256s. Always run
`--dry-run` first. Modeled on the proven MIND publisher (`mindapp-sandbox/.../publish-dmg.sh`).

#### A release is THREE things — all three, or it is not shipped
1. **The installers** on the droplet (`/var/www/evie/download/daebot/`, Caddy, public at
   `https://download.m-i-n-d.ai/download/daebot/`).
2. **The electron-updater feed files** (`latest-mac.yml`, `latest.yml`, `latest-arm64.yml`,
   `latest-linux.yml`) plus the `.blockmap` files. This is what an ALREADY-INSTALLED app checks. An installer
   uploaded without its feed file never reaches anyone already running Daebot.
3. **The records**: the MIND registry (`POST /developer/v1/mac-releases`, admin key, keyed on
   version+build+platform+arch) and `agent/web/download/releases.json` (the website's download buttons).

#### Credentials each step needs
| Step | Needs | Where it lives |
|---|---|---|
| Upload to the droplet | the SSH private key | `~/.ssh/droplet_170_key` (or `DAEBOT_SSH_KEY`) |
| Mac sign + notarize | Developer ID `ANTHONY JOSEPH CONTI (VJ44THJ238)`, `MINDNotarize` profile, `DAEBOT_SIGN=1` | only the signing Mac |
| MIND registry | an admin `mind_` key | `~/.daebot/mind-key`, or `MIND_API_KEY` |

Build commands: Mac `DAEBOT_SIGN=1 npm run dist:mac` (signing Mac only); Windows/Linux need no secrets —
CI builds them on a `daebot-v*` tag or `workflow_dispatch`. `bun` is required to compile the gateway binary
(`curl -fsSL https://bun.sh/install | bash`).

#### Traps that cost real time
- **The desktop app bundles its own gateway** (`Contents/Resources/bin/daebot-darwin-*` embeds the web UI), so
  a web-only change does not reach an installed app until a desktop build ships. Check an installed app with
  `.../bin/daebot-darwin-arm64 --version`.
- **A build with no signing identity SUCCEEDS but is adhoc-signed** (`codesign -dv` -> `Signature=adhoc`,
  `TeamIdentifier=not set`; `spctl -a` -> "rejected"). Do not publish it: it would replace a notarized app
  with an untrusted one and break the update chain.
- **CI's `verify` job already fails on `main`** (run 39975530745, 2026-10-23, before this work). Reproduce
  locally at the tag before blaming a change, and compare failing test NAMES against a `main` run: the flaky
  set is the device-relay / connected-apps / apple_calendar group.
- In a fresh `git worktree`, `npx tsc` fails with "This is not the tsc command you are looking for" until you
  run `npm install` there. `timeout` is not installed on macOS.

#### Done means (do not claim it earlier)
`curl -sIL https://download.m-i-n-d.ai/download/daebot/<file>` is 200 with the right `content-length`;
the server's `latest-mac.yml` names the new version; the registry `GET /latest` confirms version+build;
`releases.json` on main has the URL; and `scripts/verify-feed.cjs` shows the update offered to an app on the
previous version.

## Memory
Measured by `npm run smoke` (sum of Electron per-process working sets + the gateway child RSS; this over-counts shared pages,
and the child runs the scripted fake runtime, so the real runtime will add some): see the numbers in the task report.
Levers already on: software rendering (no 70 MB GPU process) and `idleTrimSeconds` (the hidden window's renderer is destroyed
after that long and recreated on show; sessions live in the gateway, only the on-screen transcript is reloaded). Set it to 0 to keep the window warm.
