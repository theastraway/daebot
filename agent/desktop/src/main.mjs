// MINDClaw desktop shell (Electron main process). Thin: it starts the gateway as a child, waits for /health,
// and shows the existing web UI. All decisions live in src/lib/* (unit-tested); this file is glue.
import { app, BrowserWindow, Tray, Menu, globalShortcut, Notification, ipcMain, shell, nativeImage, nativeTheme, screen, session } from "electron";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildGateway, waitForHealth } from "./lib/child.mjs";
import { buildSpawnPlan, findNode } from "./lib/launcher.mjs";
import { loadConfig, saveKernelMode, configPath, statePath, loadState, writeJson, resolveBounds } from "./lib/config.mjs";
import { isKernelMode } from "./lib/kernel.mjs";
import { buildAppMenuTemplate, buildTrayTemplate } from "./lib/menu.mjs";
import { buildLoadUrl, classifyUrl, originOf, redactUrl } from "./lib/allowlist.mjs";
import { buildConfirmNotification, createRateLimiter, shouldNotify, validateNotifyPayload } from "./lib/notify.mjs";
import { ConfirmWatcher } from "./lib/watcher.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes("--mindclaw-smoke");
const log = (...a) => process.stderr.write(`[mindclaw-desktop] ${a.join(" ")}\n`);

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

let config = loadConfig(SMOKE ? join(app.getPath("userData"), "desktop.json") : configPath());
const agentRoot = app.isPackaged ? join(process.resourcesPath, "agent") : resolve(here, "..", "..");
const entry = join(here, "child-entry.mjs");
const smokeHome = SMOKE ? app.getPath("userData") : null;

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
    title: "MINDClaw",
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
  const html = `<!doctype html><meta charset=utf-8><title>MINDClaw</title><style>
  body{font:15px -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:${dark ? "#14161c" : "#f6f6f4"};color:${dark ? "#e8e8ea" : "#1c1c1e"}}
  main{max-width:520px;padding:32px}h1{font-size:20px;margin:0 0 8px}p{line-height:1.5;opacity:.8}code{font:13px ui-monospace,monospace}</style>
  <main><h1>MINDClaw could not start its gateway</h1><p>${esc(message)}</p><p>Fix the issue, then choose <b>Kernel mode</b> from the menu bar item (any mode) or quit and reopen the app.</p></main>`;
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

ipcMain.on("desktop:notify", (e, payload) => {
  if (classifyUrl(e.senderFrame?.url ?? "", gatewayInfo?.origin) !== "internal") return; // only our own UI
  const p = validateNotifyPayload(payload);
  if (!p || !notifyAllowed()) return;
  showNotification(p);
});

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
const handlers = { toggle: toggleWindow, newSession, setKernelMode, quit: () => app.quit(), hideWindow };

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate({
    windowVisible: !!win && !win.isDestroyed() && win.isVisible(),
    kernelMode: config.kernelMode, shortcut: config.shortcut, handlers,
  })));
}

function createTray() {
  const img = nativeImage.createFromPath(join(here, "assets", "trayTemplate.png"));
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip("MINDClaw");
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
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("before-quit", (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  stopWatcher();
  saveBounds();
  Promise.race([gateway.stop(), new Promise((r) => setTimeout(r, 5000))]).finally(() => app.exit(0));
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

app.whenReady().then(async () => {
  if (!gotLock) return;
  nativeTheme.themeSource = "system";
  const ses = session.fromPartition("mindclaw");
  ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  if (!SMOKE) {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate({ handlers, isMac: process.platform === "darwin" })));
    createTray();
    registerShortcut();
  }
  createWindow();
  const loading = loadUi();
  if (SMOKE) { await loading; if (gatewayInfo) await runSmoke(); }
});
