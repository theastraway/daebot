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

// Provider grouping, mirroring the MIND app's picker (frontend/src/lib/llmProviders.ts): raw provider strings are
// canonicalised, groups follow a curated order, and anything unlisted goes last, alphabetically.
export const PROVIDER_ORDER = ["Auto", "OpenAI", "Anthropic", "Google", "xAI", "DeepSeek", "MiniMax", "Z.ai", "Qwen", "Meta", "Perplexity"];
const PROVIDER_CANONICAL = {
  openai: "OpenAI", anthropic: "Anthropic", google: "Google", googlegemini: "Google", gemini: "Google", xai: "xAI", grok: "xAI",
  meta: "Meta", metallama: "Meta", llama: "Meta", deepseek: "DeepSeek", minimax: "MiniMax", zai: "Z.ai", perplexity: "Perplexity",
  qwen: "Qwen", alibaba: "Qwen", mistral: "Mistral", mistralai: "Mistral", nvidia: "NVIDIA", openrouter: "Auto", moonshotai: "Moonshot AI",
  cohere: "Cohere", amazon: "Amazon", microsoft: "Microsoft", ai21: "AI21", nousresearch: "Nous Research", thudm: "Z.ai", zhipu: "Z.ai",
};
export const OTHER_GROUP = "Other";

/** A messy provider string -> its display name ("meta-llama" -> "Meta", "z-ai" -> "Z.ai"). */
export function canonicalProvider(raw) {
  const key = String(raw || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return OTHER_GROUP;
  if (PROVIDER_CANONICAL[key]) return PROVIDER_CANONICAL[key];
  return String(raw).trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/** The LLM company behind a model: the "Provider: Model" name prefix when the server gives one, else the id prefix
 *  ("meta-llama/llama-4-scout" -> Meta). A name prefix wins because it is what the user reads. */
export function providerOf(id, name) {
  if (typeof name === "string") {
    const c = name.indexOf(":");
    if (c > 0 && c <= 30) return canonicalProvider(name.slice(0, c));
  }
  if (typeof id === "string") {
    const slash = id.indexOf("/");
    if (slash > 0) return canonicalProvider(id.slice(0, slash));
  }
  return OTHER_GROUP;
}

/** The row's name with its "Provider: " prefix dropped, since the group header already says it. */
export function shortName(name, provider) {
  if (typeof name !== "string") return "";
  const c = name.indexOf(":");
  if (c > 0 && c <= 30 && canonicalProvider(name.slice(0, c)) === provider) return name.slice(c + 1).trim() || name;
  return name;
}

/** Group normalised rows by LLM company: curated order first, the rest alphabetical, "Other" last. Row order inside a
 *  group is kept (open models first, locked last, as normalizeModels left them). */
export function groupModels(rows) {
  const buckets = new Map();
  for (const r of rows) {
    const p = r.provider || OTHER_GROUP;
    if (!buckets.has(p)) buckets.set(p, []);
    buckets.get(p).push(r);
  }
  const names = [...buckets.keys()];
  const ordered = [
    ...PROVIDER_ORDER.filter((p) => buckets.has(p)),
    ...names.filter((p) => !PROVIDER_ORDER.includes(p) && p !== OTHER_GROUP).sort((a, b) => a.localeCompare(b)),
    ...(buckets.has(OTHER_GROUP) ? [OTHER_GROUP] : []),
  ];
  return ordered.map((provider) => ({ provider, models: buckets.get(provider) }));
}

/** Normalise the GET /models payload. Drops malformed rows; keeps the server's order but lists locked models last. */
export function normalizeModels(payload) {
  const raw = payload && Array.isArray(payload.models) ? payload.models : [];
  const rows = [];
  for (const m of raw) {
    if (!m || typeof m.id !== "string" || !m.id) continue;
    const name = prettyModel(m.id, m.name);
    rows.push({
      id: m.id,
      name,
      provider: providerOf(m.id, name),
      free: m.free === true,
      allowed: m.allowed !== false,
      priceHint: typeof m.price_hint === "string" ? m.price_hint : "",
    });
  }
  const open = rows.filter((r) => r.allowed), locked = rows.filter((r) => !r.allowed);
  const extra = {};
  if (payload && typeof payload.defaultSource === "string") extra.defSource = payload.defaultSource;
  if (payload && (payload.keySource === "byo" || payload.keySource === "platform")) extra.keySource = payload.keySource;
  return { rows: [...open, ...locked], def: payload && typeof payload.default === "string" ? payload.default : "", ...extra };
}

/** The small label next to the model: whose key / credits the answers run on. "" when unknown (a local key, or an older MIND). */
export function keyLabel(keySource) {
  return keySource === "byo" ? "via your key" : keySource === "platform" ? "MIND credits" : "";
}

/** Where the model on the badge came from, in words (for the tooltip). */
export function originOf({ pinned, chosen, stored, def, defSource, id }) {
  if (pinned) return "set for this bot";
  if (chosen && id === chosen) return "picked here";
  if (stored && id === stored) return "picked here";
  if (id && id === def && defSource === "account") return "from your MIND account";
  if (id && id === def && defSource === "picked") return "picked here";
  return id && id === def ? "Daebot default" : "";
}

/** What the badge says. A model chosen but not yet used wins (the next message will use it); otherwise the model that
 *  actually answered, then the default for new sessions, then the gateway's own. */
export function badgeModel({ served, chosen, def, health }) {
  return chosen || served || def || health || "";
}

/** Why the badge reads what it reads (for its tooltip). */
export function badgeTitle({ label, served, chosen, servedLabel, origin = "", key = "" }) {
  if (!label) return "Choose a model";
  if (chosen && served && chosen !== served) return `${label} from the next message (last answer: ${servedLabel || served}). Click to change.`;
  return `${label}${origin ? ` (${origin}${key ? `, ${key}` : ""})` : key ? ` (${key})` : ""}. Click to change.`;
}

export function initModels({ json, store, notify, icon, getSessionId, onPicked, onPinnedClick }) {
  const $ = (id) => document.getElementById(id);
  const btn = $("model-badge"), menu = $("model-menu"), nameEl = $("mb-name"), viaEl = $("mb-via");
  if (!btn || !menu || !nameEl) return null;

  const st = { rows: [], def: "", defSource: "", keySource: "", loaded: false, failed: false, served: "", health: "", chosen: new Map(), open: false, expanded: new Set(), pinned: "" };
  const stored = () => store.get("localStorage", MODEL_KEY) || "";
  const rowOf = (id) => st.rows.find((r) => r.id === id);
  const labelOf = (id) => { const r = rowOf(id); return r ? r.name : prettyModel(id); };

  function sessionChosen() { const id = getSessionId(); return id ? st.chosen.get(id) || "" : ""; }
  function currentId() {
    if (st.pinned) return st.pinned; // a bot thread: the bot's model is what runs
    return badgeModel({ served: st.served, chosen: sessionChosen(), def: stored() || st.def, health: st.health });
  }

  function paint() {
    const id = currentId();
    const label = id ? labelOf(id) : "";
    nameEl.textContent = label;
    const key = keyLabel(st.keySource);
    if (viaEl) viaEl.textContent = [st.pinned ? "set by bot" : "", key].filter(Boolean).join(" \u00b7 ");
    btn.dataset.owned = label ? "1" : "";
    btn.dataset.pinned = st.pinned ? "1" : "";
    btn.hidden = !label;
    if (st.pinned) {
      btn.title = `${label}${key ? ` (${key})` : ""}. Set by this bot's settings: this bot's threads always use it. Click to open the bot's settings.`;
      btn.setAttribute("aria-label", `Model: ${label}, set by bot. Open bot settings to change`);
      btn.removeAttribute("aria-haspopup"); btn.removeAttribute("aria-expanded");
      return;
    }
    btn.setAttribute("aria-haspopup", "menu"); btn.setAttribute("aria-expanded", String(st.open));
    const origin = originOf({ pinned: st.pinned, chosen: sessionChosen(), stored: stored(), def: st.def, defSource: st.defSource, id });
    btn.title = badgeTitle({ label, served: st.served, chosen: sessionChosen(), servedLabel: st.served ? labelOf(st.served) : "", origin, key });
    btn.setAttribute("aria-label", label ? `Model: ${label}. Change model` : "Choose a model");
  }

  async function load() {
    if (st.loaded) return true;
    try {
      const n = normalizeModels(await json("/models"));
      st.rows = n.rows; st.def = n.def; st.defSource = n.defSource || ""; st.keySource = n.keySource || ""; st.loaded = true; st.failed = false;
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
    const groups = groupModels(st.rows);
    for (const g of groups) {
      // The group holding the chosen model stays open (the active model is always visible); a lone group is always open.
      const hasCur = g.models.some((r) => r.id === cur);
      const pinned = hasCur || groups.length === 1;
      const open = pinned || st.expanded.has(g.provider);
      const gh = document.createElement("button");
      gh.type = "button"; gh.className = "mm-group"; gh.dataset.provider = g.provider;
      gh.setAttribute("aria-expanded", String(open));
      if (pinned) gh.dataset.pinned = "1";
      const gname = document.createElement("span"); gname.className = "mm-gname"; gname.textContent = g.provider;
      if (!open) {
        const gcount = document.createElement("span"); gcount.className = "mm-gcount"; gcount.textContent = String(g.models.length);
        gname.append(gcount);
      }
      gh.append(gname);
      if (!pinned) gh.append(icon(open ? "i-minus" : "i-plus"));
      gh.addEventListener("click", () => {
        if (pinned) return;
        if (st.expanded.has(g.provider)) st.expanded.delete(g.provider); else st.expanded.add(g.provider);
        const top = list.scrollTop;
        render();
        const l2 = menu.querySelector(".mm-list"); if (l2) l2.scrollTop = top;
        const again = [...menu.querySelectorAll(".mm-group")].find((el) => el.dataset.provider === g.provider);
        if (again) again.focus();
      });
      list.append(gh);
      if (!open) continue;
      for (const r of g.models) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "mm-item"; b.setAttribute("role", "menuitemradio"); b.dataset.model = r.id;
        b.setAttribute("aria-checked", String(r.id === cur));
        if (!r.allowed) { b.setAttribute("aria-disabled", "true"); b.classList.add("locked"); }
        const main = document.createElement("span"); main.className = "mm-main";
        const nm = document.createElement("span"); nm.className = "mm-name"; nm.textContent = shortName(r.name, g.provider);
        const sub = document.createElement("span"); sub.className = "mm-sub";
        const bits = [];
        if (!r.allowed) bits.push(LOCKED_NOTE);
        else { if (r.free) bits.push("Free"); if (r.priceHint) bits.push(r.priceHint); if (r.id === def) bits.push("Default"); }
        sub.textContent = bits.join(" \u00b7 ");
        main.append(nm); if (bits.length) main.append(sub);
        b.append(main);
        const tail = document.createElement("span"); tail.className = "mm-tail";
        if (!r.allowed) tail.append(icon("i-lock"));
        else if (r.id === cur) tail.append(icon("i-check"));
        b.append(tail);
        b.addEventListener("click", () => { if (r.allowed) choose(r); });
        list.append(b);
      }
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

  btn.addEventListener("click", () => {
    if (st.pinned) { if (st.open) setOpen(false); if (onPinnedClick) onPinnedClick(); return; } // the bot's model is changed in Bot settings, not here
    setOpen(!st.open);
  });
  document.addEventListener("pointerdown", (e) => { if (st.open && !menu.contains(e.target) && !btn.contains(e.target)) setOpen(false); });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll(".mm-group, .mm-item")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
  });
  btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown" && !st.open && !st.pinned) { e.preventDefault(); setOpen(true); } });
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
    /** A bot thread is on screen and its bot has its own model ("" = none): the badge shows that model, locked, with a "set by bot" note. */
    setPinned(id) { st.pinned = id || ""; if (st.pinned && st.open) setOpen(false); paint(); },
    /** The model list as loaded for the badge (shared with Bot settings). */
    list: load,
    rows: () => st.rows,
    labelOf,
    /** Sent with POST /sessions so a new session starts on the chosen default ("" lets the server decide). */
    defaultForNew() { return stored(); },
    close() { setOpen(false); },
  };
}
