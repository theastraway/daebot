// Auto-update controller (testable: every side effect is injected). main.mjs only wires it to Electron.
//
// Feed: electron-updater "generic" provider on the same static folder the installers are served from:
//   https://download.m-i-n-d.ai/download/daebot/   latest-mac.yml (+ zip), latest.yml (win x64), latest-arm64.yml (win arm64),
//   latest-linux.yml (AppImage). Windows x64 and arm64 would both write latest.yml, so arm64 builds publish under the
//   channel "latest-arm64" and the app picks its channel by process.arch (feedChannel()).
// Behaviour: background download (autoDownload), install on quit (autoInstallOnAppQuit), a check ~20 s after launch and then
// every 6 h, a "Check for updates..." menu item, and a "Restart now / Later" dialog once an update is downloaded.

export const FEED_URL = "https://download.m-i-n-d.ai/download/daebot/";
export const FIRST_CHECK_DELAY_MS = 20_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** electron-updater channel for this machine: latest.yml everywhere, latest-arm64.yml for Windows on ARM. */
export function feedChannel({ platform, arch }) {
  return platform === "win32" && arch === "arm64" ? "latest-arm64" : "latest";
}

/** Why the updater must stay off, or null when it may run. Smoke runs and unpackaged dev runs never touch the network. */
export function updaterDisabledReason({ isPackaged, smoke, platform, env = {} }) {
  if (smoke) return "smoke run";
  if (!isPackaged) return "not a packaged app";
  if (env.DAEBOT_DISABLE_UPDATES === "1") return "DAEBOT_DISABLE_UPDATES=1";
  if (platform === "linux") return env.APPIMAGE ? null : "Linux updates need the AppImage (a .deb is updated with the package manager)";
  if (platform !== "darwin" && platform !== "win32") return `unsupported platform ${platform}`;
  return null;
}

const noopLog = () => {};

export function createUpdater({
  loadAutoUpdater, // async () => electron-updater's autoUpdater (loaded only when enabled)
  dialog, // { showMessageBox(opts) -> Promise<{ response }> }
  platform, arch, version, env = {}, isPackaged, smoke = false,
  prepareForInstall = async () => {}, // quiesce the app (stop the gateway, let windows close) before quitAndInstall
  onInstallAborted = () => {}, // quitAndInstall failed after prepareForInstall: bring the app back
  onChange = () => {}, // state changed: rebuild the menus
  log = noopLog,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  feedUrl = FEED_URL,
}) {
  const disabledReason = updaterDisabledReason({ isPackaged, smoke, platform, env });
  const enabled = disabledReason === null;
  let au = null;
  let started = false;
  let installing = false;
  let promptedVersion = null;
  let firstTimer = null;
  let intervalTimer = null;
  const state = { status: enabled ? "idle" : "disabled", currentVersion: version, nextVersion: null, percent: 0, error: null, lastCheckedAt: null };

  const set = (patch) => { Object.assign(state, patch); try { onChange({ ...state }); } catch { /* menus must never break updates */ } };
  const say = (opts) => Promise.resolve(dialog.showMessageBox(opts)).catch(() => ({ response: 1 }));

  async function promptRestart() {
    if (installing || state.status !== "downloaded" || promptedVersion === state.nextVersion) return;
    promptedVersion = state.nextVersion;
    const { response } = await say({
      type: "info", buttons: ["Restart now", "Later"], defaultId: 0, cancelId: 1,
      title: "Update ready", message: `Daebot ${state.nextVersion} is ready`,
      detail: "Restart Daebot to finish updating. If you choose Later, the update installs the next time you quit Daebot.",
    });
    if (response === 0) await install();
  }

  function wire() {
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;
    au.allowDowngrade = false;
    au.allowPrerelease = false;
    au.autoRunAppAfterInstall = true;
    au.setFeedURL({ provider: "generic", url: feedUrl, channel: feedChannel({ platform, arch }) });
    au.logger = { info: (m) => log(`info ${m}`), warn: (m) => log(`warn ${m}`), error: (m) => log(`error ${m}`), debug: () => {} };
    au.on("checking-for-update", () => set({ status: "checking", error: null }));
    au.on("update-available", (i) => { log(`update-available ${i?.version}`); set({ status: "available", nextVersion: i?.version ?? null, percent: 0, lastCheckedAt: Date.now() }); });
    au.on("update-not-available", () => { set({ status: "not-available", nextVersion: null, percent: 0, lastCheckedAt: Date.now() }); });
    au.on("download-progress", (p) => set({ status: "downloading", percent: Math.round(p?.percent ?? 0) }));
    au.on("update-downloaded", (i) => {
      log(`update-downloaded ${i?.version}`);
      set({ status: "downloaded", nextVersion: i?.version ?? state.nextVersion, percent: 100, lastCheckedAt: Date.now() });
      void promptRestart();
    });
    au.on("error", (e) => {
      const message = String(e?.message ?? e);
      log(`error ${message}`);
      const wasInstalling = installing;
      installing = false;
      // A failed download leaves nothing to install; a failed install leaves the app running with an update still staged.
      set({ status: wasInstalling ? "downloaded" : "error", error: message, lastCheckedAt: Date.now() });
      if (wasInstalling) { try { onInstallAborted(message); } catch { /* ignore */ } }
    });
  }

  /** Check now. `manual` (menu click) reports the outcome in a dialog; the scheduled checks stay silent. */
  async function check(reason = "timer", { manual = false } = {}) {
    if (!enabled || !au) return { ...state };
    if (state.status === "downloaded") {
      if (manual) { promptedVersion = null; await promptRestart(); }
      return { ...state };
    }
    if (state.status === "checking" || state.status === "downloading" || installing) return { ...state };
    log(`check (${reason}) from ${state.currentVersion}`);
    try {
      const res = await au.checkForUpdates();
      res?.downloadPromise?.catch?.(() => {}); // the "error" event already reports a failed download
    } catch (e) {
      const message = String(e?.message ?? e);
      log(`check failed: ${message}`);
      set({ status: "error", error: message, lastCheckedAt: Date.now() });
    }
    if (manual) {
      if (state.status === "not-available") await say({ type: "info", buttons: ["OK"], title: "Check for updates", message: "Daebot is up to date", detail: `You have the latest version (${state.currentVersion}).` });
      else if (state.status === "error") await say({ type: "warning", buttons: ["OK"], title: "Check for updates", message: "Could not check for updates", detail: state.error ?? "Try again in a moment." });
      else if (state.status === "available" || state.status === "downloading") await say({ type: "info", buttons: ["OK"], title: "Check for updates", message: `Daebot ${state.nextVersion} is downloading`, detail: "It downloads in the background. You will be asked to restart when it is ready." });
    }
    return { ...state };
  }

  /** Restart now: quiesce the app, then quitAndInstall. Returns false when nothing is downloaded. */
  async function install() {
    if (!enabled || !au || state.status !== "downloaded" || installing) return false;
    installing = true;
    log(`install ${state.nextVersion}`);
    try {
      await prepareForInstall();
      // Windows runs the NSIS installer silently and relaunches; macOS swaps the bundle (Squirrel.Mac) and reopens.
      au.quitAndInstall(platform === "win32", true);
      return true;
    } catch (e) {
      installing = false;
      log(`install failed: ${e?.message ?? e}`);
      try { onInstallAborted(String(e?.message ?? e)); } catch { /* ignore */ }
      return false;
    }
  }

  /** Called from the app's before-quit once it has stopped the gateway: apply a downloaded update on the way out. */
  function installOnQuit() {
    if (!enabled || !au || state.status !== "downloaded" || installing) return false;
    installing = true;
    log(`install on quit ${state.nextVersion}`);
    try { au.quitAndInstall(true, false); return true; } catch (e) { installing = false; log(`install on quit failed: ${e?.message ?? e}`); return false; }
  }

  async function start() {
    if (!enabled) { log(`updates off: ${disabledReason}`); return false; }
    if (started) return true;
    started = true;
    au = await loadAutoUpdater();
    wire();
    log(`ready: v${version} ${platform}-${arch} channel ${feedChannel({ platform, arch })}, first check in ${FIRST_CHECK_DELAY_MS / 1000}s, then every ${CHECK_INTERVAL_MS / 3_600_000}h`);
    firstTimer = timers.setTimeout(() => { void check("launch"); }, FIRST_CHECK_DELAY_MS);
    intervalTimer = timers.setInterval(() => { void check("timer"); }, CHECK_INTERVAL_MS);
    firstTimer?.unref?.(); intervalTimer?.unref?.();
    return true;
  }

  function stop() {
    if (firstTimer) timers.clearTimeout(firstTimer);
    if (intervalTimer) timers.clearInterval(intervalTimer);
    firstTimer = intervalTimer = null;
  }

  /** The menu entry for the current state, or null when updates are off (smoke, dev, a .deb). Same shape the menu builders take. */
  function menuItem() {
    if (!enabled) return null;
    switch (state.status) {
      case "downloaded": return { label: `Restart to Update to ${state.nextVersion}...`, enabled: true, click: () => { void install(); } };
      case "available": case "downloading": return { label: state.percent > 0 ? `Downloading update ${state.nextVersion}... ${state.percent}%` : `Downloading update ${state.nextVersion}...`, enabled: false };
      case "checking": return { label: "Checking for updates...", enabled: false };
      default: return { label: "Check for updates...", enabled: true, click: () => { void check("menu", { manual: true }); } };
    }
  }

  return { enabled, disabledReason, start, stop, check, install, installOnQuit, menuItem, getState: () => ({ ...state }) };
}
