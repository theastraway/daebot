// Dev-only screenshot harness for device panes. The flags do nothing unless the desktop was also
// started with --mindclaw-smoke (devicesShotsFromArgv enforces that). Later slices add a pane name
// here (shotFilesFor) and a seed branch in src/gateway/devices-shots.ts. This module does not touch
// a real user's window: main.mjs only calls it when --mindclaw-smoke is also set.
//
//   --daebot-devices-shots=<dir>   where PNGs are written
//   --daebot-devices-pane=<name>   which pane to open (terminal, ios-sim)
//
// ios-sim reads DAEBOT_IOS_SIM_SHOT_MODE (fixture, or needs-mac). That variable does nothing
// unless the smoke flags above are also set. The fixture picture is DAEBOT_SIMULATOR_FIXTURE_JPEG.

/** Must match agent/src/gateway/devices-shots.ts IOS_SIM_SHOT. */
export const IOS_SIM_SHOT = Object.freeze({
  title: "iOS Simulator",
  fixtureBanner: "Fixture. This picture is not a live simulator.",
  needsMac: "needs a Mac with Xcode",
  device: "iPhone 16",
  emptyDevice: "No simulator",
});

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

/** fixture paints the fake phone. needs-mac is the real Linux gateway, which has no Xcode. */
export function iosSimShotMode(env = {}) {
  return env.DAEBOT_IOS_SIM_SHOT_MODE === "needs-mac" ? "needs-mac" : "fixture";
}

/**
 * PNG names for a pane. An unknown name fails the smoke run.
 * ios-sim writes a full window (chat beside the pane) and a crop of the pane.
 * @param {string} pane
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ files: string[] } | { error: string }}
 */
export function shotFilesFor(pane, env = {}) {
  if (pane === "terminal") return { files: ["live.png", "closed.png", "empty.png"] };
  // Browser shots are written by shots-browser.mjs: capturePage of the window misses the child WebContentsView, so they are composited.
  // persist.png is the second process and is not part of this list.
  if (pane === "browser") return { files: ["pane-loaded.png", "after-typing.png", "refusal.png", "approval.png", "takeover.png"] };
  if (pane === "ios-sim") {
    const mode = iosSimShotMode(env);
    return { files: [`${mode}-window.png`, `${mode}-pane.png`] };
  }
  return { error: `no shots handler for pane ${pane} yet` };
}

/**
 * The script main.mjs runs for one PNG, plus how to capture it.
 * Terminal shots use capturePage() with no rect. ios-sim passes a rect: a hidden smoke window
 * otherwise returns a frame from before the pane opened.
 * @param {string} pane
 * @param {string} file
 * @returns {{ error: string } | { script: string, timeoutMs: number, clip?: string, fullRect?: boolean }}
 */
export function shotProbeFor(pane, file) {
  const name = String(file);
  if (pane === "terminal") {
    const phase = name.replace(/\.png$/, "");
    return { script: terminalShotProbe(phase), timeoutMs: phase === "live" ? 30_000 : 20_000 };
  }
  if (pane === "ios-sim") {
    const mode = name.startsWith("needs-mac") ? "needs-mac" : "fixture";
    const clip = name.endsWith("-pane.png");
    return { script: iosSimShotProbe(mode), timeoutMs: 20_000, clip: clip ? "sim-pane" : "", fullRect: !clip };
  }
  return { error: `no shots handler for pane ${pane} yet` };
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

/**
 * Opens the iOS Simulator pane and checks the chat column, the composer and Send sit fully
 * beside it. Output is read with textContent. The script never assigns innerHTML.
 * @param {"fixture"|"needs-mac"} mode
 * @param {typeof IOS_SIM_SHOT} [shot]
 */
export function iosSimShotProbe(mode, shot = IOS_SIM_SHOT) {
  const spec = {
    mode: mode === "needs-mac" ? "needs-mac" : "fixture",
    title: shot.title,
    fixtureBanner: shot.fixtureBanner,
    needsMac: shot.needsMac,
    device: shot.device,
    emptyDevice: shot.emptyDevice,
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
    const box = (id) => {
      const el = document.getElementById(id);
      if (!el || el.hidden) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const layoutOf = () => {
      const view = { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight };
      const boxes = { scroll: box("scroll"), composer: box("composer"), send: box("btn-send"), pane: box("sim-pane") };
      const problems = [];
      for (const name of ["scroll", "composer", "send", "pane"]) {
        const r = boxes[name];
        if (!r || r.w < 8 || r.h < 8) { problems.push(name + " missing"); continue; }
        if (r.x < -1 || r.y < -1 || r.x + r.w > view.w + 1 || r.y + r.h > view.h + 1) problems.push(name + " clipped");
      }
      const pane = boxes.pane;
      for (const name of ["scroll", "composer", "send"]) {
        const r = boxes[name];
        if (!r || !pane) continue;
        const overlaps = r.x < pane.x + pane.w - 2 && r.x + r.w > pane.x + 2 && r.y < pane.y + pane.h - 2 && r.y + r.h > pane.y + 2;
        if (overlaps) problems.push(name + " overlaps pane");
      }
      return { ok: problems.length === 0, error: problems.join(", "), boxes, view };
    };
    const deadline = Date.now() + 15000;
    let layoutError = "";
    while (Date.now() < deadline) {
      document.documentElement.dataset.theme = "light";
      const current = textOf(".sess[aria-current]");
      if (!current.includes(spec.title)) clickIncludes(".sess", spec.title);
      const chip = document.getElementById("btn-simulator");
      const pane = document.getElementById("sim-pane");
      if (current.includes(spec.title) && chip && !chip.hidden) {
        if (chip.getAttribute("aria-expanded") !== "true") chip.click();
      }
      const text = pane ? (pane.textContent || "") : "";
      const open = !!(pane && !pane.hidden && chip && chip.getAttribute("aria-expanded") === "true");
      const img = document.querySelector("#sim-pane img");
      const contentOk = spec.mode === "needs-mac"
        ? text.includes(spec.needsMac) && text.includes(spec.emptyDevice)
        : text.includes(spec.device) && text.includes(spec.fixtureBanner) && !!(img && img.src && img.src.startsWith("data:"));
      if (open && contentOk) {
        const layout = layoutOf();
        if (layout.ok) return { ok: true, tail: text.slice(0, 240), layout: layout.boxes };
        layoutError = layout.error;
      }
      await sleep(200);
    }
    const pane = document.getElementById("sim-pane");
    return { ok: false, error: layoutError || ("timed out waiting for " + spec.mode), tail: pane ? (pane.textContent || "").slice(0, 240) : "" };
  })()`;
}
