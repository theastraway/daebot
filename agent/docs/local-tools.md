# Local tools

On a computer (the desktop app or a local gateway) Daebot can use tools that touch that machine: `bash` and `process` for commands, `terminal` for a back-and-forth shell, and the file tools. The hosted service at daebot.live does not offer those tools. Nothing here runs on the hosted deployment.

## Terminal pane

The `terminal` tool opens a hidden pipe shell that belongs to the chat. Pipes, not a PTY: line-oriented programs work, and full-screen programs (vim, top, less) do not.

The local web UI shows that shell in a pane labeled "Daebot's terminal — read-only". The pane lists the chat's sessions and streams what they print. It peeks at the scrollback and does not move the agent's read cursor, so a look from the user never steals output the agent is about to read. The pane does not send keystrokes. A shared-thread guest cannot open it, because the scrollback can contain secrets.

Output is text. Escape codes are stripped, and anything the shell prints that looks like HTML is shown as characters. When the ring or a single burst skips bytes, the pane adds a line that says how many earlier characters are not shown. A shell that has printed nothing yet shows "No output yet." When the shell exits, the pane shows "Exited (status N)". A session the agent closed shows "Closed". The view follows new output while the reader is at the bottom, and stays put if they have scrolled up.

On a wide window the pane sits under the top bar, and the chat and the composer move aside so the pane does not cover them. On a phone it is a sheet along the bottom. Typing into the pane waits for the PTY slice.

## Simulator

The `simulator` tool drives an iOS Simulator on a Mac that has Xcode. It runs `xcrun simctl` with an argument array and no shell: list, boot, shutdown, install a local `.app` bundle, launch, terminate, open a URL, screenshot, record a clip, and erase. Erase deletes the simulator's data and needs the user's go. An `.ipa`, a download, and a path outside the user's folders are refused. Daebot never controls a physical device.

Taps, typing, swipes and the accessibility tree use `idb` when `idb` is on PATH (`brew install idb-companion && pip3 install fb-idb for taps (optional)`). Without idb, a coordinate tap or typing clicks the Simulator window. That moves the mouse and needs Accessibility permission, and the result says so. A swipe, a label tap, or the accessibility tree needs idb. If Xcode or an iOS runtime is missing, the tool returns the install step and does not fall back to screen control.

The local web UI has a Simulator pane: a device picker, Boot, Shut down, and Record a clip, plus a screenshot about once a second. A shared-thread guest cannot open it. The hosted service does not mount it. On Windows and Linux the tool is not offered. GET /devices says the simulator needs a Mac with Xcode, and a request is sent to the owner's paired Mac when one is registered. On a wide window the chat column and the composer move aside so the message box and Send stay fully visible beside the pane. On a phone the pane is a sheet along the bottom.
