// The row menu: a vertical pop-up that opens when you hover (or keyboard-focus, right-click, or long-press on touch) a session or bot row.
// Four items: Settings, Pin, Delete, and the "Run on a computer" switch (off = MIND Cloud, the standard). A fifth, "Move to this computer", appears only when it is on, pinned to ANOTHER computer, and this window is a computer. One menu exists at a time, appended to <body> so no sidebar
// overflow ever clips it, and it is clamped to the window. role=menu, arrow keys, Home/End, Escape; light and dark come from the tokens.
// menuItems() and placeMenu() are pure (exported, unit tested). DOM is createElement + textContent only.

export const OPEN_DELAY_MS = 220;
export const CLOSE_DELAY_MS = 200;
export const LONG_PRESS_MS = 450;
export const MENU_GAP = 6;
export const EDGE = 8;

/**
 * The items for a row.
 *   spec: { pinned, remote: { state: "on"|"off"|"disabled", reason?, where?, moveHere? }, name }
 */
export function menuItems(spec) {
  const r = spec.remote || { state: "disabled", reason: "Choose where this runs from its settings." };
  const on = r.state === "on";
  const items = [
    { id: "settings", label: "Settings", icon: "i-gear" },
    { id: "pin", label: spec.pinned ? "Unpin" : "Pin", icon: "i-pin", pressed: !!spec.pinned },
    ...(spec.share ? [{ id: "share", label: "Share thread", icon: "i-users", hint: "Add MIND people to it" }] : []),
    { id: "delete", label: "Delete", icon: "i-trash", danger: true },
    { id: "remote", label: "Run on a computer", icon: "i-link", type: "switch", checked: on, disabled: r.state === "disabled", hint: r.state === "disabled" ? (r.reason || "") : on ? (r.where ? `On, runs on ${r.where}` : "On") : "Off, runs in MIND Cloud" },
  ];
  // Pinned to another computer: one click re-pins it to the computer this window is on.
  if (on && r.moveHere) items.push({ id: "movehere", label: "Move to this computer", icon: "i-desktop", hint: r.where ? `Now runs only on ${r.where}` : "" });
  return items;
}

/**
 * Where to put the menu: to the right of the row when it fits, else to the left, else under it; always inside the window.
 * anchor = the row's rect {left,top,right,bottom}; size = {w,h}; view = {w,h}.
 */
export function placeMenu(anchor, size, view) {
  const clampX = (x) => Math.max(EDGE, Math.min(x, view.w - size.w - EDGE));
  const clampY = (y) => Math.max(EDGE, Math.min(y, view.h - size.h - EDGE));
  let side = "right", x = anchor.right + MENU_GAP, y = anchor.top + (anchor.bottom - anchor.top) / 2 - 22;
  if (x + size.w > view.w - EDGE) {
    if (anchor.left - MENU_GAP - size.w >= EDGE) { side = "left"; x = anchor.left - MENU_GAP - size.w; }
    else { side = "below"; x = anchor.right - size.w; y = anchor.bottom + MENU_GAP; if (y + size.h > view.h - EDGE) { side = "above"; y = anchor.top - MENU_GAP - size.h; } }
  }
  return { x: Math.round(clampX(x)), y: Math.round(clampY(y)), side };
}

/**
 * createRowMenu({ h, icon }) -> { attach(row, getSpec, actions), close(), isOpen() }
 *   getSpec() -> { pinned, remote, name } (read when the menu opens, so it is always current)
 *   actions: { settings(), pin(), delete(), remote(nextOn), movehere() }
 */
export function createRowMenu({ h, icon }) {
  let menu = null, current = null, openTimer = 0, closeTimer = 0, onDoc = null;
  const touchLike = () => typeof matchMedia === "function" && matchMedia("(hover: none)").matches;

  function close(restore = false) {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    if (!menu) return;
    const row = current && current.row;
    menu.remove(); menu = null; current = null;
    if (onDoc) { document.removeEventListener("pointerdown", onDoc, true); document.removeEventListener("keydown", onDoc.key, true); window.removeEventListener("resize", onDoc.close); onDoc = null; }
    if (row) row.classList.remove("menu-open");
    if (restore && row) { const f = row.querySelector(".sess, .bot-item"); if (f) f.focus(); }
  }

  function items() { return menu ? [...menu.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])')] : []; }

  function open(row, getSpec, actions, o = {}) {
    clearTimeout(closeTimer); clearTimeout(openTimer);
    if (current && current.row === row && menu) return;
    close();
    const spec = getSpec();
    const m = h("div", "rowmenu");
    m.setAttribute("role", "menu"); m.setAttribute("aria-label", `Actions for ${spec.name || "this row"}`);
    for (const it of menuItems(spec)) {
      if (it.id === "delete") { const sep = h("div", "rm-sep"); sep.setAttribute("role", "separator"); m.append(sep); }
      const b = h("button", `rm-item${it.danger ? " danger" : ""}`); b.type = "button"; b.dataset.id = it.id;
      b.setAttribute("role", it.type === "switch" ? "menuitemcheckbox" : "menuitem"); b.tabIndex = -1;
      const ic = icon(it.icon); ic.classList.add("rm-ic"); ic.setAttribute("aria-hidden", "true");
      const txt = h("span", "rm-text"); txt.append(h("span", "rm-label", it.label));
      if (it.hint) txt.append(h("span", "rm-hint", it.hint));
      b.append(ic, txt);
      if (it.id === "pin" && it.pressed) b.classList.add("on");
      if (it.type === "switch") {
        b.setAttribute("aria-checked", String(it.checked));
        const sw = h("span", `rm-switch${it.checked ? " on" : ""}`); sw.append(h("i", "")); sw.setAttribute("aria-hidden", "true");
        b.append(sw);
        if (it.disabled) { b.setAttribute("aria-disabled", "true"); b.classList.add("disabled"); }
      }
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (b.getAttribute("aria-disabled") === "true") return;
        if (it.type === "switch") {
          const next = b.getAttribute("aria-checked") !== "true";
          b.setAttribute("aria-checked", String(next)); b.querySelector(".rm-switch").classList.toggle("on", next);
          actions.remote && actions.remote(next);
          return; // the switch stays open so the result is seen
        }
        close();
        const fn = actions[it.id];
        if (fn) fn();
      });
      m.append(b);
    }
    m.addEventListener("pointerenter", () => clearTimeout(closeTimer));
    m.addEventListener("pointerleave", () => scheduleClose(row));
    m.addEventListener("keydown", (e) => {
      const list = items(); const i = list.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === "Home") { e.preventDefault(); list[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); list[list.length - 1].focus(); }
      else if (e.key === "Escape" || e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === "Tab") { close(false); }
    });
    document.body.append(m);
    const r = row.getBoundingClientRect();
    const pos = placeMenu({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, { w: m.offsetWidth, h: m.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
    m.style.left = `${pos.x}px`; m.style.top = `${pos.y}px`; m.dataset.side = pos.side;
    menu = m; current = { row, getSpec, actions };
    row.classList.add("menu-open");
    requestAnimationFrame(() => m.classList.add("in"));
    onDoc = (e) => { if (!menu) return; if (menu.contains(e.target) || row.contains(e.target)) return; close(); };
    onDoc.key = (e) => { if (e.key === "Escape" && menu && !menu.contains(document.activeElement)) { close(true); } };
    onDoc.close = () => close();
    document.addEventListener("pointerdown", onDoc, true); document.addEventListener("keydown", onDoc.key, true); window.addEventListener("resize", onDoc.close);
    if (o.focus) { const f = items()[0]; if (f) f.focus(); }
  }

  function scheduleClose(row) {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (menu && current && current.row === row && !menu.matches(":hover") && !row.matches(":hover") && !menu.contains(document.activeElement)) close(); }, CLOSE_DELAY_MS);
  }

  function attach(row, getSpec, actions) {
    row.classList.add("has-menu");
    row.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "touch" || touchLike()) return;
      clearTimeout(closeTimer); clearTimeout(openTimer);
      openTimer = setTimeout(() => open(row, getSpec, actions), OPEN_DELAY_MS);
    });
    row.addEventListener("pointerleave", () => { clearTimeout(openTimer); scheduleClose(row); });
    row.addEventListener("focusin", (e) => {
      if (menu && menu.contains(e.target)) return;
      let kb = false; try { kb = e.target.matches(":focus-visible"); } catch { /* old engine */ }
      if (kb) open(row, getSpec, actions);
    });
    row.addEventListener("focusout", (e) => { if (menu && !(e.relatedTarget && menu.contains(e.relatedTarget)) && !row.contains(e.relatedTarget)) scheduleClose(row); });
    row.addEventListener("keydown", (e) => {
      if (e.target.closest && e.target.closest("input, textarea")) return;
      if (e.key === "ArrowRight" || (e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") { e.preventDefault(); open(row, getSpec, actions, { focus: true }); }
      else if (e.key === "Escape" && menu) { close(true); }
    });
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); open(row, getSpec, actions, { focus: false }); });
    // Long-press on touch opens it; the tap that would follow does nothing.
    let t = 0, sx = 0, sy = 0, fired = false;
    const clear = () => { clearTimeout(t); t = 0; };
    row.addEventListener("pointerdown", (e) => {
      fired = false;
      if (e.pointerType !== "touch") return;
      sx = e.clientX; sy = e.clientY; clear();
      t = setTimeout(() => { fired = true; open(row, getSpec, actions); try { navigator.vibrate && navigator.vibrate(8); } catch { /* none */ } }, LONG_PRESS_MS);
    });
    row.addEventListener("pointermove", (e) => { if (t && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clear(); });
    for (const ev of ["pointerup", "pointercancel"]) row.addEventListener(ev, clear);
    row.addEventListener("click", (e) => { if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; } }, true);
  }

  return { attach, close, isOpen: () => !!menu };
}
