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
  is never logged. Both persist sessions to `~/.mindclaw/data`, bill the user's MIND account (`DAEBOT_BILLING=mind`) and keep the
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

## Config: `~/.mindclaw/desktop.json`
```json
{ "shortcut": "Alt+Space", "kernelMode": "enforced", "idleTrimSeconds": 300, "keepWorking": true }
```
`shortcut` is an Electron accelerator (`null` disables it). Window bounds live in `~/.mindclaw/desktop-state.json`.
Credentials: see Sign-in below. Without any usable key the gateway child reports why and the window shows a plain error page.

## Sign-in (first run)
No OpenRouter key is needed. On first launch the app shows a small window asking for a MIND API key (m-i-n-d.ai, Settings, Developer,
API Keys). It checks the key against MIND (`GET <MIND_BASE_URL>/profile`), then stores it in `~/.mindclaw/mind-key` (mode 0600, inside a
0700 folder). The key reaches the gateway child through its environment (`MIND_API_KEY` + `DAEBOT_BILLING=mind`), never argv, a URL
or a log line. Closing the window quits the app. The menu bar item has **Sign out of MIND** (deletes the file and asks again).
Developer setups keep working: with `OPENROUTER_API_KEY` (env or `~/.mindclaw/config.json`) and no MIND key, the app skips the prompt
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
CI (`.github/workflows/daebot-desktop.yml`, manual run or a `daebot-v*` tag) builds both with no secrets. Windows installers are
unsigned (no code-signing certificate yet), so SmartScreen asks to confirm the first launch. The Mac CI job is skipped unless the
`CSC_LINK` secret exists; it cannot notarize (no `MINDNotarize` profile on runners).

### Publishing a release
1. Bump `version` in `agent/package.json` and `agent/desktop/package.json`; build on each platform (or run the workflow).
2. Upload the files to `https://download.m-i-n-d.ai/daebot/<version>/`.
3. `node agent/scripts/release-manifest.mjs <folder-with-the-files> <version>` fills `agent/web/download/releases.json` (size, sha256,
   URL; a missing file stays "Coming soon"). Merge it and deploy; `daebot.live/download` updates.

## Memory
Measured by `npm run smoke` (sum of Electron per-process working sets + the gateway child RSS; this over-counts shared pages,
and the child runs the scripted fake runtime, so the real runtime will add some): see the numbers in the task report.
Levers already on: software rendering (no 70 MB GPU process) and `idleTrimSeconds` (the hidden window's renderer is destroyed
after that long and recreated on show; sessions live in the gateway, only the on-screen transcript is reloaded). Set it to 0 to keep the window warm.
