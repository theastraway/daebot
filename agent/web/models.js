// Model picker for Daebot (web). The header badge is a button; it opens a small menu built from GET /models.
// Locked models (not on the user's plan) show a lock and "Plus and up" and cannot be chosen. Choosing sets the current
// session's model (PATCH /sessions/:id) or, with no session yet, the default for new sessions (kept in this browser).
// The badge always shows the model actually in use: the one that served the last answer, or the one just chosen.
// DOM is built with createElement + textContent only; no innerHTML; same-origin requests go through the app's own helpers.

export const MODEL_KEY = "mc_model";
export const LOCKED_NOTE = "Plus and up";

const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

/** "qwen/qwen3.8-flash:free" -> "Qwen 3.8 Flash (free)". A server-provided display name always wins. */
export function prettyModel(id, name) {
  if (typeof name === "string" && name.trim()) return name.trim();
  if (typeof id !== "string" || !id.trim()) return "";
  let s = id.trim();
  const slash = s.indexOf("/");
  if (slash > 0) s = s.slice(slash + 1);
  let free = false;
  s = s.replace(/:free$/i, () => { free = true; return ""; });
  const pretty = /\s/.test(s) ? s : titleCase(s.replace(/[-_]+/g, " ").replace(/([a-z])(\d)/gi, "$1 $2").trim());
  return pretty + (free ? " (free)" : "");
}

/** Normalise the GET /models payload. Drops malformed rows; keeps the server's order but lists locked models last. */
export function normalizeModels(payload) {
  const raw = payload && Array.isArray(payload.models) ? payload.models : [];
  const rows = [];
  for (const m of raw) {
    if (!m || typeof m.id !== "string" || !m.id) continue;
    rows.push({
      id: m.id,
      name: prettyModel(m.id, m.name),
      free: m.free === true,
      allowed: m.allowed !== false,
      priceHint: typeof m.price_hint === "string" ? m.price_hint : "",
    });
  }
  const open = rows.filter((r) => r.allowed), locked = rows.filter((r) => !r.allowed);
  return { rows: [...open, ...locked], def: payload && typeof payload.default === "string" ? payload.default : "" };
}

/** What the badge says. A model chosen but not yet used wins (the next message will use it); otherwise the model that
 *  actually answered, then the default for new sessions, then the gateway's own. */
export function badgeModel({ served, chosen, def, health }) {
  return chosen || served || def || health || "";
}

/** Why the badge reads what it reads (for its tooltip). */
export function badgeTitle({ label, served, chosen, servedLabel }) {
  if (!label) return "Choose a model";
  if (chosen && served && chosen !== served) return `${label} from the next message (last answer: ${servedLabel || served}). Click to change.`;
  return `${label}. Click to change.`;
}

export function initModels({ json, store, notify, icon, getSessionId, onPicked }) {
  const $ = (id) => document.getElementById(id);
  const btn = $("model-badge"), menu = $("model-menu"), nameEl = $("mb-name"), viaEl = $("mb-via");
  if (!btn || !menu || !nameEl) return null;

  const st = { rows: [], def: "", loaded: false, failed: false, served: "", health: "", chosen: new Map(), open: false };
  const stored = () => store.get("localStorage", MODEL_KEY) || "";
  const rowOf = (id) => st.rows.find((r) => r.id === id);
  const labelOf = (id) => { const r = rowOf(id); return r ? r.name : prettyModel(id); };

  function sessionChosen() { const id = getSessionId(); return id ? st.chosen.get(id) || "" : ""; }
  function currentId() {
    return badgeModel({ served: st.served, chosen: sessionChosen(), def: stored() || st.def, health: st.health });
  }

  function paint() {
    const id = currentId();
    const label = id ? labelOf(id) : "";
    nameEl.textContent = label;
    if (viaEl) viaEl.textContent = "";
    btn.dataset.owned = label ? "1" : "";
    btn.hidden = !label;
    btn.title = badgeTitle({ label, served: st.served, chosen: sessionChosen(), servedLabel: st.served ? labelOf(st.served) : "" });
    btn.setAttribute("aria-label", label ? `Model: ${label}. Change model` : "Choose a model");
  }

  async function load() {
    if (st.loaded) return true;
    try {
      const n = normalizeModels(await json("/models"));
      st.rows = n.rows; st.def = n.def; st.loaded = true; st.failed = false;
    } catch { st.failed = true; }
    paint();
    return st.loaded;
  }

  function render() {
    menu.replaceChildren();
    const head = document.createElement("div"); head.className = "mm-head"; head.textContent = "Model";
    menu.append(head);
    if (!st.rows.length) {
      const p = document.createElement("p"); p.className = "mm-empty";
      p.textContent = st.failed ? "Models could not be loaded." : "No models available.";
      menu.append(p);
      return;
    }
    const cur = currentId();
    const def = stored() || st.def;
    const list = document.createElement("div"); list.className = "mm-list"; list.setAttribute("role", "none");
    for (const r of st.rows) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "mm-item"; b.setAttribute("role", "menuitemradio"); b.dataset.model = r.id;
      b.setAttribute("aria-checked", String(r.id === cur));
      if (!r.allowed) { b.setAttribute("aria-disabled", "true"); b.classList.add("locked"); }
      const main = document.createElement("span"); main.className = "mm-main";
      const nm = document.createElement("span"); nm.className = "mm-name"; nm.textContent = r.name;
      const sub = document.createElement("span"); sub.className = "mm-sub";
      const bits = [];
      if (!r.allowed) bits.push(LOCKED_NOTE);
      else { if (r.free) bits.push("Free"); if (r.priceHint) bits.push(r.priceHint); if (r.id === def) bits.push("Default"); }
      sub.textContent = bits.join(" · ");
      main.append(nm); if (bits.length) main.append(sub);
      b.append(main);
      const tail = document.createElement("span"); tail.className = "mm-tail";
      if (!r.allowed) tail.append(icon("i-lock"));
      else if (r.id === cur) tail.append(icon("i-check"));
      b.append(tail);
      b.addEventListener("click", () => { if (r.allowed) choose(r); });
      list.append(b);
    }
    menu.append(list);
    const foot = document.createElement("div"); foot.className = "mm-foot";
    const note = document.createElement("span");
    note.textContent = getSessionId() ? "Applies to this session." : "Applies to new sessions.";
    foot.append(note);
    if (getSessionId() && cur && cur !== def) {
      const mk = document.createElement("button"); mk.type = "button"; mk.className = "mm-link"; mk.textContent = "Use for new sessions";
      mk.addEventListener("click", () => { store.set("localStorage", MODEL_KEY, cur); paint(); render(); });
      foot.append(mk);
    }
    menu.append(foot);
  }

  async function choose(r) {
    const sid = getSessionId();
    if (sid) {
      try { await json(`/sessions/${encodeURIComponent(sid)}`, { method: "PATCH", body: JSON.stringify({ model: r.id }) }); }
      catch (e) { setOpen(false); return notify(`Could not switch model: ${e.message}`); }
      st.chosen.set(sid, r.id);
    } else {
      store.set("localStorage", MODEL_KEY, r.id);
    }
    paint(); setOpen(false); btn.focus();
    if (onPicked) onPicked(r.id);
  }

  async function setOpen(open) {
    if (open === st.open) return;
    st.open = open;
    btn.setAttribute("aria-expanded", String(open));
    if (!open) { menu.hidden = true; return; }
    menu.hidden = false;
    render();
    await load();
    if (!st.open) return;
    render();
    const first = menu.querySelector('.mm-item[aria-checked="true"]') || menu.querySelector(".mm-item:not(.locked)");
    if (first) first.focus();
  }

  btn.addEventListener("click", () => setOpen(!st.open));
  document.addEventListener("pointerdown", (e) => { if (st.open && !menu.contains(e.target) && !btn.contains(e.target)) setOpen(false); });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll(".mm-item")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
  });
  btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown" && !st.open) { e.preventDefault(); setOpen(true); } });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && st.open) { e.stopPropagation(); setOpen(false); btn.focus(); }
  }, true);

  load();
  return {
    /** The model that served the last answer in the session being shown ("" if none yet). */
    setServed(id) { st.served = id || ""; paint(); },
    /** An answer just finished on this session: the model that served it is now the truth, any pending choice is spent. */
    answered(sessionId, id) { if (sessionId) st.chosen.delete(sessionId); st.served = id || st.served; paint(); },
    /** The gateway's own model from /health: the label until anything better is known. */
    setHealth(id) { st.health = id || ""; paint(); },
    /** The session on screen changed: re-read which model it uses. */
    refresh() { paint(); if (st.open) render(); },
    /** Sent with POST /sessions so a new session starts on the chosen default ("" lets the server decide). */
    defaultForNew() { return stored(); },
    close() { setOpen(false); },
  };
}
