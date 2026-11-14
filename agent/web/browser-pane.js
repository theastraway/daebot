// Daebot's browser pane. The page itself is an Electron view laid over #browser-view; this file is the chrome:
// title, URL, who has control, and the take-over bar. Page text is assigned with textContent only.

export const PANE_LABEL = "Daebot's browser";
export const CONTROL_USER = "You have control";
export const CONTROL_AGENT = "Daebot has control";
export const GIVE_LABEL = "Give back to Daebot";
export const TAKE_LABEL = "Take over";
export const POLL_MS = 2000;
export const PANE_MIN_W = 420;
export const PANE_MAX_W = 760;
const WIDTH_KEY = "daebot.browserPaneWidth";

/** Side-pane width. 0 means it has not been chosen, so the CSS default (about 45% of the window) applies. */
export function clampPaneWidth(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.max(PANE_MIN_W, Math.min(PANE_MAX_W, Math.round(x)));
}

function readStoredWidth() {
  try { return clampPaneWidth(localStorage.getItem(WIDTH_KEY)); } catch { return 0; }
}

function writeStoredWidth(w) {
  try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* private mode */ }
}

export function controlLabel(control) {
  return control === "user" ? CONTROL_USER : CONTROL_AGENT;
}

/** Tool-card title. The typed text is not included. */
export function browserActionLabel(args) {
  const a = args && typeof args.action === "string" ? args.action : "browser";
  if ((a === "open" || a === "navigate") && args && typeof args.url === "string" && args.url) return `Browser ${a} ${args.url.slice(0, 60)}`;
  if (args && typeof args.ref === "string" && args.ref) return `Browser ${a} ${args.ref}`;
  return `Browser ${a}`;
}

/** A copy of the arguments safe to draw. Typed text is never shown: it may be a password the model tried. */
export function browserArgsForCard(args) {
  if (!args || typeof args !== "object") return args;
  const out = { ...args };
  if (out.action === "type" && typeof out.text === "string") out.text = "[not shown]";
  return out;
}

export function activeTab(snap) {
  const tabs = snap && Array.isArray(snap.tabs) ? snap.tabs : [];
  return tabs.find((t) => t && t.active) || tabs[0] || null;
}

export function shouldShowChip(snap) {
  if (!snap) return false;
  if (snap.connected) return true;
  if (snap.pane && snap.pane.open) return true;
  return Array.isArray(snap.tabs) && snap.tabs.length > 0;
}

function parseSseBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      let v = line.slice(5);
      if (v.startsWith(" ")) v = v.slice(1);
      data.push(v);
    }
  }
  if (!data.length) return null;
  try { return { event, data: JSON.parse(data.join("\n")) }; } catch { return null; }
}

/**
 * @param {{ json: Function, currentId: () => string | null,
 *   chip: HTMLElement, pane: HTMLElement, urlEl: HTMLElement, controlEl: HTMLElement,
 *   noticeEl: HTMLElement, viewEl: HTMLElement, takeBtn: HTMLElement, giveBtn: HTMLElement, closeBtn: HTMLElement }} opts
 */
export function initBrowserPane(opts) {
  const nop = { noteTool() {}, sync() {} };
  if (!opts || !opts.chip || !opts.pane) return nop;
  const { chip, pane } = opts;
  const urlEl = opts.urlEl;
  const controlEl = opts.controlEl;
  const noticeEl = opts.noticeEl;
  const viewEl = opts.viewEl;
  const takeBtn = opts.takeBtn;
  const giveBtn = opts.giveBtn;
  let poll = null;
  let streamCtl = null;
  let chat = null;
  let last = null;
  let dragging = false;
  const stored = readStoredWidth();
  if (stored) pane.style.width = `${stored}px`;

  function stopStream() { if (streamCtl) { streamCtl.abort(); streamCtl = null; } }
  function desktop() { return typeof window !== "undefined" ? window.mindclawDesktop : undefined; }
  function reportViewport() {
    const api = desktop();
    const set = api && api.browser && api.browser.setViewport;
    if (typeof set !== "function") return;
    if (pane.hidden || !viewEl) { set(null); return; }
    const r = viewEl.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    set({ x: r.x, y: r.y, width: r.width, height: r.height });
  }
  function reflow() {
    const open = !pane.hidden;
    document.documentElement.classList.toggle("browser-open", open);
    if (!open) {
      document.documentElement.style.removeProperty("--browser-pane-w");
      return;
    }
    const w = Math.round(pane.getBoundingClientRect().width);
    if (w >= 8) document.documentElement.style.setProperty("--browser-pane-w", `${w}px`);
  }
  function setOpen(open) {
    const wasOpen = !pane.hidden;
    pane.hidden = !open;
    chip.setAttribute("aria-expanded", String(!!open));
    if (!open) stopStream();
    else if (!wasOpen) void follow();
    reflow();
    reportViewport();
  }
  function paint(snap) {
    last = snap || null;
    const show = shouldShowChip(snap);
    chip.hidden = !show;
    if (!snap) return;
    if (snap.pane && snap.pane.open) setOpen(true);
    const tab = activeTab(snap);
    if (urlEl) urlEl.textContent = tab ? `${tab.title || "New tab"}${tab.url ? ` — ${tab.url}` : ""}` : "No page open";
    const control = tab ? tab.control : "agent";
    if (controlEl) controlEl.textContent = controlLabel(control);
    if (takeBtn) takeBtn.hidden = control === "user";
    if (giveBtn) giveBtn.hidden = control !== "user";
    if (noticeEl) {
      const text = snap.notice && snap.notice.text ? String(snap.notice.text) : "";
      noticeEl.textContent = text;
      noticeEl.hidden = !text;
      noticeEl.dataset.kind = snap.notice && snap.notice.kind ? snap.notice.kind : "";
    }
    if (!pane.hidden) {
      const w = clampPaneWidth(snap.pane?.width);
      if (w && !dragging) pane.style.width = `${w}px`;
      reflow();
    }
    reportViewport();
  }
  async function refresh() {
    const id = opts.currentId();
    if (!id) return;
    try { paint(await opts.json(`/sessions/${encodeURIComponent(id)}/browser`)); } catch { /* the next poll retries */ }
  }
  async function follow() {
    stopStream();
    const id = opts.currentId();
    if (!id || pane.hidden || typeof fetch !== "function") return;
    const ctl = streamCtl = new AbortController();
    try {
      const res = await fetch(`/sessions/${encodeURIComponent(id)}/browser/stream`, { signal: ctl.signal, headers: opts.authHeaders ? opts.authHeaders() : {} });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done || ctl.signal.aborted) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const msg = parseSseBlock(block);
          if (msg && msg.event === "state") paint(msg.data);
        }
      }
    } catch { /* closed or a replaced stream */ }
  }
  async function post(path, body) {
    const id = opts.currentId();
    if (!id) return;
    try { paint(await opts.json(`/sessions/${encodeURIComponent(id)}/browser/${path}`, { method: "POST", body: JSON.stringify(body) })); } catch { /* the bar stays as it was */ }
  }
  function ensurePoll(on) {
    if (on && !poll) poll = setInterval(() => { void refresh(); }, POLL_MS);
    if (!on && poll) { clearInterval(poll); poll = null; }
  }
  chip.addEventListener("click", () => {
    const open = pane.hidden;
    setOpen(open);
    void post("pane", { open });
  });
  opts.closeBtn?.addEventListener("click", () => { setOpen(false); void post("pane", { open: false }); });
  takeBtn?.addEventListener("click", () => { void post("control", { action: "take", tab: activeTab(last)?.id }); });
  giveBtn?.addEventListener("click", () => { void post("control", { action: "give", tab: activeTab(last)?.id }); });
  const handle = pane.querySelector(".browser-resize");
  if (handle) {
    handle.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      const startX = ev.clientX;
      const startW = pane.getBoundingClientRect().width;
      handle.setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
      const move = (e) => {
        const w = clampPaneWidth(startW + (startX - e.clientX));
        if (!w) return;
        pane.style.width = `${w}px`;
        reflow();
        reportViewport();
      };
      const up = (e) => {
        dragging = false;
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        const w = clampPaneWidth(startW + (startX - e.clientX));
        if (!w) return;
        pane.style.width = `${w}px`;
        writeStoredWidth(w);
        reflow();
        reportViewport();
        void post("pane", { open: true, width: w });
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }
  if (typeof ResizeObserver === "function" && viewEl) {
    const ro = new ResizeObserver(() => { reflow(); reportViewport(); });
    ro.observe(viewEl);
    ro.observe(pane);
  }
  window.addEventListener("resize", () => { reflow(); reportViewport(); });
  return {
    noteTool() { chip.hidden = false; void refresh(); },
    sync() {
      const id = opts.currentId();
      if (id !== chat) { chat = id; stopStream(); last = null; }
      const on = !!id;
      ensurePoll(on);
      if (on) { void refresh(); if (!pane.hidden) void follow(); }
      else { chip.hidden = true; setOpen(false); }
    },
  };
}
