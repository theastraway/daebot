# Local tools

On a computer (the desktop app or a local gateway) Daebot can use tools that touch that machine: `bash` and `process` for commands, `terminal` for a back-and-forth shell, and the file tools. The hosted service at daebot.live does not offer those tools. Nothing here runs on the hosted deployment.

## Terminal pane

The `terminal` tool opens a hidden pipe shell that belongs to the chat. Pipes, not a PTY: line-oriented programs work, and full-screen programs (vim, top, less) do not.

The local web UI shows that shell in a pane labeled "Daebot's terminal — read-only". The pane lists the chat's sessions and streams what they print. It peeks at the scrollback and does not move the agent's read cursor, so a look from the user never steals output the agent is about to read. The pane does not send keystrokes. A shared-thread guest cannot open it, because the scrollback can contain secrets.

Output is text. Escape codes are stripped, and anything the shell prints that looks like HTML is shown as characters. When the ring or a single burst skips bytes, the pane adds a line that says how many earlier characters are not shown. A shell that has printed nothing yet shows "No output yet." When the shell exits, the pane shows "Exited (status N)". A session the agent closed shows "Closed". The view follows new output while the reader is at the bottom, and stays put if they have scrolled up.

On a wide window the pane sits under the top bar, and the chat and the composer move aside so the pane does not cover them. On a phone it is a sheet along the bottom. Typing into the pane waits for the PTY slice.
