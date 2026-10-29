// Search in the sidebar header: finds bots (name, purpose) and threads (title) as you type, then opens the one you pick.
// DOM only: createElement and textContent, no HTML strings.

/** Every word of `query` must appear (any order, any case) in the item's text. */
export function matches(query, text) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const t = String(text || "").toLowerCase();
  return words.every((w) => t.includes(w));
}

/** Results for `query`: bots first, then threads and sessions, newest first. Pure, capped at `max`. */
export function searchItems(query, { bots = [], sessions = [] }, max = 30) {
  const byId = new Map(bots.map((b) => [b.id, b]));
  const out = [];
  for (const b of bots) if (matches(query, `${b.name} ${b.purpose || ""}`)) out.push({ kind: "bot", id: b.id, title: b.name, sub: b.purpose || "Bot", bot: b });
  const rows = sessions.filter((s) => s && typeof s.id === "string" && matches(query, `${s.title || "Untitled"}`)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const s of rows) {
    const owner = s.bot ? byId.get(s.bot) : null;
    out.push({ kind: "thread", id: s.id, title: s.title || "Untitled", sub: owner ? owner.name : "Session", session: s });
  }
  return out.slice(0, max);
}

export function initSearch(ctx) {
  const { h, getSessions, getBots, ensureLoaded, openSession, openBot, closeSidebar } = ctx;
  const $ = (id) => document.getElementById(id);
  const q = { open: $("btn-search"), card: $("search-modal"), input: $("search-input"), list: $("search-results"), close: $("search-close") };
  if (!q.open || !q.card) return null;
  let items = [], cur = 0, last = null;

  function paint() {
    q.list.replaceChildren();
    const term = q.input.value.trim();
    if (!term) { q.list.append(h("div", "search-empty", "Type to search your bots and threads.")); return; }
    if (!items.length) { q.list.append(h("div", "search-empty", "Nothing found.")); return; }
    items.forEach((it, i) => {
      const b = h("button", "search-item"); b.type = "button"; b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(i === cur));
      b.append(h("span", "search-kind", it.kind === "bot" ? "Bot" : "Thread"), h("span", "search-title", it.title), h("span", "search-sub", it.sub));
      b.addEventListener("click", () => pick(it));
      q.list.append(b);
    });
  }
  function run() {
    items = searchItems(q.input.value, { bots: getBots(), sessions: getSessions() });
    cur = 0; paint();
  }
  function pick(it) {
    close(false);
    if (closeSidebar) closeSidebar();
    if (it.kind === "bot") openBot(it.id); else openSession(it.session);
  }
  async function open() {
    last = document.activeElement;
    q.card.hidden = false;
    q.input.value = "";
    paint();
    q.input.focus();
    if (ensureLoaded) { await ensureLoaded(); if (!q.card.hidden) run(); }
  }
  function close(restore = true) {
    q.card.hidden = true;
    if (restore && last && last.focus) last.focus();
  }
  q.open.addEventListener("click", open);
  q.close.addEventListener("click", () => close());
  q.card.addEventListener("click", (e) => { if (e.target === q.card) close(); });
  q.input.addEventListener("input", run);
  q.card.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      cur = (cur + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      paint();
      const sel = q.list.querySelector('[aria-selected="true"]'); if (sel) sel.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && items[cur]) { e.preventDefault(); pick(items[cur]); }
  });
  return { open, close };
}
