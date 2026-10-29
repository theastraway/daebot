// The message menu: click (desktop) or long-press (touch) a Daebot reply to react, reply, mark unread, copy, select text, copy its
// request id or report it. A bottom sheet on phones, an anchored card on desktop. Pure UI: app.js supplies what each row does.
// All text goes through textContent (the page forbids building markup from strings).

export const QUICK = ["👍", "👎", "❤️", "😂", "🎉", "😮", "🔥", "👀", "🙏", "😢", "💯"];
const MORE = [
  "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "🙂", "😉", "😊", "😍", "🥰", "😘", "😋", "😎", "🤩",
  "🤔", "🤨", "😐", "🙄", "😏", "😬", "😴", "🤯", "😳", "🥺", "😭", "😤", "😡", "🤗", "🫡", "🫶",
  "👏", "🙌", "👌", "✌️", "🤞", "🤝", "💪", "👋", "✅", "❌", "⚠️", "❓", "❗", "💡", "⭐", "✨",
  "💥", "🚀", "🎯", "🏆", "💰", "📌", "📎", "🔒", "🧠", "🛠️", "🐛", "🤖", "☕", "🍕", "🎶", "🌟",
];
export const REPORT_REASONS = ["Wrong or made up", "Didn't do what I asked", "Unsafe or inappropriate", "Too long or unclear", "Something else"];

const phone = () => matchMedia("(max-width: 640px)").matches;
const coarse = () => matchMedia("(pointer: coarse)").matches;
// Clicks on these are the user using the message, not asking for its menu.
const OWN_CLICK = "a, button, summary, input, textarea, select, label, [role=button], .mx-reacts";

export function initMessageMenu({ h, icon, host, pick, onRequest }) {
  let menu = null, backdrop = null, lastFocus = null, activeNode = null, toastEl = null, toastTimer = 0, selectingNode = null;

  // ---------- toast ----------
  function toast(text) {
    if (!toastEl) {
      toastEl = h("div", "mx-toast"); toastEl.setAttribute("role", "status"); toastEl.setAttribute("aria-live", "polite");
      document.body.append(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl && toastEl.classList.remove("on"), 1800);
  }

  // ---------- gestures ----------
  let press = null, swallowClick = 0, clickTimer = 0;
  const nodeOf = (t) => (t instanceof Element ? pick(t.closest(".msg-asst")) : null);
  const selectedInside = (node) => {
    const s = getSelection();
    return !!s && !s.isCollapsed && s.toString().trim() !== "" && (node.contains(s.anchorNode) || node.contains(s.focusNode));
  };
  host.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || !e.isPrimary) return;
    const node = nodeOf(e.target);
    if (!node || e.target.closest(OWN_CLICK)) return;
    const x0 = e.clientX, y0 = e.clientY;
    const t = setTimeout(() => {
      press = null;
      swallowClick = Date.now() + 800;
      try { navigator.vibrate?.(8); } catch { /* not supported */ }
      onRequest(node, { x: x0, y: y0 }, "press");
    }, 480);
    press = { t, x0, y0 };
  });
  const cancelPress = () => { if (press) { clearTimeout(press.t); press = null; } };
  host.addEventListener("pointermove", (e) => { if (press && Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > 10) cancelPress(); });
  host.addEventListener("pointerup", cancelPress);
  host.addEventListener("pointercancel", cancelPress);
  host.addEventListener("scroll", cancelPress, true);
  // A long press on a phone must not also pop the system context menu.
  host.addEventListener("contextmenu", (e) => { if (nodeOf(e.target) && (coarse() || press || swallowClick > Date.now())) e.preventDefault(); });
  host.addEventListener("click", (e) => {
    if (Date.now() < swallowClick) { e.preventDefault(); return; }
    if (coarse() && e.pointerType !== "mouse") return; // touch: a tap never opens it, only a long press
    const node = nodeOf(e.target);
    if (!node || e.target.closest(OWN_CLICK)) return;
    clearTimeout(clickTimer);
    if (e.detail > 1) return; // double / triple click selects a word or line: leave it alone
    const point = { x: e.clientX, y: e.clientY };
    // Wait out a double click, and never open the menu on the click that ends a drag selection.
    clickTimer = setTimeout(() => { if (!selectedInside(node)) onRequest(node, point, "click"); }, 230);
  });
  host.addEventListener("dblclick", () => clearTimeout(clickTimer));
  host.addEventListener("keydown", (e) => {
    const node = e.target instanceof Element && e.target.classList.contains("msg-asst") ? pick(e.target) : null;
    if (!node) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const r = node.getBoundingClientRect();
      onRequest(node, { x: r.left + 24, y: r.bottom }, "key");
    }
  });
  // Select Text on desktop leaves the message selectable; the next press elsewhere ends that mode.
  document.addEventListener("pointerdown", (e) => {
    if (selectingNode && !(e.target instanceof Element && selectingNode.contains(e.target))) { selectingNode.classList.remove("selecting"); selectingNode = null; }
  }, true);

  // ---------- the menu ----------
  function close(opts = {}) {
    clearTimeout(clickTimer);
    if (!menu) return;
    menu.remove(); backdrop.remove();
    menu = backdrop = null;
    activeNode?.classList.remove("mx-active");
    if (opts.refocus !== false && lastFocus && document.contains(lastFocus)) { try { lastFocus.focus({ preventScroll: true }); } catch { /* gone */ } }
    activeNode = null;
    document.removeEventListener("keydown", onKey, true);
  }
  function btns() { return menu ? [...menu.querySelectorAll("button:not([disabled])")].filter((b) => b.offsetParent !== null) : []; }
  function onKey(e) {
    if (!menu) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    const t = menu.querySelector(".mx-view[data-view='report'] textarea");
    if (t && e.target === t && e.key !== "Tab") return; // typing a comment
    const all = btns();
    if (!all.length) return;
    const i = all.indexOf(document.activeElement);
    let n = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") n = i < 0 ? 0 : (i + 1) % all.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") n = i < 0 ? all.length - 1 : (i - 1 + all.length) % all.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = all.length - 1;
    else if (e.key === "Tab") { n = e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : (i < 0 || i === all.length - 1 ? 0 : i + 1); }
    if (n >= 0) { e.preventDefault(); all[n].focus(); }
  }

  function row(ic, label, fn, cls = "") {
    const b = h("button", "mx-row " + cls); b.type = "button"; b.setAttribute("role", "menuitem");
    b.append(icon(ic), h("span", "", label));
    b.addEventListener("click", fn);
    return b;
  }
  function emojiBtn(em, on, fn) {
    const b = h("button", "mx-em" + (on ? " on" : ""), em); b.type = "button"; b.setAttribute("role", "menuitem");
    b.setAttribute("aria-pressed", on ? "true" : "false"); b.setAttribute("aria-label", `React ${em}`);
    b.addEventListener("click", () => fn(em));
    return b;
  }

  function open(spec) {
    close({ refocus: false });
    const { node, point, reactions = [], act } = spec;
    lastFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : node;
    activeNode = node;
    node.classList.add("mx-active");
    backdrop = h("div", "mx-backdrop");
    backdrop.addEventListener("pointerdown", (e) => { e.preventDefault(); close(); });
    backdrop.addEventListener("contextmenu", (e) => e.preventDefault());
    menu = h("div", "mx-menu"); menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Message actions");
    document.body.append(backdrop, menu);

    const go = (fn) => () => { close(); fn(); };
    const home = () => {
      menu.replaceChildren();
      const grab = h("div", "mx-grab"); grab.setAttribute("aria-hidden", "true");
      const on = new Set(reactions);
      const em = h("div", "mx-ems"); em.setAttribute("role", "group"); em.setAttribute("aria-label", "React");
      for (const e of QUICK) em.append(emojiBtn(e, on.has(e), (x) => { close(); act.react(x); }));
      const more = h("button", "mx-em mx-more"); more.type = "button"; more.setAttribute("role", "menuitem"); more.setAttribute("aria-label", "Add emoji");
      more.append(icon("i-smile-plus"));
      more.addEventListener("click", picker);
      em.append(more);
      const c1 = h("div", "mx-card");
      c1.append(row("i-reply", "Reply", go(act.reply)), row("i-unread", "Mark as unread", go(act.unread)));
      const c2 = h("div", "mx-card");
      c2.append(row("i-copy", "Copy", go(act.copy)), row("i-cursor", "Select Text", go(act.select)), row("i-copy", "Copy Request ID", go(act.copyId)));
      const c3 = h("div", "mx-card");
      c3.append(row("i-flag", "Report", report));
      const body = h("div", "mx-view"); body.dataset.view = "home";
      body.append(em, c1, c2, c3);
      menu.append(grab, body);
    };
    const picker = () => {
      menu.replaceChildren();
      const grab = h("div", "mx-grab"); grab.setAttribute("aria-hidden", "true");
      const head = h("div", "mx-head");
      const back = h("button", "mx-back"); back.type = "button"; back.setAttribute("aria-label", "Back"); back.append(icon("i-chev"));
      back.addEventListener("click", () => { home(); place(); btns()[0]?.focus(); });
      head.append(back, h("span", "mx-title", "Add emoji"));
      const grid = h("div", "mx-grid"); grid.setAttribute("role", "group"); grid.setAttribute("aria-label", "Emoji");
      const on = new Set(reactions);
      for (const e of [...QUICK, ...MORE]) grid.append(emojiBtn(e, on.has(e), (x) => { close(); act.react(x); }));
      const body = h("div", "mx-view"); body.dataset.view = "picker";
      body.append(head, grid);
      menu.append(grab, body);
      place();
      grid.querySelector("button")?.focus();
    };
    const report = () => {
      menu.replaceChildren();
      const grab = h("div", "mx-grab"); grab.setAttribute("aria-hidden", "true");
      const head = h("div", "mx-head");
      const back = h("button", "mx-back"); back.type = "button"; back.setAttribute("aria-label", "Back"); back.append(icon("i-chev"));
      back.addEventListener("click", () => { home(); place(); btns()[0]?.focus(); });
      head.append(back, h("span", "mx-title", "Report this reply"));
      const form = h("form", "mx-form");
      const grp = h("div", "mx-reasons"); grp.setAttribute("role", "radiogroup"); grp.setAttribute("aria-label", "What was wrong");
      let chosen = "";
      const chips = REPORT_REASONS.map((r) => {
        const b = h("button", "mx-chip", r); b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", "false");
        b.addEventListener("click", () => { chosen = r; for (const c of chips) { const on = c === b; c.classList.toggle("on", on); c.setAttribute("aria-checked", String(on)); } send.disabled = false; });
        grp.append(b);
        return b;
      });
      const ta = document.createElement("textarea");
      ta.rows = 3; ta.maxLength = 500; ta.placeholder = "Anything else? (optional)"; ta.setAttribute("aria-label", "Comment (optional)");
      ta.className = "mx-ta";
      const send = h("button", "mx-send", "Send report"); send.type = "submit"; send.disabled = true;
      form.append(grp, ta, send);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!chosen) return;
        send.disabled = true; send.textContent = "Sending…";
        const ok = await act.report(chosen, ta.value.trim());
        if (ok) close(); else { send.disabled = false; send.textContent = "Send report"; }
      });
      const body = h("div", "mx-view"); body.dataset.view = "report";
      body.append(head, form);
      menu.append(grab, body);
      place();
      chips[0].focus();
    };
    home();
    document.addEventListener("keydown", onKey, true);
    place();
    btns()[0]?.focus({ preventScroll: true });

    function place() {
      if (phone()) { menu.classList.add("sheet"); menu.style.left = menu.style.top = ""; return; }
      menu.classList.remove("sheet");
      const vw = innerWidth, vh = innerHeight, w = menu.offsetWidth, mh = menu.offsetHeight;
      const r = node.getBoundingClientRect();
      let left = Math.min(Math.max(8, r.left), vw - w - 8);
      let top;
      if (r.height > vh * 0.6) top = point.y + 12; // a tall message: next to where it was clicked
      else if (r.bottom + 8 + mh <= vh - 8) top = r.bottom + 8;
      else if (r.top - 8 - mh >= 8) top = r.top - 8 - mh;
      else top = point.y + 12;
      top = Math.min(Math.max(8, top), vh - mh - 8);
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
    }
  }

  // ---------- select text ----------
  function selectDesktop(node) {
    selectingNode?.classList.remove("selecting");
    node.classList.add("selecting"); selectingNode = node;
    const r = document.createRange(); r.selectNodeContents(node);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function selectSheet(text) {
    close({ refocus: false });
    const back = h("div", "mx-backdrop");
    const sheet = h("div", "mx-menu sheet mx-seltext"); sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-label", "Select text");
    const grab = h("div", "mx-grab"); grab.setAttribute("aria-hidden", "true");
    const head = h("div", "mx-head");
    const done = h("button", "mx-send mx-done", "Done"); done.type = "button";
    head.append(h("span", "mx-title", "Select text"), done);
    const ta = document.createElement("textarea");
    ta.readOnly = true; ta.value = text; ta.className = "mx-selarea"; ta.setAttribute("aria-label", "Message text");
    sheet.append(grab, head, ta);
    const end = () => { sheet.remove(); back.remove(); document.removeEventListener("keydown", esc, true); };
    const esc = (e) => { if (e.key === "Escape") { e.preventDefault(); end(); } };
    done.addEventListener("click", end);
    back.addEventListener("pointerdown", (e) => { e.preventDefault(); end(); });
    document.addEventListener("keydown", esc, true);
    document.body.append(back, sheet);
    ta.focus({ preventScroll: true });
    ta.select();
  }

  return { open, close, toast, selectDesktop, selectSheet, isOpen: () => !!menu, phone };
}

/** Writes text to the clipboard; true when it worked. Falls back to a hidden textarea where the async API is blocked. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* try the old way */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.className = "mx-offscreen";
    document.body.append(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}
