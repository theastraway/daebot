// Daebot desktop shell (Electron main process). Thin: it starts the gateway as a child, waits for /health,
// and shows the existing web UI. All decisions live in src/lib/* (unit-tested); this file is glue.
import { app, BrowserWindow, Tray, Menu, powerSaveBlocker, globalShortcut, Notification, ipcMain, shell, nativeImage, nativeTheme, screen, session, dialog, systemPreferences } from "electron";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildGateway, waitForHealth } from "./lib/child.mjs";
import { buildSpawnPlan, findBundledBinary, findNode } from "./lib/launcher.mjs";
import { clearKey, readConfigJson, readKey, resolveSignIn, saveKey, looksLikeMindKey } from "./lib/credentials.mjs";
import { AccountStore, accountsPath, dataDirFor } from "./lib/accounts.mjs";
import { buildSignInPage } from "./lib/signin-page.mjs";
import { signInWithMind } from "./lib/mind-signin.mjs";
import { loadConfig, saveKernelMode, saveKeepWorking, configPath, statePath, loadState, writeJson, resolveBounds, desktopHome } from "./lib/config.mjs";
import { isKernelMode } from "./lib/kernel.mjs";
import { migrateHome } from "./lib/home.mjs";
import { applyKeepWorking } from "./lib/keepworking.mjs";
import { installMediaPermissions } from "./lib/media-permission.mjs";
import { buildAppMenuTemplate, buildTrayTemplate } from "./lib/menu.mjs";
import { buildLoadUrl, classifyUrl, originOf, redactUrl } from "./lib/allowlist.mjs";
import { buildConfirmNotification, createRateLimiter, shouldNotify, validateNotifyPayload } from "./lib/notify.mjs";
import { ConfirmWatcher } from "./lib/watcher.mjs";
import { createUpdater } from "./lib/updater.mjs";
import { CALENDAR_CHANNEL, createCalendarBridge, createCalendarHandler, findCalendarHelper } from "./lib/calendar.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes("--mindclaw-smoke");
const log = (...a) => process.stderr.write(`[daebot-desktop] ${a.join(" ")}\n`);

// --- process-level hygiene (before ready) ---
app.disableHardwareAcceleration(); // text UI: software rendering is plenty and drops the always-on GPU process (~70 MB)
app.commandLine.appendSwitch("use-mock-keychain"); // never touch the login keychain (no "Safe Storage" prompt)
if (SMOKE) {
  app.setPath("userData", mkdtempSync(join(tmpdir(), "mindclaw-desktop-smoke-")));
  app.setActivationPolicy?.("accessory");
  app.dock?.hide();
}
const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) app.quit();
// Daebot's home is ~/.daebot. A pre-rename install has ~/.mindclaw: move it once, here, before anything reads desktop.json, accounts.json or
// mind-key and before the gateway child starts (lib/home.mjs; if the move fails this run keeps using ~/.mindclaw and the child follows).
if (!SMOKE && gotLock) migrateHome(process.env, log);

let config = loadConfig(SMOKE ? join(app.getPath("userData"), "desktop.json") : configPath());
const agentRoot = app.isPackaged ? join(process.resourcesPath, "agent") : resolve(here, "..", "..");
const entry = join(here, "child-entry.mjs");
const smokeHome = SMOKE ? app.getPath("userData") : null;
// The packaged app runs the bun-compiled binary from resources/bin; development falls back to node + child-entry.mjs.
const bundledBinary = app.isPackaged && !SMOKE ? findBundledBinary({ resourcesPath: process.resourcesPath }) : null;
let mindKey = null; // from the sign-in file; handed to the gateway child through its environment only, never logged
const accounts = new AccountStore(SMOKE ? join(app.getPath("userData"), "accounts.json") : accountsPath()); // every remembered MIND account (keys stay here)
let activeAcct = null; // the account the gateway child is running as; picks its own data directory

let win = null;
let tray = null;
let quitting = false;
let gatewayInfo = null; // { url, token, origin }
let watcher = null;
const notifyAllowed = createRateLimiter(5, 10_000);

const gateway = new ChildGateway({
  spawn,
  plan: () => buildSpawnPlan({
    agentRoot, entry,
    binaryPath: bundledBinary,
    mindKey: mindKey ?? undefined,
    dataDir: dataDirFor(activeAcct),
    kernelMode: config.kernelMode,
    nodePath: findNode(),
    electronPath: process.execPath,
    baseEnv: process.env,
    fake: SMOKE,
    tokenPath: smokeHome ? join(smokeHome, "gateway-token") : undefined,
  }),
});
gateway.on("log", (s) => log("gateway:", s.trim().slice(0, 300)));

// ---------- window ----------
function bounds() {
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  return resolveBounds(loadState(SMOKE ? join(smokeHome, "state.json") : statePath()).bounds, areas);
}

function saveBounds() {
  if (SMOKE || !win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    writeJson(statePath(), { ...loadState(), bounds: { ...b, maximized: win.isMaximized() } });
  } catch (e) { log("could not save window state:", String(e?.message ?? e)); }
}

function createWindow() {
  const b = bounds();
  win = new BrowserWindow({
    ...b,
    minWidth: 480, minHeight: 360,
    show: false,
    title: "Daebot",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#14161c" : "#f6f6f4",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      partition: "mindclaw", // no "persist:" prefix: in-memory, so no cookie/keychain storage on disk
    },
  });
  if (b.maximized) win.maximize();
  const wc = win.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    if (classifyUrl(url, gatewayInfo?.origin) === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
  const guard = (e, url) => {
    const kind = classifyUrl(url, gatewayInfo?.origin);
    if (kind === "internal") return;
    e.preventDefault();
    if (kind === "external") void shell.openExternal(url);
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  wc.on("will-attach-webview", (e) => e.preventDefault());

  win.on("close", (e) => {
    saveBounds();
    if (!quitting && !SMOKE) { e.preventDefault(); win.hide(); refreshTray(); }
  });
  win.on("show", () => { clearTimeout(trimTimer); refreshTray(); });
  win.on("hide", () => { scheduleTrim(); refreshTray(); });
  win.on("closed", () => { clearTimeout(trimTimer); win = null; });
  win.on("resized", saveBounds);
  win.on("moved", saveBounds);
  win.once("ready-to-show", () => { if (!SMOKE) win.show(); });
  return win;
}

// Idle RAM: a hidden window still holds a renderer + GPU process. Destroy it after idleTrimSeconds hidden;
// showWindow() recreates it. Sessions live in the gateway, so nothing but the on-screen transcript is lost.
let trimTimer = null;
function trimWindow() {
  if (!win || win.isDestroyed() || win.isVisible()) return;
  saveBounds();
  win.destroy();
  win = null;
  refreshTray();
}
function scheduleTrim() {
  clearTimeout(trimTimer);
  if (!config.idleTrimSeconds || quitting) return;
  trimTimer = setTimeout(trimWindow, config.idleTrimSeconds * 1000);
  trimTimer.unref?.();
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(), void loadUi();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus?.({ steal: true });
}
const hideWindow = () => { if (win && !win.isDestroyed()) win.hide(); };
const toggleWindow = () => (win && !win.isDestroyed() && win.isVisible() && win.isFocused() ? hideWindow() : showWindow());

function newSession() {
  showWindow();
  win.webContents.executeJavaScript("document.getElementById('btn-new')?.click()", true).catch(() => {});
}

// ---------- loading the UI ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function errorPage(message) {
  const dark = nativeTheme.shouldUseDarkColors;
  const html = `<!doctype html><meta charset=utf-8><title>Daebot</title><style>
  body{font:15px -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:${dark ? "#14161c" : "#f6f6f4"};color:${dark ? "#e8e8ea" : "#1c1c1e"}}
  main{max-width:520px;padding:32px}h1{font-size:20px;margin:0 0 8px}p{line-height:1.5;opacity:.8}code{font:13px ui-monospace,monospace}</style>
  <main><h1>Daebot could not start its gateway</h1><p>${esc(message)}</p><p>Fix the issue, then choose <b>Kernel mode</b> from the menu bar item (any mode) or quit and reopen the app.</p></main>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

async function startGateway() {
  const info = await gateway.start();
  await waitForHealth(info.url);
  gatewayInfo = { ...info, origin: originOf(info.url) };
  startWatcher();
  return gatewayInfo;
}

async function loadUi() {
  if (!win || win.isDestroyed()) return;
  try {
    if (!gatewayInfo) await startGateway();
    log("loading", redactUrl(buildLoadUrl(gatewayInfo.url, gatewayInfo.token)));
    win.webContents.once("did-fail-load", (_e, c, d, u) => log("did-fail-load", c, d, redactUrl(u)));
    await win.loadURL(buildLoadUrl(gatewayInfo.url, gatewayInfo.token));
    if (SMOKE) log("smoke: loaded");
  } catch (e) {
    log("startup failed:", String(e?.message ?? e));
    await win.loadURL(errorPage(String(e?.message ?? e))).catch(() => {});
    if (SMOKE) smokeFail(String(e?.message ?? e));
  }
}

// ---------- confirm-event watcher -> native notification ----------
function startWatcher() {
  stopWatcher();
  if (!gatewayInfo) return;
  const { url, token } = gatewayInfo;
  const wsUrl = new URL("/ws", url);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("token", token);
  watcher = new ConfirmWatcher({
    listSessions: async () => {
      const r = await fetch(new URL("/sessions", url), { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`sessions ${r.status}`);
      return (await r.json()).sessions ?? [];
    },
    connect: () => {
      const ws = new WebSocket(wsUrl.toString());
      const s = {
        onmessage: null, onclose: null,
        send: (t) => { if (ws.readyState === 1) ws.send(t); },
        close: () => { try { ws.close(); } catch { /* ignore */ } },
      };
      const pending = [];
      ws.onopen = () => { for (const t of pending.splice(0)) ws.send(t); };
      const rawSend = s.send;
      s.send = (t) => (ws.readyState === 0 ? pending.push(t) : rawSend(t));
      ws.onmessage = (ev) => s.onmessage?.(typeof ev.data === "string" ? ev.data : String(ev.data));
      ws.onclose = () => s.onclose?.();
      ws.onerror = () => {};
      return s;
    },
    onConfirm: (event) => {
      const focused = !!win && !win.isDestroyed() && win.isVisible() && win.isFocused();
      if (!shouldNotify(event, { visible: !!win && win.isVisible(), focused })) return;
      showNotification(buildConfirmNotification(event));
    },
  });
  watcher.start();
}
function stopWatcher() { watcher?.stop(); watcher = null; }

function showNotification({ title, body }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on("click", showWindow);
  n.show();
}

ipcMain.on("desktop:signout", (e, opts) => {
  if (classifyUrl(e.senderFrame?.url ?? "", gatewayInfo?.origin) !== "internal") return; // only our own UI
  void signOut({ all: !!(opts && typeof opts === "object" && opts.all === true) });
});

// Remembered accounts. The UI sees { id, name, active } only; keys never leave this process.
ipcMain.handle("desktop:accounts-list", (e) => (fromOurUi(e) ? accounts.publicList() : []));
ipcMain.handle("desktop:account-switch", async (e, id) => (fromOurUi(e) && typeof id === "string" ? switchAccount(id) : { ok: false }));
ipcMain.handle("desktop:account-add", async (e) => (fromOurUi(e) ? addAccount() : { ok: false }));

// In-window update control (the Updates bar in the sidebar). Same controller as the tray and app menu.
const fromOurUi = (e) => classifyUrl(e.senderFrame?.url ?? "", gatewayInfo?.origin) === "internal";
// Apple Calendar (Mac only): the bundled EventKit helper, run once per call and answered to our own window only. On other systems the channel
// does not exist and the preload exposes no `calendar`, so the web UI sees no Calendar bridge.
if (process.platform === "darwin") {
  const helperPath = findCalendarHelper({ resourcesPath: app.isPackaged ? process.resourcesPath : undefined, devDir: join(here, "..", "build", "bin") });
  ipcMain.handle(CALENDAR_CHANNEL, createCalendarHandler({ bridge: createCalendarBridge({ helperPath, spawn }), isOurUi: fromOurUi }));
}
const publicUpdateState = (s) => ({ enabled: updater.enabled, status: s.status, currentVersion: s.currentVersion, nextVersion: s.nextVersion, percent: s.percent, error: s.error ? String(s.error).slice(0, 300) : null });
function sendUpdateState(s) { try { if (win && !win.isDestroyed()) win.webContents.send("desktop:update-state", publicUpdateState(s)); } catch { /* window going away */ } }
ipcMain.handle("desktop:update-get", (e) => (fromOurUi(e) ? publicUpdateState(updater.getState()) : null));
ipcMain.handle("desktop:update-check", async (e) => (fromOurUi(e) ? publicUpdateState(await updater.check("window", { manual: true })) : null));
ipcMain.handle("desktop:update-install", async (e) => (fromOurUi(e) ? updater.install() : false));

ipcMain.on("desktop:notify", (e, payload) => {
  if (classifyUrl(e.senderFrame?.url ?? "", gatewayInfo?.origin) !== "internal") return; // only our own UI
  const p = validateNotifyPayload(payload);
  if (!p || !notifyAllowed()) return;
  showNotification(p);
});

// ---------- sign-in (first run): one pasted MIND API key ----------
const mindBaseUrl = () => (process.env.MIND_BASE_URL || readConfigJson(join(desktopHome(), "config.json")).mindBaseUrl || "https://m-i-n-d.ai/developer/v1").replace(/\/+$/, "");

/** Asks MIND whether the key works. Resolves { ok } or { ok:false, error }; the key is never echoed in the error. */
async function checkKey(key) {
  if (!looksLikeMindKey(key)) return { ok: false, error: "That does not look like a MIND API key. It starts with mind_." };
  try {
    const r = await fetch(`${mindBaseUrl()}/profile`, { headers: { "X-API-Key": key.trim(), accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 401 || r.status === 403) return { ok: false, error: "MIND did not accept that key." };
    if (!r.ok) return { ok: false, error: "MIND could not check that key right now. Try again in a moment." };
    const j = await r.json().catch(() => ({}));
    return { ok: true, username: typeof j?.username === "string" ? j.username.slice(0, 80) : "" };
  } catch {
    return { ok: false, error: "Could not reach MIND. Check your connection and try again." };
  }
}

/** Shows the sign-in window and resolves with the saved key, or null if the window was closed. */
function promptForKey() {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 460, height: 500, resizable: false, minimizable: false, maximizable: false, show: false, title: "Sign in to Daebot",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#0c0b0a" : "#fbf6ee",
      webPreferences: { preload: join(here, "signin-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false, partition: "daebot-signin" },
    });
    let done = false;
    const browserFlow = new AbortController();
    const finish = (v) => { if (done) return; done = true; browserFlow.abort(); ipcMain.removeHandler("daebot:signin"); ipcMain.removeHandler("daebot:signin-mind"); if (!w.isDestroyed()) w.destroy(); resolve(v); };
    let mindFlowRunning = false;
    ipcMain.handle("daebot:signin-mind", async (e) => {
      if (e.sender !== w.webContents) return { ok: false, error: "Sign-in failed." };
      if (mindFlowRunning) return { ok: false, error: "Sign-in is already open in your browser." };
      mindFlowRunning = true;
      try {
        const key = await signInWithMind({ mindBaseUrl: mindBaseUrl(), openExternal: (url) => shell.openExternal(url), signal: browserFlow.signal });
        const c = await checkKey(key);
        if (!c.ok) return c;
        try { saveKey(key); } catch { return { ok: false, error: "Could not save your sign-in on this computer." }; }
        if (!w.isDestroyed()) { w.show(); w.focus(); }
        setTimeout(() => finish(key.trim()), 400);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Sign-in failed." };
      } finally {
        mindFlowRunning = false;
      }
    });
    ipcMain.handle("daebot:signin", async (e, key) => {
      if (e.sender !== w.webContents || typeof key !== "string") return { ok: false, error: "Sign-in failed." };
      const c = await checkKey(key);
      if (!c.ok) return c;
      try { saveKey(key); } catch { return { ok: false, error: "Could not save the key on this computer." }; }
      setTimeout(() => finish(key.trim()), 400);
      return { ok: true };
    });
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", (e) => e.preventDefault());
    w.on("closed", () => finish(null));
    w.once("ready-to-show", () => { w.show(); w.focus(); });
    void w.loadURL(buildSignInPage({ dark: nativeTheme.shouldUseDarkColors }));
  });
}

/** Resolves the billing mode and, on first run, asks for the key. Returns false if the user closed the prompt. */
async function ensureSignedIn() {
  if (SMOKE) return true;
  // A remembered account wins: its key is the active one, and the legacy key file mirrors it.
  const a = accounts.active();
  if (a) {
    activeAcct = a;
    mindKey = a.key;
    if (readKey() !== a.key) { try { saveKey(a.key); } catch { /* the store still has it */ } }
    return true;
  }
  const saved = readKey();
  const r = resolveSignIn({ env: process.env, saved, config: readConfigJson(join(desktopHome(), "config.json")) });
  if (r.mode === "mind") {
    mindKey = r.key ?? null;
    // First run with accounts: the key that was already signed in becomes the first remembered account and keeps its existing chats (default data directory).
    if (saved && r.key) { await registerAccount(saved, { legacy: true }); }
    return true;
  }
  if (r.mode === "openrouter") { mindKey = null; return true; }
  const k = await promptForKey();
  mindKey = k;
  if (k) await registerAccount(k);
  return k !== null;
}

/** Remembers a key as an account (name looked up from MIND, best effort) and makes it the active one. */
async function registerAccount(key, { legacy = false } = {}) {
  let name = "";
  try { const c = await checkKey(key); if (c.ok) name = c.username ?? ""; } catch { /* the name is cosmetic */ }
  try { accounts.add({ key, name, legacy }); } catch (e) { log("could not remember the account:", String(e?.message ?? e)); return; }
  activeAcct = accounts.active() ?? null;
}

/** Restarts the gateway child as the (new) active account and reloads the window. Nothing of the previous account stays loaded. */
async function restartAsActive() {
  stopWatcher();
  gatewayInfo = null;
  await gateway.stop();
  if (win && !win.isDestroyed()) await loadUi();
}

async function switchAccount(id) {
  const a = accounts.switchTo(id);
  if (!a) return { ok: false, error: "That account is not remembered on this computer." };
  try { saveKey(a.key); } catch (e) { log("could not mirror the sign-in:", String(e?.message ?? e)); }
  activeAcct = a;
  mindKey = a.key;
  await restartAsActive();
  return { ok: true, name: a.name };
}

let addingAccount = false;
async function addAccount() {
  if (addingAccount) return { ok: false, error: "Sign-in is already open." };
  addingAccount = true;
  const prevKey = readKey();
  try {
    const k = await promptForKey();
    if (!k) { // closed without signing in: put the previous mirror back (promptForKey saved the new key only on success)
      if (prevKey && readKey() !== prevKey) { try { saveKey(prevKey); } catch { /* mirror only */ } }
      return { ok: false, cancelled: true };
    }
    await registerAccount(k);
    mindKey = k;
    await restartAsActive();
    return { ok: true };
  } finally { addingAccount = false; }
}

async function signOut(opts = {}) {
  const cur = accounts.active();
  // Sign out of the ACTIVE account only; another remembered account takes over. "Sign out of all" (or the last account) goes to the sign-in window.
  if (cur && opts.all !== true) {
    const next = accounts.remove(cur.id);
    if (next) {
      try { saveKey(next.key); } catch { /* mirror only */ }
      activeAcct = next;
      mindKey = next.key;
      await restartAsActive();
      return;
    }
  }
  accounts.clear();
  activeAcct = null;
  clearKey();
  mindKey = null;
  stopWatcher();
  gatewayInfo = null;
  await gateway.stop();
  if (win && !win.isDestroyed()) win.hide();
  if (!(await ensureSignedIn())) return app.quit();
  showWindow();
}

// ---------- kernel mode ----------
async function setKernelMode(mode) {
  if (!isKernelMode(mode) || mode === config.kernelMode) return refreshTray();
  config = { ...config, kernelMode: mode };
  if (!SMOKE) { try { saveKernelMode(mode); } catch (e) { log("could not save kernel mode:", String(e?.message ?? e)); } }
  stopWatcher();
  gatewayInfo = null;
  try {
    await gateway.stop();
  } finally {
    refreshTray();
  }
  await loadUi();
}

// ---------- tray + menus ----------
let keepWorkingId = null;
function setKeepWorking(on) {
  config = { ...config, keepWorking: !!on };
  if (!SMOKE) { try { saveKeepWorking(!!on); } catch (e) { log("could not save keep-working:", String(e?.message ?? e)); } }
  keepWorkingId = applyKeepWorking({ powerSaveBlocker, enabled: config.keepWorking, current: keepWorkingId });
  refreshTray();
}
const handlers = { toggle: toggleWindow, newSession, setKernelMode, setKeepWorking, signOut, quit: () => app.quit(), hideWindow };

// Auto-update (electron-updater, generic feed; see lib/updater.mjs). Off in --mindclaw-smoke and in unpackaged runs.
const updater = createUpdater({
  loadAutoUpdater: () => createRequire(import.meta.url)("electron-updater").autoUpdater, // CJS; loaded only when updates are on
  dialog, platform: process.platform, arch: process.arch, version: app.getVersion(), env: process.env,
  isPackaged: app.isPackaged, smoke: SMOKE,
  log,
  // quitAndInstall must not be blocked by the hide-on-close window or the before-quit handler: flag the quit, stop the gateway
  // ourselves, and the window "close" / "before-quit" guards then step aside.
  prepareForInstall: async () => {
    quitting = true;
    stopWatcher();
    saveBounds();
    await Promise.race([gateway.stop(), new Promise((r) => setTimeout(r, 5000))]);
  },
  onInstallAborted: () => { quitting = false; void loadUi(); },
  onChange: (s) => { refreshTray(); applyAppMenu(); sendUpdateState(s); },
});

function applyAppMenu() {
  if (SMOKE) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate({ handlers, isMac: process.platform === "darwin", update: updater.menuItem() })));
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate({
    windowVisible: !!win && !win.isDestroyed() && win.isVisible(),
    kernelMode: config.kernelMode, shortcut: config.shortcut, handlers, update: updater.menuItem(), keepWorking: config.keepWorking,
  })));
}

function createTray() {
  const img = nativeImage.createFromPath(join(here, "assets", "trayTemplate.png"));
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip("Daebot");
  tray.on("click", toggleWindow);
  refreshTray();
}

function registerShortcut() {
  if (!config.shortcut) return;
  try {
    if (!globalShortcut.register(config.shortcut, showWindow)) log(`shortcut ${config.shortcut} is taken by another app; not registered`);
  } catch (e) { log("invalid shortcut:", String(e?.message ?? e)); }
}

// ---------- lifecycle ----------
gateway.on("crashed", async ({ code, signal }) => {
  if (quitting) return;
  log(`gateway exited unexpectedly (${code ?? signal}); restarting`);
  stopWatcher();
  gatewayInfo = null;
  await loadUi();
});

app.on("second-instance", showWindow);
app.on("activate", showWindow);
app.on("window-all-closed", () => {}); // menu bar app: keep running
app.on("will-quit", () => { keepWorkingId = applyKeepWorking({ powerSaveBlocker, enabled: false, current: keepWorkingId }); updater.stop(); globalShortcut.unregisterAll(); });
app.on("before-quit", (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  stopWatcher();
  saveBounds();
  // A downloaded update is applied on the way out (electron-updater's quit hook may not run after app.exit).
  Promise.race([gateway.stop(), new Promise((r) => setTimeout(r, 5000))]).finally(() => {
    if (updater.installOnQuit()) setTimeout(() => app.exit(0), 15_000).unref?.();
    else app.exit(0);
  });
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => app.quit());

// ---------- smoke (headless: hidden window, no tray, no shortcut, no Dock) ----------
function smokeFail(msg) {
  try { writeFileSync(join(smokeOut(), "result.json"), JSON.stringify({ ok: false, error: msg }, null, 2)); } catch { /* ignore */ }
  quitting = true;
  gateway.stop().finally(() => app.exit(1));
}
const smokeOut = () => { const d = join(here, "..", "smoke"); mkdirSync(d, { recursive: true }); return d; };

async function runSmoke() {
  const hard = setTimeout(() => { log("smoke: hard timeout"); try { gateway.child?.kill("SIGKILL"); } catch { /* ignore */ } app.exit(2); }, 20_000);
  hard.unref?.();
  log("smoke: start");
  const probe = `({ title: document.title, hasNew: !!document.getElementById('btn-new'), bodyText: document.body.innerText.slice(0, 200), api: typeof window.mindclawDesktop, sandboxed: typeof require, url: location.origin })`;
  let state = null;
  for (let i = 0; i < 30; i++) {
    state = await Promise.race([win.webContents.executeJavaScript(probe, true).catch((e) => ({ err: String(e) })), new Promise((r) => setTimeout(() => r({ err: "exec timeout" }), 2000))]);
    if (i === 0) log("smoke: first probe", JSON.stringify(state));
    if (state?.hasNew) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  log("smoke: probed", JSON.stringify(state));
  await new Promise((r) => setTimeout(r, 800)); // let the first paint and session list settle
  log("smoke: capturing");
  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  const out = smokeOut();
  writeFileSync(join(out, "ui.png"), png);
  // Memory: sum Electron processes (working set, KB) + the gateway child (rss via ps, our own pid only).
  const measure = () => {
    const metrics = app.getAppMetrics();
    const electronMb = metrics.reduce((s, m) => s + (m.memory?.workingSetSize ?? 0), 0) / 1024;
    let childMb = null;
    try { childMb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(gateway.child.pid)], { encoding: "utf8" }).trim()) / 1024; } catch { /* ignore */ }
    return {
      electronProcesses: metrics.map((m) => ({ type: m.type, mb: Math.round((m.memory?.workingSetSize ?? 0) / 1024) })),
      electronMb: Math.round(electronMb), gatewayChildMb: childMb === null ? null : Math.round(childMb), totalMb: Math.round(electronMb + (childMb ?? 0)),
    };
  };
  const loaded = measure();
  // Idle scenario: destroy the (hidden) window like idle-trim does, give Chromium a moment, measure again.
  trimWindow();
  await new Promise((r) => setTimeout(r, 4000));
  const idle = measure();
  const result = {
    idleAfterTrim: idle,
    ok: !!state?.hasNew && png.length > 5000,
    state, pngBytes: png.length, size: img.getSize(),
    windowLoaded: loaded,
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
  };
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
  clearTimeout(hard);
  quitting = true;
  await gateway.stop();
  app.exit(result.ok ? 0 : 1);
}

/** macOS asks the user once (then remembers); a "denied" in System Settings stays denied until they change it there. */
async function askMicAccess() {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  if (status === "denied" || status === "restricted") return false;
  return systemPreferences.askForMediaAccess("microphone");
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  nativeTheme.themeSource = "system";
  const ses = session.fromPartition("mindclaw");
  // Everything is denied except the microphone for our own UI (mic button, hands-free). On macOS this shows the system prompt.
  installMediaPermissions(ses, { getOrigin: () => gatewayInfo?.origin, askOs: askMicAccess, log });
  if (!SMOKE) {
    applyAppMenu();
    createTray();
    keepWorkingId = applyKeepWorking({ powerSaveBlocker, enabled: config.keepWorking, current: keepWorkingId });
    registerShortcut();
  }
  if (!(await ensureSignedIn())) return app.quit();
  createWindow();
  const loading = loadUi();
  void updater.start().catch((e) => log("updater did not start:", String(e?.message ?? e)));
  if (SMOKE) { await loading; if (gatewayInfo) await runSmoke(); }
});
