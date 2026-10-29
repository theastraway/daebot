// Bots for Daebot (web): the Sessions | Bots switch in the sidebar, the bot list with each bot's threads, the New bot card,
// and the Instructions drawer (DAEBOT.md editor, rename, purpose, LED colour, delete).
//
// A bot is a Daebot with its own job, its own instructions and its own threads. Its identity is a colour for the mascot's lit LEDs
// plus the bot's initial in a small badge; the mascot itself is never redrawn (it is the <m-bot> component, tinted by `accent`).
//
// DOM is built with createElement + textContent only; there is no innerHTML. All requests are same-origin, through the app's
// api()/json() helpers. The pure helpers are exported (and unit tested); everything that touches `document` lives in initBots().

import { confirmDialog, deleteControl, renameControl, isRenaming, botDeleteText, updateText } from "./manage.js";
import { FACES, faceOf } from "./faces.js";
import { mascotFor, setMascot, wakeOn } from "./mbadge.js";
import { groupModels, shortName, LOCKED_NOTE } from "./models.js";
import { initRoutines } from "./routines.js";

export const VIEW_KEY = "mc_view";
export const SELECTED_KEY = "mc_bot";
export const OPEN_KEY = "mc_bots_open";
export const MAX_INSTRUCTION_BYTES = 8 * 1024;
export const NAME_MAX = 40;
export const PURPOSE_MAX = 140;
export const DEFAULT_COLOR = "#ffd25a";
/** The preset LED colours a bot can wear. */
export const COLORS = [
  { hex: "#ffd25a", name: "Amber" },
  { hex: "#ff9a3d", name: "Orange" },
  { hex: "#7dff9a", name: "Green" },
  { hex: "#5ee0ff", name: "Cyan" },
  { hex: "#a98bff", name: "Violet" },
  { hex: "#ff7ad9", name: "Pink" },
  { hex: "#ff6b6b", name: "Red" },
  { hex: "#6b8cff", name: "Blue" },
  { hex: "#2dd4bf", name: "Teal" },
  { hex: "#c8f04a", name: "Lime" },
];
/** The face a new bot starts with (its personality is shown right under the grid, so nothing is applied silently). */
export const DEFAULT_FACE = "operator";

// ---------------------------------------------------------------- pure helpers

/** A colour we are willing to put on screen: #rrggbb only, else the default amber. */
export function safeColor(c) {
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim().toLowerCase() : DEFAULT_COLOR;
}

/** Pinned bots first (in the order they were pinned), then the rest in their given order. */
export function orderBots(list) {
  const all = Array.isArray(list) ? list.filter(Boolean) : [];
  const isPin = (b) => !!(b.pinned || b.pinnedAt);
  const pinned = all.filter(isPin).sort((a, b) => (a.pinnedAt || 0) - (b.pinnedAt || 0) || String(a.name).localeCompare(String(b.name)));
  return { pinned, rest: all.filter((b) => !isPin(b)) };
}

/** The thread to open when a bot is clicked: its most recently updated one, or null when it has none. */
export function topThread(list) {
  let top = null;
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || typeof t.id !== "string") continue;
    if (!top || (Number(t.updatedAt) || 0) > (Number(top.updatedAt) || 0)) top = t;
  }
  return top;
}

/** Which bots have their thread list open: remembered per bot. Anything but an array of strings is ignored. */
export function parseOpen(raw) {
  try {
    const a = JSON.parse(raw);
    return new Set(Array.isArray(a) ? a.filter((x) => typeof x === "string").slice(0, 200) : []);
  } catch { return new Set(); }
}
export function serializeOpen(set) { return JSON.stringify([...set].slice(0, 200)); }

/** The letter shown in a bot's badge. */
export function initialOf(name) {
  const m = /[\p{L}\p{N}]/u.exec(String(name || "").trim());
  return m ? m[0].toUpperCase() : "B";
}

/** UTF-8 size of a string: the gateway limits instructions to 8 KB of bytes, not characters. */
export function byteLength(s) {
  return new TextEncoder().encode(String(s ?? "")).length;
}

export function countLabel(bytes, max = MAX_INSTRUCTION_BYTES) {
  return `${bytes.toLocaleString("en-US")} / ${max.toLocaleString("en-US")} bytes`;
}

/** The editor text for a brand-new bot. Filled from the name and purpose so it is a real starting point, not a blank page. */
export function starterTemplate(name, purpose) {
  const n = String(name || "").trim() || "this bot";
  const p = String(purpose || "").trim();
  return [
    "# Role",
    p ? `You are ${n}. Your job: ${p}` : `You are ${n}. Your job: (say what this bot is for in one sentence).`,
    "",
    "# How you work",
    "- Look in MIND before you answer. Say what you found.",
    "- Keep answers short and concrete.",
    "- Ask before anything that reaches a real person or cannot be undone.",
    "",
    "# Never",
    "- Guess a number, name, price or date. Say you do not know and go find it.",
    "",
  ].join("\n");
}

/** Plain-words message for a failed create/update. Returns { text, href?, linkText? }. */
export function botErrorMessage(status, body) {
  const b = body && typeof body === "object" ? body : {};
  const code = typeof b.error === "string" ? b.error : "";
  if (status === 402 || code === "bot_limit") {
    const n = Number(b.limit);
    let href = "";
    try { const u = new URL(String(b.upgrade_url || "")); if (u.protocol === "https:" || u.protocol === "http:") href = u.href; } catch { /* no link */ }
    const head = Number.isFinite(n) && n >= 0 ? `Your plan includes ${n} ${n === 1 ? "bot" : "bots"}.` : "Your plan has reached its bot limit.";
    return href ? { text: `${head} Upgrade to add more.`, href, linkText: "Upgrade" } : { text: `${head} Upgrade your plan to add more.` };
  }
  if (status === 409 || code === "name_taken" || code === "conflict") return { text: "You already have a bot with that name. Pick another." };
  if (code === "name_required") return { text: "Give your bot a name." };
  if (code === "instructions_too_long" || status === 413) return { text: "The instructions are over 8 KB. Trim them and try again." };
  if (status === 404) return { text: "Bots are not available on this gateway yet." };
  if (status === 400 || status === 422) return { text: "Check the name and purpose, then try again." };
  return { text: "Something went wrong. Try again in a moment." };
}

/** Sessions that belong in the plain Sessions list: bot threads live under their bot. */
export function generalSessions(list) {
  return (Array.isArray(list) ? list : []).filter((s) => !s.bot && !s.peer);
}

/** "from Quinn" for a DM thread. `peer` may be a bot id, a slug or already a name. */
export function peerLabel(peer, bots) {
  if (!peer) return "";
  const hit = (bots || []).find((b) => b.id === peer || b.slug === peer || b.name === peer);
  return `from ${hit ? hit.name : String(peer)}`;
}

/** live/busy -> the dot's state. */
export function dotState(bot) {
  return bot && bot.busy ? "busy" : bot && bot.live ? "live" : "idle";
}
export const DOT_LABEL = { busy: "Working", live: "Live", idle: "Idle" };

// ---------------------------------------------------------------- UI

export function initBots(ctx) {
  const { json, api, store, h, icon, ago, notify, app } = ctx;
  const $ = (id) => document.getElementById(id);
  const el = {
    tabSessions: $("tab-sessions"), tabBots: $("tab-bots"), sideLabel: $("side-label"), btnNew: $("btn-new"),
    sessionList: $("session-list"), botList: $("bot-list"),
    topBadge: $("top-badge"), btnInstr: $("btn-instr"),
    drawer: $("instr-drawer"), drawerTitle: $("instr-title"), drawerClose: $("instr-close"),
    text: $("instr-text"), count: $("instr-count"), stateEl: $("instr-state"), save: $("instr-save"), revert: $("instr-revert"),
    name: $("bd-name"), purpose: $("bd-purpose"), colors: $("bd-colors"), saveDetails: $("bd-save"), detailsState: $("bd-state"),
    model: $("bd-model"), modelState: $("bd-model-state"), faces: $("bd-faces"), faceDesc: $("bd-face-desc"), bnFaces: $("bn-faces"), bnFaceDesc: $("bn-face-desc"), bnColors: $("bn-colors"),
    del: $("bd-delete"), verText: $("bd-ver-text"), verCurrent: $("bd-ver-current"), verNotes: $("bd-ver-notes"), verBtn: $("bd-update"),
    card: $("bot-new"), cardForm: $("bot-new-form"), bnName: $("bn-name"), bnPurpose: $("bn-purpose"), bnInstr: $("bn-instr"),
    bnErr: $("bn-err"), bnCreate: $("bn-create"), bnCancel: $("bn-cancel"),
    bnBrief: $("bn-brief"), bnAsk: $("bn-ask"), bnAskState: $("bn-ask-state"),
  };
  if (!el.tabBots || !el.botList) return null;
  const routines = initRoutines({ json, api, h, ago, notify, confirmDialog, openThread: (s) => app.openThread(s) });

  const st = {
    updating: new Set(), updated: new Map(),
    view: store.get("localStorage", VIEW_KEY) === "bots" ? "bots" : "sessions",
    bots: [], botsLoaded: false, botsError: "",
    selected: store.get("localStorage", SELECTED_KEY) || "",
    expanded: new Set(),
    mascots: new Map(),
    threads: [], threadsFor: "", cache: new Map(), loading: new Set(),
    drawerBot: "", pinned: false, baseline: "", drafts: new Map(), loadingInstr: false, drawerOpen: false,
    color: DEFAULT_COLOR, face: "", newColor: DEFAULT_COLOR, newFace: DEFAULT_FACE, cardDirty: false, lastFocus: null,
  };
  { // thread lists open or closed per bot, remembered; before anything was remembered the selected bot's list is open (as it used to be)
    const raw = store.get("localStorage", OPEN_KEY);
    if (raw == null) { if (st.selected) st.expanded.add(st.selected); } else st.expanded = parseOpen(raw);
  }
  const saveOpen = () => store.set("localStorage", OPEN_KEY, serializeOpen(st.expanded));
  /** A bot's M avatar, kept between list redraws so the LEDs are built once. */
  function mascot(bot) {
    let m = st.mascots.get(bot.id);
    if (!m) { m = mascotFor(bot); st.mascots.set(bot.id, m); } else setMascot(m, bot);
    return m;
  }

  const botById = (id) => st.bots.find((b) => b.id === id);
  /** The bot the user is working with: the open thread's bot, else the one picked in the list. */
  function activeBotId() { return app.currentBot() || (st.view === "bots" ? st.selected : "") || ""; }
  const activeBot = () => botById(activeBotId());

  /** A bot's badge: the M mascot with the bot's chosen LED face, in its LED colour. */
  function paintBadge(node, bot) {
    node.classList.add("has-mbot");
    node.style.setProperty("--bot", safeColor(bot && bot.color));
    let m = node.querySelector("m-bot");
    if (!m) { m = mascotFor(bot); node.replaceChildren(m); wakeOn(node, m); } else setMascot(m, bot);
  }

  /** LED colour swatches in `box` (a radiogroup): get/set the colour, arrow keys move the choice. */
  function mountSwatches(box, get, set) {
    const paint = () => {
      box.replaceChildren();
      for (const c of COLORS) {
        const b = h("button", "swatch"); b.type = "button";
        b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(c.hex === get())); b.setAttribute("aria-label", c.name); b.title = c.name;
        b.tabIndex = c.hex === get() ? 0 : -1;
        b.style.setProperty("--sw", c.hex);
        b.addEventListener("click", () => { set(c.hex); paint(); b.focus(); });
        box.append(b);
      }
    };
    box.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      const i = Math.max(0, COLORS.findIndex((c) => c.hex === get()));
      const d = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
      set(COLORS[(i + d + COLORS.length) % COLORS.length].hex);
      paint();
      box.querySelector('[aria-checked="true"]').focus();
    });
    return paint;
  }

  /** The face grid in `box` (a radiogroup) plus the picked face's name and one-liner in `desc`. The face is drawn in the chosen LED colour. */
  function mountFaces(box, desc, get, set, color) {
    const paint = () => {
      box.replaceChildren();
      box.style.setProperty("--bot", safeColor(color()));
      const cur = get();
      FACES.forEach((f, i) => {
        const on = f.id === cur;
        const b = h("button", "face-opt"); b.type = "button";
        b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(on)); b.setAttribute("aria-label", `${f.name}: ${f.blurb}`); b.title = `${f.name}: ${f.blurb}`;
        b.tabIndex = on || (!cur && i === 0) ? 0 : -1;
        b.dataset.face = f.id;
        const fm = mascotFor({ face: f.id, color: color() }); fm.classList.add("face-m");
        wakeOn(b, fm);
        b.append(fm, h("span", "face-name", f.name));
        b.addEventListener("click", () => { set(f.id); paint(); box.querySelector('[aria-checked="true"]').focus(); });
        box.append(b);
      });
      const f = faceOf(cur);
      desc.textContent = f ? `${f.name}: ${f.blurb} Its personality shapes how this bot talks; your instructions still come first.` : "Pick a face. Each one is a personality.";
    };
    box.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      const i = Math.max(0, FACES.findIndex((f) => f.id === get()));
      const d = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
      set(FACES[(i + d + FACES.length) % FACES.length].id);
      paint();
      box.querySelector('[aria-checked="true"]').focus();
    });
    return paint;
  }
  function badge(bot, cls = "") {
    const b = h("span", `bot-badge ${cls}`.trim());
    b.setAttribute("aria-hidden", "true");
    b.classList.add("has-mbot");
    b.style.setProperty("--bot", safeColor(bot && bot.color));
    b.append(mascot(bot));
    return b;
  }

  // ---------------------------------------------------------------- view switch
  function setView(v, { silent } = {}) {
    st.view = v === "bots" ? "bots" : "sessions";
    store.set("localStorage", VIEW_KEY, st.view);
    const isBots = st.view === "bots";
    el.tabSessions.setAttribute("aria-pressed", String(!isBots));
    el.tabBots.setAttribute("aria-pressed", String(isBots));
    el.sessionList.hidden = isBots;
    el.botList.hidden = !isBots;
    el.sideLabel.firstChild.textContent = isBots ? "Bots" : "Sessions";
    el.btnNew.hidden = isBots; // New bot lives in the sidebar header now
    el.btnNew.querySelector("span").textContent = isBots ? "New bot" : "New session";
    el.btnNew.setAttribute("aria-label", isBots ? "New bot" : "New session");
    sync();
    if (!silent) app.refresh();
  }
  el.tabSessions.addEventListener("click", () => setView("sessions"));
  el.tabBots.addEventListener("click", () => setView("bots"));
  document.getElementById("seg").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = st.view === "bots" ? "sessions" : "bots";
    setView(next);
    (next === "bots" ? el.tabBots : el.tabSessions).focus();
  });

  // ---------------------------------------------------------------- data
  async function refresh() {
    try {
      st.bots = (await json("/bots")).bots || [];
      st.botsLoaded = true; st.botsError = "";
    } catch (e) {
      if (e.message === "unauthorized") return;
      st.botsError = /HTTP 404|not found/i.test(e.message) ? "Bots are not available on this gateway yet." : "Could not load your bots.";
    }
    if (st.selected && st.botsLoaded && !botById(st.selected)) { st.expanded.delete(st.selected); st.selected = ""; store.set("localStorage", SELECTED_KEY, ""); }
    const want = app.currentBot() || (st.view === "bots" ? st.selected : "");
    if (want && botById(want)) await loadThreads(want, { quiet: true });
    renderList(); sync();
  }

  async function loadThreads(id, { quiet, cacheOnly } = {}) {
    try {
      const list = (await json(`/sessions?bot=${encodeURIComponent(id)}`)).sessions || [];
      st.cache.set(id, list);
      if (cacheOnly) { renderList(); return; }
      st.threads = list;
      st.threadsFor = id;
    } catch { if (cacheOnly) { if (!st.cache.has(id)) st.cache.set(id, []); return; } if (st.threadsFor !== id) { st.threads = []; st.threadsFor = id; } }
    if (!quiet) renderList();
  }

  // ---------------------------------------------------------------- list
  function renderList() {
    if (isRenaming()) return; // an inline rename is open: the list is redrawn when it ends
    const box = el.botList;
    box.replaceChildren();
    if (st.botsError && !st.bots.length) { box.append(h("div", "empty-side", st.botsError)); return; }
    if (!st.botsLoaded) { box.append(h("div", "empty-side", "Loading bots…")); return; }
    if (!st.bots.length) {
      const e = h("div", "bots-empty");
      e.append(h("p", "", "No bots yet. Give Daebot a job of its own."));
      const b = h("button", "btn-primary", "Create your first bot"); b.type = "button";
      b.addEventListener("click", () => openCard());
      e.append(b);
      box.append(e);
      return;
    }
    for (const id of [...st.mascots.keys()]) if (!botById(id)) st.mascots.delete(id);
    const { pinned, rest } = orderBots(st.bots);
    if (pinned.length) {
      box.append(h("div", "bot-group", "Pinned"));
      for (const bot of pinned) box.append(botRow(bot));
      box.append(h("div", "bot-group", "Bots"));
    }
    for (const bot of rest) box.append(botRow(bot));
    const ex = app.exchangesGroup && app.exchangesGroup(); // the agent exchanges, with unread dots
    if (ex) box.append(ex);
  }

  function botRow(bot) {
    const row = h("div", "bot-row");
    const open = st.expanded.has(bot.id);
    const item = h("button", "bot-item"); item.type = "button";
    if (activeBotId() === bot.id) item.setAttribute("aria-current", "true");
    const text = h("span", "bot-text");
    text.append(h("span", "bot-name", bot.name), h("span", "bot-purpose", bot.purpose || "No purpose yet"));
    const ds = dotState(bot);
    const dot = h("span", `bot-dot ${ds}`);
    dot.setAttribute("role", "img"); dot.setAttribute("aria-label", DOT_LABEL[ds]); dot.title = DOT_LABEL[ds];
    item.append(badge(bot), text, dot);
    if (bot.pinned || bot.pinnedAt) { const pm = icon("i-pin"); pm.classList.add("bot-pinmark"); pm.setAttribute("aria-hidden", "true"); item.append(pm); } // its own slot at the right edge, beside the status dot
    if (app.exchangeUnread && app.exchangeUnread(bot.id) > 0) { const u = h("i", "xchg-dot"); u.setAttribute("role", "img"); u.setAttribute("aria-label", "Unread agent exchange"); item.append(u); }
    item.addEventListener("click", () => selectBot(bot));
    const head = h("div", `bot-head${bot.pinned || bot.pinnedAt ? " pinned" : ""}${bot.updateAvailable ? " has-upd" : ""}`);
    // The disclosure chevron only shows or hides this bot's threads; clicking the row itself opens the bot's top thread.
    const chev = h("button", "bot-chev side-icon"); chev.type = "button";
    chev.setAttribute("aria-expanded", String(open)); chev.dataset.botId = bot.id;
    const label = `${open ? "Hide" : "Show"} threads for ${bot.name}`;
    chev.setAttribute("aria-label", label); chev.title = label;
    chev.append(icon("i-chev"));
    chev.addEventListener("click", () => toggleThreads(bot));
    head.append(chev, item);
    if (bot.updateAvailable) {
      const up = h("button", "bot-upd", "Update"); up.type = "button"; up.title = updateText(bot.version, bot.latestVersion).available;
      up.setAttribute("aria-label", `Update ${bot.name}: ${updateText(bot.version, bot.latestVersion).available}`);
      up.addEventListener("click", (e) => { e.stopPropagation(); updateBot(bot.id); });
      head.append(up);
    }
    const pin = h("button", "row-del row-pin"); pin.type = "button";
    const pinned = !!(bot.pinned || bot.pinnedAt);
    const pinLabel = `${pinned ? "Unpin" : "Pin"} ${bot.name}`;
    pin.setAttribute("aria-label", pinLabel); pin.title = pinned ? "Unpin" : "Pin to top";
    pin.setAttribute("aria-pressed", String(pinned));
    pin.append(icon("i-pin"));
    pin.addEventListener("click", (e) => { e.stopPropagation(); setPinned(bot, !pinned); });
    head.append(pin);
    head.append(deleteControl(head, icon, `Delete bot ${bot.name}`, () => deleteBot(bot.id)));
    // Bot settings: the gear opens this bot's settings (model, instructions, name, face) without opening or closing the row.
    const gear = h("button", "row-del row-gear"); gear.type = "button";
    gear.setAttribute("aria-label", `Bot settings for ${bot.name}`); gear.title = `Bot settings for ${bot.name}`;
    gear.setAttribute("aria-expanded", String(st.drawerOpen && st.drawerBot === bot.id));
    gear.dataset.botId = bot.id;
    gear.append(icon("i-gear"));
    gear.addEventListener("click", (e) => { e.stopPropagation(); openSettings(bot.id); });
    head.append(gear);
    wakeOn(head, mascot(bot));
    row.append(head);
    if (open) {
      const sub = h("div", "bot-threads");
      const nt = h("button", "bot-newthread"); nt.type = "button";
      nt.append(icon("i-plus"), h("span", "", `New thread with ${bot.name}`));
      nt.addEventListener("click", () => app.newThread(bot.id));
      sub.append(nt);
      // Every expanded bot keeps its own thread list (the last one loaded stays on screen while another bot is selected).
      const cached = st.threadsFor === bot.id ? st.threads : st.cache.get(bot.id);
      const mine = cached || [];
      if (!cached && !st.loading.has(bot.id)) { st.loading.add(bot.id); loadThreads(bot.id, { cacheOnly: true, quiet: true }).finally(() => st.loading.delete(bot.id)); }
      if (!mine.length) sub.append(h("div", "empty-side", cached ? "No threads yet." : "Loading threads…"));
      for (const s of mine) {
        const b = h("button", "sess"); b.type = "button";
        if (s.id === app.currentId()) b.setAttribute("aria-current", "true");
        if (s.unread) { b.classList.add("unread"); b.title = "Unread"; }
        const m = h("span", "sess-m");
        const bits = [];
        if (s.peer) bits.push(peerLabel(s.peer, st.bots).replace(/^from /, ""));
        bits.push(s.surface || "web", ago(s.updatedAt));
        bits.forEach((t, i) => { if (i) m.append(h("span", "sep", "·")); m.append(h("span", s.peer && i === 0 ? "peer" : "", t)); });
        if (s.live) { m.append(h("span", "sep", "·"), h("span", "live", s.busy ? "working" : "live")); }
        b.append(h("span", "sess-t", s.title || "Untitled"), m);
        b.addEventListener("click", () => app.openThread({ ...s, bot: s.bot || bot.id }));
        const tr = h("div", "sess-row");
        const startRename = () => app.renameThread(b, { ...s, bot: s.bot || bot.id });
        b.addEventListener("dblclick", (e) => { e.preventDefault(); startRename(); });
        tr.append(b, renameControl(tr, icon, `Rename thread ${s.title || "Untitled"}`, startRename), deleteControl(tr, icon, `Delete thread ${s.title || "Untitled"}`, () => app.threadDeleted({ ...s, bot: s.bot || bot.id })));
        sub.append(tr);
      }
      row.append(sub);
    }
    return row;
  }

  /** Show or hide a bot's thread list (remembered per bot). Does not touch the chat. */
  async function toggleThreads(bot) {
    if (st.expanded.has(bot.id)) st.expanded.delete(bot.id); else st.expanded.add(bot.id);
    saveOpen();
    renderList();
    if (st.expanded.has(bot.id) && !st.cache.has(bot.id)) await loadThreads(bot.id, { cacheOnly: true, quiet: true });
    for (const c of el.botList.querySelectorAll(".bot-chev")) if (c.dataset.botId === bot.id) c.focus();
  }

  /** Click a bot: select it and put its top thread in the chat (or a fresh thread when it has none). The previous bot's chat never stays. */
  let selectSeq = 0;
  async function selectBot(bot) {
    const seq = ++selectSeq;
    st.selected = bot.id;
    store.set("localStorage", SELECTED_KEY, bot.id);
    renderList(); sync();
    if (app.currentBot() === bot.id) return; // already in this bot's chat (a thread or its draft): stay put
    let list = [];
    try { list = (await json(`/sessions?bot=${encodeURIComponent(bot.id)}`)).sessions || []; st.cache.set(bot.id, list); }
    catch (e) { if (e.message === "unauthorized") return; list = st.cache.get(bot.id) || []; }
    if (seq !== selectSeq) return; // another bot was clicked while this one loaded
    const top = topThread(list);
    if (top) { st.threads = list; st.threadsFor = bot.id; await app.openThread({ ...top, bot: top.bot || bot.id }); }
    else app.newThread(bot.id);
  }

  /** Pin or unpin a bot. Saved on the server, per user, so it follows web, desktop and phone. Optimistic, rolled back on failure. */
  async function setPinned(bot, pinned) {
    const prev = { pinned: bot.pinned, pinnedAt: bot.pinnedAt };
    bot.pinned = pinned; bot.pinnedAt = pinned ? Date.now() : null;
    renderList();
    try {
      const res = await api(`/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: JSON.stringify({ pinned }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const b = await res.json().catch(() => ({}));
      const saved = b && b.bot;
      if (saved) { bot.pinned = !!saved.pinned; bot.pinnedAt = saved.pinnedAt || null; }
    } catch (e) {
      if (e.message === "unauthorized") return;
      bot.pinned = prev.pinned; bot.pinnedAt = prev.pinnedAt;
      notify(`Could not ${pinned ? "pin" : "unpin"} ${bot.name}.`);
    }
    renderList();
  }

  // ---------------------------------------------------------------- active bot: badge, accent, Instructions button
  function sync() {
    const id = activeBotId();
    const shown = botById(app.currentBot()); // the badge and the LED colour follow the thread on screen, not just a list selection
    el.btnInstr.hidden = !id;
    if (id) el.btnInstr.title = botById(id) ? `Instructions for ${botById(id).name}` : "Instructions";
    el.topBadge.hidden = !shown;
    if (shown) paintBadge(el.topBadge, shown);
    const accent = shown ? safeColor(shown.color) : "";
    if (accent) document.body.dataset.botAccent = accent; else delete document.body.dataset.botAccent;
    for (const m of document.querySelectorAll(".bot-dock m-bot, .hero-bot")) { if (accent) m.setAttribute("accent", accent); else m.removeAttribute("accent"); }
    if (st.drawerOpen && st.pinned) { /* opened from a row's gear: it stays on that bot until closed */ }
    else if (st.drawerOpen && !id) closeDrawer();
    else if (st.drawerOpen && id !== st.drawerBot) openDrawer(); // another bot became active while the drawer is open
    markCurrent();
  }
  function markCurrent() {
    const cur = app.currentId();
    for (const b of el.botList.querySelectorAll(".bot-threads .sess")) b.removeAttribute("aria-current");
    if (!cur) return;
    st.threads.forEach((s, i) => {
      if (s.id !== cur) return;
      const nodes = el.botList.querySelectorAll(".bot-threads .sess");
      if (nodes[i]) nodes[i].setAttribute("aria-current", "true");
    });
  }

  // ---------------------------------------------------------------- New bot card
  function openCard() {
    closeDrawer();
    st.lastFocus = document.activeElement;
    el.bnName.value = ""; el.bnPurpose.value = "";
    st.newColor = DEFAULT_COLOR; st.newFace = DEFAULT_FACE; paintNewColors(); paintNewFaces();
    el.bnInstr.value = starterTemplate("", ""); st.cardDirty = false;
    el.bnErr.hidden = true; el.bnErr.replaceChildren();
    el.bnCreate.disabled = false;
    el.card.hidden = false;
    el.bnName.focus();
  }
  function closeCard() {
    el.card.hidden = true;
    if (st.lastFocus && st.lastFocus.focus) st.lastFocus.focus();
  }
  function showCardError(msg) {
    el.bnErr.replaceChildren();
    if (msg.href) {
      const i = msg.text.indexOf(msg.linkText);
      el.bnErr.append(msg.text.slice(0, i));
      const a = document.createElement("a");
      a.textContent = msg.linkText; a.href = msg.href; a.target = "_blank"; a.rel = "noopener noreferrer";
      el.bnErr.append(a, msg.text.slice(i + msg.linkText.length));
    } else el.bnErr.textContent = msg.text;
    el.bnErr.hidden = false;
  }
  const paintNewColors = el.bnColors ? mountSwatches(el.bnColors, () => st.newColor, (c) => { st.newColor = c; paintNewFaces(); }) : () => {};
  const paintNewFaces = el.bnFaces ? mountFaces(el.bnFaces, el.bnFaceDesc, () => st.newFace, (f) => { st.newFace = f; }, () => st.newColor) : () => {};
  paintNewColors(); paintNewFaces();
  function regenTemplate() { if (!st.cardDirty) el.bnInstr.value = starterTemplate(el.bnName.value, el.bnPurpose.value); }
  el.bnName.addEventListener("input", regenTemplate);
  el.bnPurpose.addEventListener("input", regenTemplate);
  el.bnInstr.addEventListener("input", () => { st.cardDirty = true; });
  // Ask Caelum: MIND's agent builder drafts name, purpose and instructions from a plain-words brief. Nothing is saved until Create.
  if (el.bnAsk && el.bnBrief) {
    el.bnAsk.addEventListener("click", async () => {
      const brief = el.bnBrief.value.trim();
      if (brief.length < 8) { el.bnAskState.textContent = "Tell Caelum what the bot should do."; return el.bnBrief.focus(); }
      el.bnAsk.disabled = true; el.bnErr.hidden = true; el.bnAskState.textContent = "Caelum is drafting your bot...";
      try {
        const res = await api("/bots/caelum", { method: "POST", body: JSON.stringify({ brief }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { el.bnAskState.textContent = ""; return showCardError({ text: body.error || "Caelum could not draft that bot." }); }
        if (body.name) el.bnName.value = String(body.name).slice(0, 40);
        if (body.purpose) el.bnPurpose.value = String(body.purpose).slice(0, 140);
        if (body.instructions) el.bnInstr.value = String(body.instructions);
        if (faceOf(body.face)) { st.newFace = body.face; paintNewFaces(); } // Caelum's nearest personality, preselected (still editable)
        el.bnAskState.textContent = "Drafted. Review it, then Create bot.";
        el.bnName.focus();
      } catch (err) {
        el.bnAskState.textContent = "";
        if (err.message !== "unauthorized") showCardError({ text: "Could not reach Caelum. Try again." });
      } finally { el.bnAsk.disabled = false; }
    });
  }
  el.bnCancel.addEventListener("click", closeCard);
  el.card.addEventListener("pointerdown", (e) => { if (e.target === el.card) closeCard(); });
  el.card.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeCard(); return; }
    if (e.key !== "Tab") return;
    const f = [...el.cardForm.querySelectorAll("input, textarea, button, a[href]")].filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  el.cardForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el.bnName.value.trim(), purpose = el.bnPurpose.value.trim(), instructions = el.bnInstr.value;
    if (!name) { showCardError(botErrorMessage(400, { error: "name_required" })); return el.bnName.focus(); }
    if (byteLength(instructions) > MAX_INSTRUCTION_BYTES) return showCardError(botErrorMessage(413, {}));
    el.bnCreate.disabled = true; el.bnErr.hidden = true;
    try {
      const res = await api("/bots", { method: "POST", body: JSON.stringify({ name, purpose, instructions, color: st.newColor, face: st.newFace }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { el.bnCreate.disabled = false; return showCardError(botErrorMessage(res.status, body)); }
      const bot = body.bot || body;
      st.bots = [...st.bots.filter((b) => b.id !== bot.id), bot];
      st.botsLoaded = true; st.botsError = "";
      st.selected = bot.id; st.expanded.add(bot.id); st.threads = []; st.threadsFor = bot.id;
      store.set("localStorage", SELECTED_KEY, bot.id);
      el.card.hidden = true; st.lastFocus = null;
      if (st.view !== "bots") setView("bots", { silent: true });
      renderList();
      app.newThread(bot.id);
    } catch (err) {
      el.bnCreate.disabled = false;
      if (err.message !== "unauthorized") showCardError(botErrorMessage(0, {}));
    }
  });

  // ---------------------------------------------------------------- Instructions drawer
  const bytesNow = () => byteLength(el.text.value);
  function paintEditor() {
    const n = bytesNow(), over = n > MAX_INSTRUCTION_BYTES, dirty = el.text.value !== st.baseline;
    el.count.textContent = countLabel(n);
    el.count.classList.toggle("over", over);
    el.save.disabled = !dirty || over || st.loadingInstr;
    el.revert.disabled = !dirty;
    if (st.loadingInstr) return;
    if (over) el.stateEl.textContent = "Too long to save";
    else if (dirty) el.stateEl.textContent = "Unsaved changes";
    else if (el.stateEl.textContent === "Unsaved changes" || el.stateEl.textContent === "Too long to save") el.stateEl.textContent = "";
    el.stateEl.classList.toggle("warn", over);
    if (dirty || over) delete el.stateEl.dataset.saved;
    if (dirty) st.drafts.set(st.drawerBot, el.text.value); else st.drafts.delete(st.drawerBot);
  }
  el.text.addEventListener("input", paintEditor);

  function paintDetails(bot) {
    el.name.value = bot ? bot.name : "";
    el.purpose.value = bot ? bot.purpose || "" : "";
    st.color = safeColor(bot && bot.color);
    st.face = faceOf(bot && bot.face) ? bot.face : "";
    paintColors(); paintFaces(); paintModel(bot);
    if (el.modelState) el.modelState.textContent = "";
    el.detailsState.textContent = "";
    el.saveDetails.disabled = true;
    paintVersion(bot);
  }
  const paintColors = mountSwatches(el.colors, () => st.color, (c) => { st.color = c; paintFaces(); detailsChanged(); });
  const paintFaces = el.faces ? mountFaces(el.faces, el.faceDesc, () => st.face, (f) => { st.face = f; detailsChanged(); }, () => st.color) : () => {};
  // ---- Model (the bot's LLM override). Saves on change: this bot's threads run on it, whatever the header says.
  let modelRows = [];
  function fillModelSelect(bot) {
    const sel = el.model;
    sel.replaceChildren();
    const none = document.createElement("option"); none.value = ""; none.textContent = "Use default (whatever is chosen)";
    sel.append(none);
    for (const g of groupModels(modelRows)) {
      const og = document.createElement("optgroup"); og.label = g.provider;
      for (const r of g.models) {
        const o = document.createElement("option"); o.value = r.id;
        o.textContent = shortName(r.name, g.provider) + (r.free ? " (free)" : "") + (r.allowed ? "" : ` \u00b7 ${LOCKED_NOTE}`);
        if (!r.allowed) o.disabled = true;
        og.append(o);
      }
      sel.append(og);
    }
    const cur = bot && bot.model ? bot.model : "";
    if (cur && ![...sel.options].some((o) => o.value === cur)) { // a model the list no longer carries: still shown, so it is never silently dropped
      const o = document.createElement("option"); o.value = cur; o.textContent = cur; sel.append(o);
    }
    sel.value = cur;
  }
  function paintModel(bot) {
    if (!el.model) return;
    fillModelSelect(bot);
    const id = bot && bot.id;
    if (typeof app.modelRows === "function") {
      Promise.resolve(app.modelRows()).then((rows) => {
        if (!Array.isArray(rows) || st.drawerBot !== id) return;
        modelRows = rows; fillModelSelect(botById(id));
      }).catch(() => {});
    }
  }
  el.model && el.model.addEventListener("change", async () => {
    const id = st.drawerBot, bot = botById(id);
    if (!bot) return;
    const want = el.model.value;
    if ((bot.model || "") === want) return;
    el.model.disabled = true; el.modelState.textContent = "Saving model…";
    try {
      const res = await api(`/bots/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ model: want || null }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { el.modelState.textContent = botErrorMessage(res.status, body).text; el.model.value = bot.model || ""; el.model.disabled = false; return; }
      Object.assign(bot, body.bot || body, { id });
      el.modelState.textContent = want ? "Model saved. This bot's threads use it from the next message." : "Model cleared. Threads use the normal choice again.";
      el.model.disabled = false;
      renderList(); sync();
      app.botChanged(bot);
    } catch (e) { if (e.message !== "unauthorized") { el.modelState.textContent = "Could not save the model. Try again."; el.model.value = bot.model || ""; } el.model.disabled = false; }
  });

  function detailsChanged() {
    const bot = botById(st.drawerBot);
    if (!bot) return;
    const changed = el.name.value.trim() !== bot.name || el.purpose.value.trim() !== (bot.purpose || "") || st.color !== safeColor(bot.color) || st.face !== (faceOf(bot.face) ? bot.face : "");
    el.saveDetails.disabled = !changed || !el.name.value.trim();
    el.detailsState.textContent = changed ? "Unsaved changes" : "";
  }
  el.name.addEventListener("input", detailsChanged);
  el.purpose.addEventListener("input", detailsChanged);


  /** The row's gear: settings for THAT bot, whichever thread is open. Toggles when it is already showing that bot. */
  function openSettings(id) {
    if (st.drawerOpen && st.drawerBot === id) { closeDrawer(); return; }
    if (!botById(id)) return;
    openDrawer(id);
  }
  async function openDrawer(forId) {
    const id = forId || activeBotId();
    const bot = botById(id);
    if (!id || !bot) return;
    app.closeViolations();
    st.pinned = !!forId && forId !== activeBotId();
    st.drawerBot = id; st.drawerOpen = true;
    el.drawer.hidden = false;
    el.btnInstr.setAttribute("aria-expanded", "true");
    el.drawerTitle.textContent = `${bot.name} settings`;
    paintDetails(bot);
    if (routines) routines.open(id);
    renderList();
    st.loadingInstr = true; delete el.stateEl.dataset.saved;
    el.text.disabled = true; el.text.value = ""; el.stateEl.textContent = "Loading…"; paintEditor();
    let text = "", updatedAt = 0, failed = false;
    try { const r = await json(`/bots/${encodeURIComponent(id)}/instructions`); text = r.text || ""; updatedAt = r.updatedAt || 0; }
    catch (e) { failed = e.message !== "unauthorized"; }
    if (st.drawerBot !== id || !st.drawerOpen) return; // closed or switched while loading
    st.loadingInstr = false; el.text.disabled = failed;
    st.baseline = text;
    el.text.value = st.drafts.has(id) ? st.drafts.get(id) : text;
    el.stateEl.textContent = failed ? "Could not load the instructions." : "";
    el.stateEl.classList.toggle("warn", failed);
    if (!failed && updatedAt && !st.drafts.has(id)) { el.stateEl.textContent = `Saved ${ago(updatedAt)}`; el.stateEl.dataset.saved = "1"; }
    paintEditor();
    if (!failed) el.text.focus();
  }
  function closeDrawer() {
    if (!st.drawerOpen) return;
    st.drawerOpen = false; st.pinned = false;
    if (routines) routines.close();
    el.drawer.hidden = true;
    el.btnInstr.setAttribute("aria-expanded", "false");
    if (!el.btnInstr.hidden) el.btnInstr.focus();
    renderList();
  }
  el.btnInstr.addEventListener("click", () => (st.drawerOpen ? closeDrawer() : openDrawer()));
  el.drawerClose.addEventListener("click", closeDrawer);

  el.save.addEventListener("click", async () => {
    const id = st.drawerBot, text = el.text.value;
    if (bytesNow() > MAX_INSTRUCTION_BYTES) return;
    el.save.disabled = true; el.stateEl.textContent = "Saving…"; el.stateEl.classList.remove("warn");
    try {
      const r = await json(`/bots/${encodeURIComponent(id)}/instructions`, { method: "PUT", body: JSON.stringify({ text }) });
      if (st.drawerBot !== id) return;
      st.baseline = text; st.drafts.delete(id);
      el.stateEl.dataset.saved = "1";
      el.stateEl.textContent = `Saved ${ago((r && r.updatedAt) || Date.now())}`;
      paintEditor();
    } catch (e) {
      if (e.message === "unauthorized") return;
      el.stateEl.textContent = botErrorMessage(/413|too/i.test(e.message) ? 413 : 0, {}).text; el.stateEl.classList.add("warn");
      el.save.disabled = false;
    }
  });
  el.revert.addEventListener("click", () => {
    el.text.value = st.baseline; st.drafts.delete(st.drawerBot);
    delete el.stateEl.dataset.saved; el.stateEl.textContent = ""; paintEditor(); el.text.focus();
  });

  el.saveDetails.addEventListener("click", async () => {
    const id = st.drawerBot, bot = botById(id);
    if (!bot) return;
    const patch = { name: el.name.value.trim(), purpose: el.purpose.value.trim(), color: st.color, face: st.face };
    el.saveDetails.disabled = true; el.detailsState.textContent = "Saving…";
    try {
      const res = await api(`/bots/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { el.detailsState.textContent = botErrorMessage(res.status, body).text; el.saveDetails.disabled = false; return; }
      Object.assign(bot, body.bot || body, { id });
      el.drawerTitle.textContent = `${bot.name} settings`;
      el.detailsState.textContent = "Saved";
      el.saveDetails.disabled = true;
      renderList(); sync();
      app.botChanged(bot);
    } catch (e) { if (e.message !== "unauthorized") { el.detailsState.textContent = "Could not save. Try again."; el.saveDetails.disabled = false; } }
  });

  // delete: a confirm dialog in the page (never window.confirm) that says exactly what goes; the same path serves the list and the drawer
  async function deleteBot(id) {
    const bot = botById(id);
    if (!bot) return;
    const threads = (st.cache.get(id) || (st.threadsFor === id ? st.threads : null) || []).length;
    if (!(await confirmDialog(botDeleteText(bot.name, threads)))) return;
    try {
      const res = await api(`/bots/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) { notify("Could not delete the bot. Try again."); return; }
    } catch (e) { if (e.message !== "unauthorized") notify("Could not delete the bot. Try again."); return; }
    st.bots = st.bots.filter((x) => x.id !== id); st.drafts.delete(id); st.expanded.delete(id); st.cache.delete(id);
    if (st.selected === id) { st.selected = ""; store.set("localStorage", SELECTED_KEY, ""); }
    st.threads = []; st.threadsFor = "";
    closeDrawer();
    app.botDeleted(id);
    renderList(); sync();
  }
  el.del.addEventListener("click", () => deleteBot(st.drawerBot));

  // update: one tap moves the bot to the latest definition. Its instructions, threads and MIND memory are kept.
  async function updateBot(id) {
    const bot = botById(id);
    if (!bot || st.updating.has(id)) return;
    st.updating.add(id); paintVersion(bot);
    try {
      const res = await api(`/bots/${encodeURIComponent(id)}/update`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.bot) throw new Error("update failed");
      Object.assign(bot, body.bot, { id });
      st.updated.set(id, updateText(body.from, bot.latestVersion).done);
    } catch (e) { if (e.message !== "unauthorized") st.updated.set(id, "Could not update. Try again."); }
    st.updating.delete(id);
    renderList(); paintVersion(bot);
  }
  function paintVersion(bot) {
    if (!el.verText || !bot) return;
    const t = updateText(bot.version, bot.latestVersion), busy = st.updating.has(bot.id), msg = st.updated.get(bot.id);
    el.verText.textContent = busy ? "Updating…" : msg ? `${msg}. Instructions, threads and memory kept.` : bot.updateAvailable ? t.available : t.upToDate;
    el.verCurrent.textContent = t.current;
    el.verNotes.replaceChildren(...((bot.updateAvailable && !msg ? bot.updateNotes || [] : []).map((n) => h("li", "", n))));
    el.verBtn.hidden = !bot.updateAvailable || !!msg;
    el.verBtn.disabled = busy;
    el.verBtn.textContent = `Update to v${bot.latestVersion}`;
  }
  el.verBtn && el.verBtn.addEventListener("click", () => updateBot(st.drawerBot));

  // ---------------------------------------------------------------- go
  setView(st.view, { silent: true });
  return {
    view: () => st.view,
    setView,
    refresh,
    sync,
    renderList,
    openCard,
    closeDrawer,
    /** Open Bot settings for a bot (the header's "set by bot" badge uses it). */
    openSettings: (id) => { if (!(st.drawerOpen && st.drawerBot === id)) openSettings(id); },
    drawerOpen: () => st.drawerOpen,
    cardOpen: () => !el.card.hidden,
    threads: () => st.threads,
    /** Every cached per-bot thread list (a rename updates the thread wherever it is held). */
    cached: () => [...st.cache.values()],
    bots: () => st.bots,
    bot: (id) => botById(id),
    selected: () => st.selected,
    /** Search picked a bot: show the Bots view and open its top thread. */
    pickBot: (id) => { const b = botById(id); if (!b) return; if (st.view !== "bots") setView("bots", { silent: true }); selectBot(b); },
    /** Make sure the bot list is known (a bot thread can be open while the Sessions view is showing). */
    ensureLoaded: async () => { if (!st.botsLoaded) await refresh(); },
  };
}
