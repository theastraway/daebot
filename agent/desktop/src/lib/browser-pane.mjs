// Daebot's browser pane: one WebContentsView per tab, only the active one attached to the window.
// The page partition is persist:daebot-browser. It never uses the app's "mindclaw" partition and it never
// reads the user's Chrome profile. Sign-ins stay in this partition across restarts. Cookies never leave Electron.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_INPUT_MS, BROWSER_PARTITION, clampPaneWidth, defaultPaneWidth, downloadPath, navigationAllowed, pageWebPreferences, shouldTakeOver } from "./browser-policy.mjs";

let seq = 0;

/**
 * @param {{ WebContentsView: new (opts: object) => { webContents: any, setBounds: Function },
 *   session: { fromPartition: Function }, userData: string, log?: Function,
 *   contentView: { addChildView: Function, removeChildView: Function },
 *   getContentBounds?: () => { width: number, height: number },
 *   getGatewayOrigin?: () => string | undefined,
 *   now?: () => number,
 *   initialWidth?: number,
 *   onWidth?: (width: number) => void }} deps
 */
export function createBrowserPane(deps) {
  if (!deps?.WebContentsView || !deps.session || !deps.contentView) throw new Error("browser pane needs WebContentsView, session, and a content view");
  const log = deps.log ?? (() => {});
  const now = () => (deps.now ? deps.now() : Date.now());
  const origin = () => { try { return deps.getGatewayOrigin?.() || ""; } catch { return ""; } };
  const ses = deps.session.fromPartition(BROWSER_PARTITION);
  const downloadDir = join(deps.userData, "daebot-browser-downloads");
  try { mkdirSync(downloadDir, { recursive: true }); } catch (e) { log("browser downloads folder:", String(e?.message ?? e)); }

  if (typeof ses.setPermissionRequestHandler === "function") ses.setPermissionRequestHandler((_wc, _permission, cb) => { try { cb(false); } catch { /* deny by default */ } });
  if (typeof ses.setPermissionCheckHandler === "function") ses.setPermissionCheckHandler(() => false);
  if (typeof ses.on === "function") {
    ses.on("will-download", (_e, item) => {
      try { item.setSavePath(downloadPath(deps.userData, item.getFilename?.())); }
      catch { try { item.cancel?.(); } catch { /* already failing */ } }
    });
  }

  /** @type {Map<string, any>} */
  const tabs = new Map();
  let activeId = null;
  let viewport = null;
  let paneOpen = false;
  let agentUntil = 0;
  /** A width the user dragged to, or one restored from the desktop state file. 0 uses the CSS default. */
  let preferred = clampPaneWidth(deps.initialWidth);
  const listeners = new Set();

  function emit() { for (const fn of listeners) { try { fn(); } catch { /* a listener must not break the pane */ } } }

  function snapshot() {
    return {
      partition: BROWSER_PARTITION,
      pane: { open: paneOpen, width: preferred || 0 },
      tabs: [...tabs.values()].map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.id === activeId, control: t.control })),
    };
  }

  function detachAll() {
    for (const t of tabs.values()) {
      if (!t.attached) continue;
      try { deps.contentView.removeChildView(t.view); } catch { /* already gone */ }
      t.attached = false;
    }
  }

  function attachActive() {
    detachAll();
    const tab = activeId ? tabs.get(activeId) : null;
    if (!paneOpen || !viewport || !tab) return;
    try {
      deps.contentView.addChildView(tab.view);
      tab.view.setBounds({ x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height });
      tab.attached = true;
    } catch (e) { log("browser attach:", String(e?.message ?? e)); }
  }

  function defaultViewport() {
    const b = deps.getContentBounds?.() || { width: 1200, height: 800 };
    const width = preferred || defaultPaneWidth(b.width || 1200);
    const top = 56;
    return {
      x: Math.max(0, Math.round((b.width || 1200) - width)),
      y: top,
      width,
      height: Math.max(120, Math.round((b.height || 800) - top)),
    };
  }

  function remember(width) {
    const w = clampPaneWidth(width);
    if (!w || w === preferred) return;
    preferred = w;
    try { deps.onWidth?.(w); } catch { /* saving the width must not break the pane */ }
  }

  function ensureShown() {
    paneOpen = true;
    if (!viewport) viewport = defaultViewport();
    attachActive();
    emit();
  }

  function bindGuards(tab) {
    const wc = tab.wc;
    const onNav = (e, url) => {
      const d = navigationAllowed(url, origin());
      if (!d.ok) { try { e?.preventDefault?.(); } catch { /* ignore */ } return; }
      tab.url = url;
    };
    wc.on?.("will-navigate", onNav);
    wc.on?.("will-redirect", onNav);
    wc.on?.("page-title-updated", (_e, title) => { tab.title = String(title || "").slice(0, 200); emit(); });
    wc.on?.("did-navigate", (_e, url) => { if (typeof url === "string") tab.url = url; emit(); });
    wc.on?.("did-navigate-in-page", (_e, url) => { if (typeof url === "string") tab.url = url; emit(); });
    wc.on?.("did-finish-load", () => {
      try { if (typeof wc.getURL === "function") tab.url = wc.getURL() || tab.url; } catch { /* ignore */ }
      try { if (typeof wc.getTitle === "function") tab.title = wc.getTitle() || tab.title; } catch { /* ignore */ }
      emit();
    });
    wc.on?.("before-mouse-event", (_e, input) => {
      if (!shouldTakeOver("mouse", input, agentUntil, now())) return;
      if (tab.control === "user") return;
      tab.control = "user";
      emit();
    });
    wc.on?.("before-input-event", (_e, input) => {
      if (!shouldTakeOver("key", input, agentUntil, now())) return;
      if (tab.control === "user") return;
      tab.control = "user";
      emit();
    });
    if (typeof wc.setWindowOpenHandler === "function") {
      wc.setWindowOpenHandler(({ url }) => {
        const d = navigationAllowed(url, origin());
        if (d.ok) { try { openTab(url); } catch (e) { log("browser window.open:", String(e?.message ?? e)); } }
        return { action: "deny" };
      });
    }
  }

  function openTab(url) {
    const d = navigationAllowed(url, origin());
    if (!d.ok) throw new Error(d.reason || "Navigation refused.");
    const id = `t${++seq}`;
    const view = new deps.WebContentsView({ webPreferences: pageWebPreferences() });
    const wc = view.webContents;
    const tab = { id, url, title: "", control: "agent", view, wc, attached: false, stack: [url], index: 0 };
    bindGuards(tab);
    tabs.set(id, tab);
    activeId = id;
    ensureShown();
    const loading = wc.loadURL?.(url);
    if (loading && typeof loading.then === "function") loading.catch((e) => log("browser load:", String(e?.message ?? e).slice(0, 160)));
    return tab;
  }

  async function cdp(tabId, method, params) {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error("browser: no such tab");
    const name = String(method || "");
    if (tab.control === "user" && name.startsWith("Input.")) throw new Error("user has control of this tab");
    if (name.startsWith("Input.")) agentUntil = now() + AGENT_INPUT_MS;
    const dbg = tab.wc.debugger;
    if (!dbg) throw new Error("browser: this tab has no debugger");
    const attached = typeof dbg.isAttached === "function" ? dbg.isAttached() : !!dbg.attached;
    if (!attached) {
      await dbg.attach("1.3");
      dbg.attached = true;
    }
    return dbg.sendCommand(name, params ?? {});
  }

  async function navigate(tab, to, url) {
    const wc = tab.wc;
    if (to === "url") {
      const d = navigationAllowed(url, origin());
      if (!d.ok) throw new Error(d.reason || "Navigation refused.");
      tab.stack = tab.stack.slice(0, tab.index + 1);
      tab.stack.push(url);
      tab.index = tab.stack.length - 1;
      tab.url = url;
      await wc.loadURL?.(url);
    } else if (to === "back" && tab.index > 0) {
      tab.index -= 1;
      tab.url = tab.stack[tab.index];
      if (typeof wc.goBack === "function") wc.goBack();
      else await wc.loadURL?.(tab.url);
    } else if (to === "forward" && tab.index < tab.stack.length - 1) {
      tab.index += 1;
      tab.url = tab.stack[tab.index];
      if (typeof wc.goForward === "function") wc.goForward();
      else await wc.loadURL?.(tab.url);
    } else if (to === "reload") {
      if (typeof wc.reload === "function") wc.reload();
      else await wc.loadURL?.(tab.url);
    } else throw new Error("browser: navigate needs a url, or back, forward, or reload");
    emit();
    return { url: tab.url, title: tab.title };
  }

  function closeTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (tab.attached) { try { deps.contentView.removeChildView(tab.view); } catch { /* ignore */ } }
    try { tab.wc.destroy?.(); } catch { /* ignore */ }
    tabs.delete(tabId);
    if (activeId === tabId) activeId = tabs.size ? [...tabs.keys()].at(-1) : null;
    attachActive();
    emit();
  }

  return {
    partition: BROWSER_PARTITION,
    session: ses,
    snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    viewportBounds() { return viewport ? { ...viewport } : null; },
    activeWebContents() { return activeId ? tabs.get(activeId)?.wc ?? null : null; },
    setViewport(rect) {
      if (!rect || typeof rect !== "object") {
        viewport = null;
        paneOpen = false;
        attachActive();
        emit();
        return true;
      }
      const x = Number(rect.x), y = Number(rect.y), width = Number(rect.width), height = Number(rect.height);
      if (![x, y, width, height].every((n) => Number.isFinite(n))) return false;
      const b = deps.getContentBounds?.() || { width: 4000, height: 4000 };
      const maxW = Math.max(1, Math.round(b.width || 4000));
      const maxH = Math.max(1, Math.round(b.height || 4000));
      const vx = Math.max(0, Math.min(maxW - 1, Math.round(x)));
      const vy = Math.max(0, Math.min(maxH - 1, Math.round(y)));
      // Match the hole the page reported. The 420–760 limit is the side pane's drag range, not this view:
      // a narrow window turns the pane into a bottom sheet, and the view has to follow that rect.
      viewport = {
        x: vx,
        y: vy,
        width: Math.max(1, Math.min(maxW - vx, Math.round(width))),
        height: Math.max(1, Math.min(maxH - vy, Math.round(height))),
      };
      paneOpen = true;
      attachActive();
      emit();
      return true;
    },
    async flush() {
      try { await ses.cookies?.flushStore?.(); } catch (e) { log("browser cookie flush:", String(e?.message ?? e)); }
    },
    async captureActive() {
      const wc = activeId ? tabs.get(activeId)?.wc : null;
      if (!wc || typeof wc.capturePage !== "function") return null;
      return wc.capturePage();
    },
    destroy() {
      for (const id of [...tabs.keys()]) closeTab(id);
      paneOpen = false;
      viewport = null;
    },
    async handle(op, args) {
      const a = args && typeof args === "object" ? args : {};
      if (op === "cdp") return cdp(String(a.tabId || ""), String(a.method || ""), a.params && typeof a.params === "object" ? a.params : {});
      if (op === "open") {
        const tab = openTab(String(a.url || ""));
        return { tabId: tab.id, url: tab.url, title: tab.title };
      }
      if (op === "navigate") {
        const tab = tabs.get(String(a.tabId || activeId || ""));
        if (!tab) throw new Error("browser: no such tab");
        return navigate(tab, String(a.to || ""), typeof a.url === "string" ? a.url : "");
      }
      if (op === "close") { closeTab(String(a.tabId || "")); return { closed: true }; }
      if (op === "setControl") {
        const id = String(a.tabId || activeId || "");
        const tab = tabs.get(id);
        if (tab && (a.control === "user" || a.control === "agent")) { tab.control = a.control; emit(); }
        return snapshot();
      }
      if (op === "pane") {
        if (typeof a.width === "number") {
          const w = clampPaneWidth(a.width);
          if (w) {
            remember(w);
            if (viewport) {
              const b = deps.getContentBounds?.() || { width: viewport.x + w };
              const maxW = Math.max(w, Math.round(b.width || viewport.x + w));
              viewport = { ...viewport, width: w, x: Math.max(0, maxW - w) };
            }
          }
        }
        if (a.open === false) { paneOpen = false; attachActive(); emit(); }
        else if (a.open === true) ensureShown();
        else { attachActive(); emit(); }
        return snapshot();
      }
      throw new Error(`browser: unknown op ${String(op).slice(0, 40)}`);
    },
  };
}
