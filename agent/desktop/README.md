# MINDClaw Desktop

Thin Electron shell around the MINDClaw gateway and its web UI (`agent/web/`, unmodified). macOS first.
It never imports the agent loop, provider or kernel: it starts the gateway as a child process and shows the web UI.

## How it works
- `src/main.mjs` is glue; every decision lives in `src/lib/*` (unit-tested).
- **Gateway child** (`src/lib/launcher.mjs` is the ONE function to swap): runs `src/child-entry.mjs` with the system `node`
  (`MINDCLAW_NODE`, then `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`), falling back to Electron's bundled Node
  (`ELECTRON_RUN_AS_NODE`, Node 24 with type stripping). The entry imports `agent/src/gateway/index.ts`, starts on a
  random loopback port and prints one JSON line `{"mindclaw":"ready","url":...,"token":...}` on stdout. The token only travels
  over that pipe and is never logged. (The stock `mindclaw serve` has no `--port` flag and a fixed 7777, hence the tiny entry file.)
- Main waits for `/health`, then loads `http://127.0.0.1:<port>/?token=...` (token in the query once; the web UI scrubs it).
- Window: `contextIsolation`, no `nodeIntegration`, `sandbox`, in-memory session partition, all permission requests denied,
  navigation limited to the exact gateway origin; http(s)/mailto links open in the default browser; everything else is dropped.
- Menu bar item: Show/Hide, New Session, Kernel mode (Enforced / Shadow / Off), Quit. Kernel mode restarts the child with
  `MINDCLAW_KERNEL` / `MINDCLAW_SHADOW` and is remembered in `desktop.json`.
- Confirm notifications: main opens its own WebSocket to `/ws`, resumes each live session by id (which only subscribes) and
  raises a native notification for `confirm` events while the window is hidden or unfocused. No web/ changes needed.
- Optional hook: `window.mindclawDesktop.notify({ title, body })` (validated, rate limited, honored only from the gateway origin).
- Quit stops only the child it spawned (SIGTERM, SIGKILL after 3s). The child also exits if its stdin closes.
- Single-instance lock; Cmd+N new session, Cmd+W hide window, Cmd+Q quit; dark/light follows the system.

## Config: `~/.mindclaw/desktop.json`
```json
{ "shortcut": "Alt+Space", "kernelMode": "enforced", "idleTrimSeconds": 300 }
```
`shortcut` is an Electron accelerator (`null` disables it). Window bounds live in `~/.mindclaw/desktop-state.json`.
The gateway needs `OPENROUTER_API_KEY` (env or `~/.mindclaw/config.json`), same as `mindclaw serve`; without it the window
shows a plain error page instead of the UI.

## Run
```
cd agent/desktop && npm install
npm run dev        # starts Electron + the real gateway from ../src
npm test           # node --test --test-concurrency=2 test/*.test.mjs
npm run smoke      # headless: hidden window, no Dock/tray/shortcut, scripted fake runtime, 20s hard timeout,
                   # writes smoke/ui.png and smoke/result.json (RAM numbers)
```

## Package (unsigned)
```
npm run dist       # stages ../src + ../web into build/agent, then electron-builder -> dist/MINDClaw-*.dmg, *-mac.zip, dist/mac/MINDClaw.app
npm run pack       # .app only (--dir)
npx electron-builder --mac --arm64 dmg zip   # Apple Silicon build (the default follows the host arch)
```
Signing and notarization are NOT configured (`mac.identity: null`). When wanted, remove that line and set:
- `CSC_LINK` (base64 or path of the Developer ID .p12) and `CSC_KEY_PASSWORD`
- Notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (or `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`)
plus `mac.hardenedRuntime: true`, `mac.notarize: true`. First launch of an unsigned build: right-click, Open.

## Memory
Measured by `npm run smoke` (sum of Electron per-process working sets + the gateway child RSS; this over-counts shared pages,
and the child runs the scripted fake runtime, so the real runtime will add some): see the numbers in the task report.
Levers already on: software rendering (no 70 MB GPU process) and `idleTrimSeconds` (the hidden window's renderer is destroyed
after that long and recreated on show; sessions live in the gateway, only the on-screen transcript is reloaded). Set it to 0 to keep the window warm.
