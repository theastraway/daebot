// Dev-only seed for the desktop screenshot harness. Runs only inside the smoke fake gateway
// (MINDCLAW_DESKTOP_FAKE=1 and DAEBOT_DEVICES_SHOTS_PANE). It is not a route and not a tool:
// a normal gateway never imports it. Later panes add a branch in seedDevicesShot.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalRegistry, type TerminalRegistry } from "../tools/terminal.ts";

/** Must match desktop/src/lib/devices-shots.mjs TERMINAL_SHOT. The shot probes the page for these strings. */
export const TERMINAL_SHOT = {
  title: "Show the terminal",
  liveMarker: "daebot-terminal-live",
  closedMarker: "session-closed-marker",
  bottomMarker: "line 40",
  hostile: "<script>alert(1)</script>",
  liveDir: "live-work",
  closedDir: "closed-work",
  emptyDir: "empty-work",
} as const;

export interface ShotSession {
  id: string;
  send(text: string): AsyncIterable<unknown>;
}

export interface ShotHost {
  open(surface: string, title?: string): Promise<ShotSession>;
}

export interface ShotDeps {
  registry?: TerminalRegistry;
  /** How long each shell is given to print. The real shot waits; tests pass 0. */
  commandWaitMs?: number;
}

/**
 * Prepare one pane's realistic content before the smoke window loads.
 * `terminal` opens a real pipe shell (or the injected registry) in a chat the UI can select.
 */
export async function seedDevicesShot(gw: ShotHost, pane: string, deps: ShotDeps = {}): Promise<void> {
  if (process.env.MINDCLAW_DESKTOP_FAKE !== "1") {
    throw new Error("devices shots run only inside the smoke fake gateway");
  }
  if (pane === "terminal") {
    await seedTerminalPane(gw, deps);
    return;
  }
  throw new Error(`devices shots: no seed for pane ${JSON.stringify(pane)}`);
}

async function seedTerminalPane(gw: ShotHost, deps: ShotDeps): Promise<void> {
  const session = await gw.open("web", TERMINAL_SHOT.title);
  // Drain the scripted reply so the shot is a chat with messages, not the empty draft.
  for await (const _ev of session.send("Open the terminal and show me what it printed.")) { /* recorded on the fake runtime */ }
  const root = mkdtempSync(join(tmpdir(), "daebot-shot-"));
  const liveDir = join(root, TERMINAL_SHOT.liveDir);
  const closedDir = join(root, TERMINAL_SHOT.closedDir);
  const emptyDir = join(root, TERMINAL_SHOT.emptyDir);
  mkdirSync(liveDir);
  mkdirSync(closedDir);
  mkdirSync(emptyDir);
  writeFileSync(join(liveDir, "README.txt"), "shot\n");
  writeFileSync(join(liveDir, "notes.txt"), "alpha\n");
  const reg = deps.registry ?? terminalRegistry();
  const waitMs = deps.commandWaitMs ?? 8000;
  const linesN = Number(TERMINAL_SHOT.bottomMarker.replace(/\D/g, "")) || 40;
  const live = reg.open(session.id, liveDir, "bash");
  // Fixed lines written to the shell's stdin. The spawn itself is bash --noprofile --norc, never a shell -c wrapper.
  // The long run is first so the pane, scrolled to the bottom, still shows the colour words, the
  // markup (as text), and the directory listing.
  const lines = [
    `i=1; while [ "$i" -le ${linesN} ]; do printf 'line %02d  the quick brown fox\\n' "$i"; i=$((i+1)); done`,
    "printf '\\033[1;32mgreen\\033[0m \\033[31mred\\033[0m \\033[34mblue\\033[0m\\n'",
    `echo ${TERMINAL_SHOT.liveMarker}`,
    `echo '${TERMINAL_SHOT.hostile}'`,
    "ls -1",
  ];
  for (const line of lines) reg.send(session.id, live.id, line);
  if (waitMs > 0) {
    const liveRead = await reg.read(session.id, live.id, { waitMs, until: /notes\.txt/ });
    const text = liveRead.text;
    if (!text.includes(TERMINAL_SHOT.bottomMarker) || !text.includes("green red blue") || !text.includes(TERMINAL_SHOT.liveMarker) || !text.includes(TERMINAL_SHOT.hostile) || !text.includes("notes.txt")) {
      throw new Error("devices shots: live shell did not finish printing");
    }
  } else {
    await reg.read(session.id, live.id, { waitMs: 0 });
  }

  const closed = reg.open(session.id, closedDir, "bash");
  reg.send(session.id, closed.id, `echo ${TERMINAL_SHOT.closedMarker}`);
  reg.send(session.id, closed.id, "exit");
  if (waitMs > 0) {
    const closedRead = await reg.read(session.id, closed.id, { waitMs, until: new RegExp(TERMINAL_SHOT.closedMarker) });
    if (!closedRead.text.includes(TERMINAL_SHOT.closedMarker)) throw new Error("devices shots: closed shell did not print its marker");
    if (closedRead.info.status === "running") {
      const rest = await reg.read(session.id, closed.id, { waitMs });
      if (rest.info.status === "running") throw new Error("devices shots: closed shell did not exit");
    }
  } else {
    await reg.read(session.id, closed.id, { waitMs: 0 });
  }

  reg.open(session.id, emptyDir, "bash");
}
