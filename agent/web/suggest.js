// Suggested replies (web). After a reply that waits on the user, Dae drafts 1-3 replies in the user's voice and they show as chips
// above the composer. A chip only FILLS the composer (the user edits it and presses send); nothing is ever sent for them.
// What happened to the chips (taken as is, edited, ignored) is sent back so Dae learns the user's style.
// DOM is built with createElement + textContent only.

/** How the user used the chips: took one unchanged, edited one, or wrote their own. */
export function feedbackAction(picked, sent) {
  if (!picked) return "ignored";
  return String(sent || "").trim() === String(picked).trim() ? "chosen" : "edited";
}

export function initSuggest({ json, h, wrap, input, grow, currentId, isBusy }) {
  let cur = { id: null, shown: [], picked: "" };
  let seq = 0;
  // Collapsed by default on phones so the replies never cover the conversation; the choice is remembered per device.
  const KEY = "daebot.suggest.collapsed";
  let collapsed;
  try { const v = localStorage.getItem(KEY); collapsed = v === null ? !!(globalThis.matchMedia && matchMedia("(max-width: 640px)").matches) : v === "1"; }
  catch { collapsed = false; }

  function clear() {
    seq++;
    cur = { id: null, shown: [], picked: "" };
    wrap.replaceChildren();
    wrap.hidden = true;
  }

  function paint() {
    wrap.replaceChildren();
    if (!cur.shown.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    wrap.classList.toggle("collapsed", collapsed);
    const head = h("button", "suggest-label");
    head.type = "button";
    head.setAttribute("aria-expanded", String(!collapsed));
    head.append(h("span", "", "Reply as you"), h("span", "suggest-count", String(cur.shown.length)), h("span", "suggest-caret", ""));
    head.addEventListener("click", () => {
      collapsed = !collapsed;
      try { localStorage.setItem(KEY, collapsed ? "1" : "0"); } catch { /* private mode */ }
      paint();
    });
    wrap.append(head);
    if (collapsed) return;
    const list = h("div", "suggest-list");
    wrap.append(list);
    for (const text of cur.shown) {
      const b = h("button", `suggest-chip${cur.picked === text ? " picked" : ""}`);
      b.append(h("span", "suggest-text", text));
      b.type = "button"; b.title = "Puts this in the box so you can edit it. It is not sent.";
      b.addEventListener("click", () => {
        cur.picked = text;
        input.value = text; grow(); input.focus();
        try { input.setSelectionRange(text.length, text.length); } catch { /* not focusable yet */ }
        paint();
      });
      list.append(b);
    }
  }

  /** Ask the server for chips for the session that just finished a turn. Quiet on any failure: no chips is a fine outcome. */
  async function load(id) {
    if (!id) return;
    const mine = ++seq;
    try {
      const r = await json(`/sessions/${encodeURIComponent(id)}/suggest`, { method: "POST", body: "{}" });
      if (mine !== seq || id !== currentId() || isBusy(id)) return;
      const replies = (Array.isArray(r.replies) ? r.replies : []).filter((x) => typeof x === "string" && x.trim()).slice(0, 3);
      cur = { id, shown: replies, picked: "" };
      paint();
    } catch { /* no chips */ }
  }

  /** Called with every message the user sends: reports what they did with the chips, then clears them. */
  function onSend(text) {
    const { id, shown, picked } = cur;
    clear();
    if (!id || !shown.length) return;
    json(`/sessions/${encodeURIComponent(id)}/suggest-feedback`, { method: "POST", body: JSON.stringify({ shown, picked: picked || undefined, sent: text, action: feedbackAction(picked, text) }) }).catch(() => {});
  }

  return { load, clear, onSend, shown: () => cur.shown.slice() };
}
