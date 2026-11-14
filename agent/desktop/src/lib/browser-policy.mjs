// URL rules for the browser pane. Keep this in step with agent/src/browser/policy.ts (navigationAllowed).
// The desktop cannot import that TypeScript module, so the check is copied here and tested on its own.
import { basename, join, resolve, sep } from "node:path";

export const BROWSER_PARTITION = "persist:daebot-browser";
export const AGENT_INPUT_MS = 400;

/** Keep in step with src/browser/policy.ts. 0 means the CSS default (about 45% of the window). */
export const PANE_MIN_W = 420;
export const PANE_MAX_W = 760;

export function clampPaneWidth(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.min(PANE_MAX_W, Math.max(PANE_MIN_W, Math.round(x)));
}

export function defaultPaneWidth(windowWidth) {
  const w = Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : 1200;
  return clampPaneWidth(w * 0.45);
}

const REFUSED_PROTOCOL = new Set(["file:", "chrome:", "chrome-extension:", "devtools:", "view-source:", "javascript:", "data:"]);

/** Top-level navigation policy. about:blank is allowed so a new tab can exist before it loads. */
export function navigationAllowed(url, gatewayOrigin) {
  let u;
  try { u = new URL(String(url ?? "")); } catch { return { ok: false, reason: "That URL is not valid." }; }
  if (u.protocol === "about:" && u.href.split("#")[0] === "about:blank") return { ok: true };
  if (REFUSED_PROTOCOL.has(u.protocol)) return { ok: false, reason: `Navigation to ${u.protocol} URLs is refused.` };
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: `Navigation to ${u.protocol} URLs is refused.` };
  if (gatewayOrigin) {
    try {
      if (u.origin === new URL(gatewayOrigin).origin) return { ok: false, reason: "Navigation to the gateway's own origin is refused." };
    } catch { /* a bad origin string does not widen what is allowed */ }
  }
  return { ok: true };
}

/**
 * Page webPreferences. No preload and no node. The partition is Daebot's browser, never "mindclaw" and never the user's Chrome profile.
 * @returns {Electron.WebPreferences}
 */
export function pageWebPreferences() {
  return {
    partition: BROWSER_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
  };
}

/** A download may only land inside userData/daebot-browser-downloads. The filename cannot climb out of that folder. */
export function downloadPath(userData, filename) {
  const dir = resolve(join(String(userData || ""), "daebot-browser-downloads"));
  const raw = basename(String(filename || "download")).replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  const name = raw && raw !== "_" ? raw.slice(0, 120) : "download";
  const dest = resolve(join(dir, name));
  if (dest !== join(dir, name) && !dest.startsWith(dir + sep)) throw new Error("download path escapes the sandbox");
  if (!dest.startsWith(dir + sep)) throw new Error("download path escapes the sandbox");
  return dest;
}

/** True when this input is the user (not the agent's own CDP) taking the tab. */
export function shouldTakeOver(kind, input, agentUntil, now) {
  if (typeof now === "number" && typeof agentUntil === "number" && now < agentUntil) return false;
  const type = input && input.type;
  if (kind === "mouse") return type === "mouseDown" || type === "mouseWheel" || type === "contextMenu";
  if (kind === "key") return type === "keyDown";
  return false;
}
