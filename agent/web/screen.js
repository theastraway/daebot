// "Let Daebot watch my screen": the switch in the account menu, the red "watching" pill with a one-click Stop, and the macOS permission card.
// Desktop app only: everything stays hidden unless the shell exposes window.mindclawDesktop.screen (the website and the phone never show it).
// The USER grants the macOS permission; this file only shows the state and a button that opens the System Settings pane.

/** What to show for a state from the shell. Pure so it is unit tested. */
export function screenView(s) {
  const st = s && typeof s === "object" ? s : {};
  const watching = st.watching === true;
  const perm = typeof st.permission === "string" ? st.permission : "unknown";
  const on = watching && perm === "granted";
  const needsPermission = watching && perm === "needs-permission";
  let note = "Off. Daebot cannot see your screen.";
  if (on) note = st.error ? `On, but capture has a problem: ${st.error}` : "On. Daebot looks only when you ask it to. A red dot shows while this is on.";
  else if (needsPermission) note = "Waiting for Screen Recording permission.";
  else if (watching && perm === "restricted") note = "Blocked by a system policy on this computer.";
  else if (watching && perm === "unsupported") note = "Not supported on this system.";
  else if (watching) note = "Checking permission...";
  return {
    checked: watching,
    on,
    pill: on,
    card: needsPermission,
    canOpenSettings: st.canOpenSettings === true,
    note,
    platform: st.platform || "",
  };
}

/** Keep a dragged pill fully inside the window. Pure so it is unit tested. */
export function clampPillPos(x, y, w, h, vw, vh, pad = 4) {
  const cx = Math.min(Math.max(pad, x), Math.max(pad, vw - w - pad));
  const cy = Math.min(Math.max(pad, y), Math.max(pad, vh - h - pad));
  return { x: Math.round(cx), y: Math.round(cy) };
}

const PILL_KEY = "daebot.screenPill";
function loadPill() { try { const v = JSON.parse(localStorage.getItem(PILL_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } }
function savePill(v) { try { localStorage.setItem(PILL_KEY, JSON.stringify(v)); } catch { /* storage blocked: position just is not remembered */ } }

// Drag anywhere on the pill to move it; the minus button shrinks it to the red dot and a click on the dot opens it again.
function makePillMovable(pill) {
  const pref = loadPill();
  const minBtn = pill.querySelector(".pill-min");
  function setMin(m) {
    pill.classList.toggle("min", m);
    minBtn.setAttribute("aria-expanded", String(!m));
    pill.title = m ? "Daebot is watching your screen. Click to open, drag to move" : "Drag to move";
    pref.min = m; savePill(pref);
    if (pill.classList.contains("placed")) requestAnimationFrame(() => place(pref.x, pref.y, false));
  }
  function place(x, y, save = true) {
    const r = pill.getBoundingClientRect();
    const p = clampPillPos(x, y, r.width, r.height, window.innerWidth, window.innerHeight);
    pill.classList.add("placed");
    pill.style.left = p.x + "px"; pill.style.top = p.y + "px";
    if (save) { pref.x = p.x; pref.y = p.y; savePill(pref); }
  }
  minBtn.addEventListener("click", (e) => { e.stopPropagation(); setMin(true); });
  let drag = null; let moved = false;
  pill.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".pill-stop, .pill-min")) return;
    const r = pill.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY };
    moved = false;
    pill.setPointerCapture(e.pointerId);
  });
  pill.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
    moved = true; pill.classList.add("dragging");
    place(e.clientX - drag.dx, e.clientY - drag.dy, false);
  });
  const end = (e) => {
    if (!drag) return;
    drag = null; pill.classList.remove("dragging");
    try { pill.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (moved) { const r = pill.getBoundingClientRect(); place(r.left, r.top); }
    else if (pill.classList.contains("min")) setMin(false);
  };
  pill.addEventListener("pointerup", end);
  pill.addEventListener("pointercancel", end);
  window.addEventListener("resize", () => { if (pill.classList.contains("placed") && !pill.hidden) place(pref.x, pref.y); });
  if (pref.min) setMin(true);
  return { restore() { if (typeof pref.x === "number" && typeof pref.y === "number") requestAnimationFrame(() => place(pref.x, pref.y, false)); } };
}

export function initScreen(o) {
  const bridge = typeof window !== "undefined" && window.mindclawDesktop && window.mindclawDesktop.screen;
  if (!bridge || typeof bridge.get !== "function") return { available: false };
  const { h, item, pill } = o;
  let state = null;
  let card = null;

  const sw = item.querySelector(".u-switch");
  const note = item.querySelector("small");
  item.hidden = false;

  function closeCard() { if (card) { card.remove(); card = null; } }

  function openCard(v) {
    if (card) return;
    const modal = h("div", "gate-token modal"); modal.id = "screen-modal";
    const c = h("div", "token-card bot-card apps-card"); c.setAttribute("role", "dialog"); c.setAttribute("aria-modal", "true"); c.setAttribute("aria-label", "Screen Recording permission");
    const head = h("div", "apps-head");
    const t = h("div"); t.append(h("h2", "", "Daebot needs Screen Recording permission"), h("p", "", "macOS asks you to allow this once. Daebot cannot allow it for you."));
    head.append(t);
    const steps = h("ol", "screen-steps");
    for (const x of ["Click Open System Settings.", "Turn on Daebot under Screen & System Audio Recording.", "If macOS asks, quit and reopen Daebot. The switch stays on."]) steps.append(h("li", "", x));
    const row = h("div", "screen-actions");
    if (v.canOpenSettings) {
      const go = h("button", "btn-primary", "Open System Settings"); go.type = "button";
      go.addEventListener("click", () => { bridge.openSettings(); });
      row.append(go);
    }
    const no = h("button", "btn-quiet", "Turn it off"); no.type = "button";
    no.addEventListener("click", () => { bridge.set(false).then(apply).catch(() => {}); closeCard(); });
    row.append(no);
    c.append(head, steps, row, h("p", "apps-note", "Frames stay in memory on this computer. Nothing is saved or uploaded unless you ask Daebot to look at something."));
    modal.append(c);
    document.body.append(modal);
    card = modal;
  }

  function apply(s) {
    state = s;
    const v = screenView(s);
    sw.classList.toggle("on", v.checked);
    item.setAttribute("aria-checked", String(v.checked));
    note.textContent = v.note;
    const wasHidden = pill.hidden;
    pill.hidden = !v.pill;
    if (wasHidden && v.pill) mover.restore();
    if (v.card) openCard(v); else closeCard();
  }

  item.addEventListener("click", () => {
    const next = !(state && state.watching);
    bridge.set(next).then((s) => { if (s) apply(s); }).catch(() => {});
  });
  const mover = makePillMovable(pill);
  pill.querySelector(".pill-stop").addEventListener("click", () => { bridge.set(false).then((s) => { if (s) apply(s); }).catch(() => {}); });
  if (typeof bridge.onChange === "function") bridge.onChange(apply);
  bridge.get().then((s) => { if (s) apply(s); }).catch(() => {});
  return { available: true, state: () => state };
}
