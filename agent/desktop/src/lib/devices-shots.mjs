// Dev-only screenshot harness for device panes. The flags do nothing unless the desktop was also
// started with --mindclaw-smoke (devicesShotsFromArgv enforces that). Later slices add a pane name
// here (shotFilesFor) and a seed branch in src/gateway/devices-shots.ts. This module does not touch
// a real user's window: main.mjs only calls it when --mindclaw-smoke is also set.
//
//   --daebot-devices-shots=<dir>   where PNGs are written
//   --daebot-devices-pane=<name>   which pane to open (terminal today; browser, ios-sim, … later)

/** Must match agent/src/gateway/devices-shots.ts TERMINAL_SHOT. */
export const TERMINAL_SHOT = Object.freeze({
  title: "Show the terminal",
  liveMarker: "daebot-terminal-live",
  closedMarker: "session-closed-marker",
  bottomMarker: "line 40",
  hostile: "<script>alert(1)</script>",
  liveDir: "live-work",
  closedDir: "closed-work",
  emptyDir: "empty-work",
});

function flagValue(argv, name) {
  const pref = name + "=";
  const hit = [...argv].find((a) => a === name || String(a).startsWith(pref));
  if (hit === undefined) return undefined;
  if (hit === name) return "";
  return String(hit).slice(pref.length);
}

/**
 * @param {string[]} argv
 * @returns {null | { error: string } | { dir: string, pane: string }}
 *   null when the flags are absent. {error} when they are present but unusable, so smoke fails
 *   instead of capturing the ordinary window and calling it a pane shot.
 */
export function parseDevicesShots(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const shots = flagValue(list, "--daebot-devices-shots");
  const pane = flagValue(list, "--daebot-devices-pane");
  if (shots === undefined && pane === undefined) return null;
  if (!shots) return { error: "--daebot-devices-pane requires --daebot-devices-shots=<dir>" };
  if (!pane) return { error: "--daebot-devices-shots requires --daebot-devices-pane=<name>" };
  if (shots.includes("\0") || pane.includes("\0")) return { error: "bad devices-shots flag" };
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(pane)) return { error: `bad --daebot-devices-pane name ${JSON.stringify(pane)}` };
  return { dir: shots, pane };
}

/** PNG names for a pane. A later slice adds its own key; an unknown name fails the smoke run. */
const PANE_SHOTS = {
  terminal: ["live.png", "closed.png", "empty.png"],
};

/**
 * @param {string} pane
 * @returns {{ files: string[] } | { error: string }}
 */
export function shotFilesFor(pane) {
  const files = PANE_SHOTS[pane];
  if (!files) return { error: `no shots handler for pane ${pane} yet` };
  return { files };
}

/**
 * What main.mjs should do with the process arguments.
 * @param {string[]} argv
 * @param {boolean} smoke  true only when --mindclaw-smoke is set. Anything else returns null (real users).
 * @returns {null | { error: string } | { dir: string, pane: string, readyTimeoutMs: number }}
 */
export function devicesShotsFromArgv(argv, smoke) {
  if (!smoke) return null;
  const parsed = parseDevicesShots(argv);
  if (!parsed) return null;
  if (parsed.error) return { error: parsed.error };
  return { dir: parsed.dir, pane: parsed.pane, readyTimeoutMs: 60_000 };
}

/**
 * A script the smoke window runs to open one terminal shot. It returns {ok, tail?, error?, exit?}.
 * Output is read with textContent. The script never assigns innerHTML.
 * @param {"live"|"closed"|"empty"} phase
 * @param {typeof TERMINAL_SHOT} [shot]
 */
export function terminalShotProbe(phase, shot = TERMINAL_SHOT) {
  const spec = {
    phase,
    title: shot.title,
    liveMarker: shot.liveMarker,
    closedMarker: shot.closedMarker,
    bottomMarker: shot.bottomMarker,
    hostile: shot.hostile,
    liveDir: shot.liveDir,
    closedDir: shot.closedDir,
    emptyDir: shot.emptyDir,
    emptyText: "No output yet.",
    userLine: "Open the terminal",
  };
  return `(async () => {
    const spec = ${JSON.stringify(spec)};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const textOf = (sel) => { const n = document.querySelector(sel); return n ? (n.textContent || "") : ""; };
    const clickIncludes = (sel, needle) => {
      const el = [...document.querySelectorAll(sel)].find((n) => (n.textContent || "").includes(needle));
      if (!el) return false;
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      el.click();
      return true;
    };
    const gap = () => {
      const out = document.getElementById("term-out");
      if (!out) return 9999;
      return out.scrollHeight - out.scrollTop - out.clientHeight;
    };
    const deadline = Date.now() + (spec.phase === "live" ? 25000 : 15000);
    let emptyStable = 0;
    while (Date.now() < deadline) {
      if (spec.phase === "live") {
        const current = textOf(".sess[aria-current]");
        if (!current.includes(spec.title)) clickIncludes(".sess", spec.title);
        const chip = document.getElementById("btn-terminal");
        if (current.includes(spec.title) && chip && !chip.hidden) {
          if (chip.getAttribute("aria-expanded") !== "true") chip.click();
          const out = textOf("#term-out");
          const esc = String.fromCharCode(27);
          if (chip.getAttribute("aria-expanded") === "true"
              && document.documentElement.classList.contains("term-open")
              && out.includes(spec.liveMarker) && out.includes(spec.bottomMarker) && out.includes(spec.hostile)
              && !out.includes(esc) && !document.querySelector("#term-out script")
              && textOf("#thread").includes(spec.userLine) && gap() <= 80) {
            return { ok: true, tail: out.slice(-200) };
          }
        }
      } else if (spec.phase === "closed") {
        const selected = document.querySelector(".term-sess[aria-selected='true']");
        if (!selected || !(selected.textContent || "").includes(spec.closedDir)) clickIncludes(".term-sess", spec.closedDir);
        const out = textOf("#term-out");
        const exitEl = document.getElementById("term-exit");
        const exit = exitEl ? (exitEl.textContent || "") : "";
        if (out.includes(spec.closedMarker) && !out.includes(spec.liveMarker) && exit.startsWith("Exited") && exitEl && !exitEl.hidden) {
          return { ok: true, tail: out.slice(0, 200), exit };
        }
      } else {
        const selected = document.querySelector(".term-sess[aria-selected='true']");
        if (!selected || !(selected.textContent || "").includes(spec.emptyDir)) clickIncludes(".term-sess", spec.emptyDir);
        const empty = document.getElementById("term-empty");
        const out = textOf("#term-out");
        const chip = document.getElementById("btn-terminal");
        const pane = document.getElementById("term-pane");
        if (empty && !empty.hidden && (empty.textContent || "").includes(spec.emptyText) && out === ""
            && chip && !chip.hidden && pane && !pane.hidden) {
          emptyStable += 200;
          if (emptyStable >= 400) return { ok: true, tail: "" };
        } else emptyStable = 0;
      }
      await sleep(200);
    }
    return { ok: false, error: "timed out waiting for " + spec.phase, tail: textOf("#term-out").slice(0, 200), thread: textOf("#thread").slice(0, 120) };
  })()`;
}
