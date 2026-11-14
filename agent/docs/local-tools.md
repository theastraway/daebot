# Local tools

On a computer (the desktop app or a local gateway) Daebot can use tools that touch that machine: `bash` and `process` for commands, `terminal` for a back-and-forth shell, `browser` for Daebot's own browser pane, and the file tools. The hosted service at daebot.live does not offer those tools. Nothing here runs on the hosted deployment.

## Terminal pane

The `terminal` tool opens a shell that belongs to the chat. On the desktop app the shell is a real PTY hosted in Electron's main process (node-pty). The pane is typeable: keystrokes from the person go to that PTY, and full-screen programs (vim, top, less) work. A gateway-only install (the CLI, or a server) keeps pipes. A pipe session is read-only in the pane, and the pane says so. Full-screen programs do not work on a pipe.

The local web UI shows the shell in a pane labeled "Daebot's terminal". The pane lists the chat's sessions and streams what they print. It peeks at the scrollback and does not move the agent's read cursor, so a look from the user never steals output the agent is about to read. What the model reads is ANSI-stripped and capped. The PTY pane keeps the raw bytes so colour and cursor motion render. A shared-thread guest cannot open the pane or its stream, because the scrollback can contain secrets. The hosted deployment does not mount it.

The person's own keystrokes are not sent through the agent's permission rules. Commands the agent sends still are, including a bash deny. `rm -rf`, a forced `git push`, a deploy command, and `terraform destroy` are irreversible and need the person's go. The working directory goes through the same repo protection as other writes. An idle session closes after 30 minutes. The activity log records that the person typed, and how many bytes, not the characters.

On a wide window the pane sits under the top bar, and the chat and the composer move aside so the pane does not cover them. On a phone it is a sheet along the bottom. Typing into the pane waits for the PTY slice.

## Simulator

The `simulator` tool drives an iOS Simulator on a Mac that has Xcode. It runs `xcrun simctl` with an argument array and no shell: list, boot, shutdown, install a local `.app` bundle, launch, terminate, open a URL, screenshot, record a clip, and erase. Erase deletes the simulator's data and needs the user's go. An `.ipa`, a download, and a path outside the user's folders are refused. Daebot never controls a physical device.

Taps, typing, swipes and the accessibility tree use `idb` when `idb` is on PATH (`brew install idb-companion && pip3 install fb-idb for taps (optional)`). Without idb, a coordinate tap or typing clicks the Simulator window. That moves the mouse and needs Accessibility permission, and the result says so. A swipe, a label tap, or the accessibility tree needs idb. If Xcode or an iOS runtime is missing, the tool returns the install step and does not fall back to screen control.

The local web UI has a Simulator pane: a device picker, Boot, Shut down, and Record a clip, plus a screenshot about once a second. A shared-thread guest cannot open it. The hosted service does not mount it. On Windows and Linux the tool is not offered. GET /devices says the simulator needs a Mac with Xcode, and a request is sent to the owner's paired Mac when one is registered. On a wide window the chat column and the composer move aside so the message box and Send stay fully visible beside the pane. On a phone the pane is a sheet along the bottom.
## Browser pane

The `browser` tool drives a pane in the Daebot desktop window. Pages load in a `WebContentsView` on the partition `persist:daebot-browser`. That partition is not the app's `mindclaw` session and not the user's Chrome profile. Sign-ins made there persist across restarts. The agent may use those signed-in sites. Cookies, storage, and password values never leave Electron and never appear in a tool result.

Actions: `tabs`, `open`, `navigate` (a url, or back, forward, reload), `read`, `screenshot`, `click`, `type`, `key`, `scroll`, `wait`, `close`. `read` returns page text and element refs (`e1`, `e2`, …). The next click or type names a ref; the gateway resolves it. There is no action that evaluates JavaScript.

The desktop attaches Chrome DevTools Protocol 1.3 with `webContents.debugger`. It does not open a debugging port and it does not use Playwright. The gateway queues one command at a time. The desktop long-polls `GET /browser/poll` and posts the outcome to `POST /browser/result`, with the same bearer token as the screen channel. Tab changes go to `POST /browser/state`. A gateway with no desktop connected (a CLI or a server) tells the model the browser is unavailable.

`read` is preferred over a screenshot. Page text is wrapped as untrusted. The tool strips cookies, `localStorage`, `sessionStorage`, IndexedDB, and `Authorization` / `Cookie` / `Set-Cookie` headers from anything a page returns. It refuses to type into a password field or a payment field (card number, cvc, expiry, one-time code) and asks the user to type that in the pane. A click that submits a form, pays, places an order, sends, posts, publishes, or deletes is outward or irreversible: the danger gate asks for the user's explicit go, and the first such action on a site also raises a permission card that can be allowed for that domain.

The user watches the same pane. Mouse or keyboard input in the page pauses the agent on that tab and shows "You have control" with a "Give back to Daebot" button. While the user has control, the agent's tool calls on that tab return that they are paused. `tabs` can still list the tabs. Navigation to `file:`, `chrome:`, `devtools:`, `view-source:`, `javascript:`, top-level `data:`, and the gateway's own origin is refused. `window.open` becomes another Daebot tab. Downloads save under `daebot-browser-downloads` in the app's userData. A shared-thread guest cannot open the pane. Hosted routes answer 404, and the public tier does not offer the tool.

On a wide window the pane sits beside the chat. The chat column and the composer move aside by the pane's width, so the send button stays visible. The pane defaults to about 45% of the window (at least 420px, at most about 760px). A drag handle on its left edge resizes it, and that width is kept. On a phone it is a sheet along the bottom.
A pipe pane shows stripped text. Anything the shell prints that looks like HTML is shown as characters. When the ring or a single burst skips bytes, the pane adds a line that says how many earlier characters are not shown. A shell that has printed nothing yet shows "No output yet." When the shell exits, the pane shows "Exited (status N)". A session the agent closed shows "Closed". The view follows new output while the reader is at the bottom, and stays put if they have scrolled up.

On a wide window the pane sits under the top bar, and the chat and the composer move aside so the pane does not cover them. On a phone it is a sheet along the bottom. GET /devices reports `backend` (`pty` or `pipe`), `typeable`, and `reason`.
