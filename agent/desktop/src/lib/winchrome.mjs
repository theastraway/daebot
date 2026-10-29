// Windows and Linux window chrome: no native menu bar, no white title bar. The window runs content to the top edge and
// Electron draws only the minimize / maximize / close buttons (titleBarOverlay) on our own background. The Mac keeps its
// inset traffic lights and its app menu (macOS needs the menu for copy and paste).
export const OVERLAY_HEIGHT = 36;

export const isOverlayPlatform = (platform) => platform === "win32" || platform === "linux";

// Match web/style.css: --bg is the top bar (the window controls sit over it), --ink is the text color.
const COLORS = {
  light: { color: "#fbf6ee", symbolColor: "#141211" },
  dark: { color: "#0c0b0a", symbolColor: "#f6ead8" },
};

export const titleBarOverlayFor = (dark) => ({ ...(dark ? COLORS.dark : COLORS.light), height: OVERLAY_HEIGHT });

/** BrowserWindow options for the chrome of this platform (merged into the constructor options). */
export function windowChromeOptions(platform, dark) {
  if (platform === "darwin") return { titleBarStyle: "hiddenInset" };
  if (isOverlayPlatform(platform)) return { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlayFor(dark), autoHideMenuBar: true };
  return { titleBarStyle: "default" };
}

/**
 * With no menu, the keyboard shortcuts the menu gave us are handled from before-input-event. Returns the action name for a
 * key event, or null. Mac never uses this (its menu owns them). Only plain keyDown with Ctrl, never AltGr (Ctrl+Alt).
 */
export function shortcutAction(input, platform) {
  if (!isOverlayPlatform(platform) || !input || input.type !== "keyDown" || input.meta || typeof input.key !== "string") return null;
  const k = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (!input.control) {
    if (input.alt || input.shift) return null;
    if (k === "F5") return "reload";
    if (k === "F11") return "fullscreen";
    if (k === "F12") return "devtools";
    return null;
  }
  if (input.alt) return null;
  if (input.shift) {
    if (k === "i") return "devtools";
    if (k === "r") return "forceReload";
    if (k === "z") return "redo";
    if (k === "+" || k === "=") return "zoomIn";
    return null;
  }
  switch (k) {
    case "c": return "copy";
    case "v": return "paste";
    case "x": return "cut";
    case "a": return "selectAll";
    case "z": return "undo";
    case "y": return "redo";
    case "n": return "newSession";
    case "w": return "hideWindow";
    case "r": return "reload";
    case "+": case "=": return "zoomIn";
    case "-": return "zoomOut";
    case "0": return "zoomReset";
    default: return null;
  }
}

/** Run a shortcut action against a webContents / window. `handlers` supplies newSession and hideWindow. */
export function runShortcut(action, { wc, win, handlers }) {
  const step = (d) => wc.setZoomLevel(Math.max(-3, Math.min(5, wc.getZoomLevel() + d)));
  switch (action) {
    case "copy": return wc.copy();
    case "paste": return wc.paste();
    case "cut": return wc.cut();
    case "selectAll": return wc.selectAll();
    case "undo": return wc.undo();
    case "redo": return wc.redo();
    case "newSession": return handlers.newSession();
    case "hideWindow": return handlers.hideWindow();
    case "reload": return wc.reload();
    case "forceReload": return wc.reloadIgnoringCache();
    case "devtools": return wc.toggleDevTools();
    case "fullscreen": return win.setFullScreen(!win.isFullScreen());
    case "zoomIn": return step(0.5);
    case "zoomOut": return step(-0.5);
    case "zoomReset": return wc.setZoomLevel(0);
    default: return undefined;
  }
}
