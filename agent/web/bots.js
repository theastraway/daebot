// Bots for Daebot (web): the Sessions | Bots switch in the sidebar, the bot list with each bot's threads, the New bot card,
// and the Instructions drawer (DAEBOT.md editor, rename, purpose, LED colour, delete).
//
// A bot is a Daebot with its own job, its own instructions and its own threads. Its identity is a colour for the mascot's lit LEDs
// plus the bot's initial in a small badge; the mascot itself is never redrawn (it is the <m-bot> component, tinted by `accent`).
//
// DOM is built with createElement + textContent only; there is no innerHTML. All requests are same-origin, through the app's
// api()/json() helpers. The pure helpers are exported (and unit tested); everything that touches `document` lives in initBots().

export const VIEW_KEY = "mc_view";
export const SELECTED_KEY = "mc_bot";
export const MAX_INSTRUCTION_BYTES = 8 * 1024;
export const NAME_MAX = 40;
export const PURPOSE_MAX = 140;
export const DEFAULT_COLOR = "#ffd25a";
/** The six preset LED colours a bot can wear. */
export const COLORS = [
  { hex: "#ffd25a", name: "Amber" },
  { hex: "#ff9a3d", name: "Orange" },
  { hex: "#7dff9a", name: "Green" },
  { hex: "#5ee0ff", name: "Cyan" },
  { hex: "#a98bff", name: "Violet" },
  { hex: "#ff7ad9", name: "Pink" },
];

// ---------------------------------------------------------------- pure helpers

/** A colour we are willing to put on screen: #rrggbb only, else the default amber. */
export function safeColor(c) {
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim().toLowerCase() : DEFAULT_COLOR;
}

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
  return (Array.isArray(list) ? list : []).filter((s) => !s.bot);
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
    del: $("bd-delete"), delConfirm: $("bd-confirm"), delText: $("bd-confirm-text"), delYes: $("bd-delete-yes"), delNo: $("bd-delete-no"),
    card: $("bot-new"), cardForm: $("bot-new-form"), bnName: $("bn-name"), bnPurpose: $("bn-purpose"), bnInstr: $("bn-instr"),
    bnErr: $("bn-err"), bnCreate: $("bn-create"), bnCancel: $("bn-cancel"),
  };
  if (!el.tabBots || !el.botList) return null;

  const st = {
    view: store.get("localStorage", VIEW_KEY) === "bots" ? "bots" : "sessions",
    bots: [], botsLoaded: false, botsError: "",
    selected: store.get("localStorage", SELECTED_KEY) || "",
    expanded: new Set(),
    threads: [], threadsFor: "",
    drawerBot: "", baseline: "", drafts: new Map(), loadingInstr: false, drawerOpen: false,
    color: DEFAULT_COLOR, cardDirty: false, lastFocus: null,
  };
  if (st.selected) st.expanded.add(st.selected);

  const botById = (id) => st.bots.find((b) => b.id === id);
  /** The bot the user is working with: the open thread's bot, else the one picked in the list. */
  function activeBotId() { return app.currentBot() || (st.view === "bots" ? st.selected : "") || ""; }
  const activeBot = () => botById(activeBotId());

  function paintBadge(node, bot) {
    node.textContent = initialOf(bot && bot.name);
    node.style.setProperty("--bot", safeColor(bot && bot.color));
  }
  function badge(bot, cls = "") {
    const b = h("span", `bot-badge ${cls}`.trim());
    b.setAttribute("aria-hidden", "true");
    paintBadge(b, bot);
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
    const want = st.view === "bots" ? st.selected : app.currentBot();
    if (want && botById(want)) await loadThreads(want, { quiet: true });
    renderList(); sync();
  }

  async function loadThreads(id, { quiet } = {}) {
    try {
      st.threads = (await json(`/sessions?bot=${encodeURIComponent(id)}`)).sessions || [];
      st.threadsFor = id;
    } catch { if (st.threadsFor !== id) { st.threads = []; st.threadsFor = id; } }
    if (!quiet) renderList();
  }

  // ---------------------------------------------------------------- list
  function renderList() {
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
    for (const bot of st.bots) box.append(botRow(bot));
  }

  function botRow(bot) {
    const row = h("div", "bot-row");
    const open = st.expanded.has(bot.id);
    const item = h("button", "bot-item"); item.type = "button";
    item.setAttribute("aria-expanded", String(open));
    if (activeBotId() === bot.id) item.setAttribute("aria-current", "true");
    const text = h("span", "bot-text");
    text.append(h("span", "bot-name", bot.name), h("span", "bot-purpose", bot.purpose || "No purpose yet"));
    const ds = dotState(bot);
    const dot = h("span", `bot-dot ${ds}`);
    dot.setAttribute("role", "img"); dot.setAttribute("aria-label", DOT_LABEL[ds]); dot.title = DOT_LABEL[ds];
    item.append(badge(bot), text, dot);
    item.addEventListener("click", () => selectBot(bot));
    row.append(item);
    if (open) {
      const sub = h("div", "bot-threads");
      const nt = h("button", "bot-newthread"); nt.type = "button";
      nt.append(icon("i-plus"), h("span", "", `New thread with ${bot.name}`));
      nt.addEventListener("click", () => app.newThread(bot.id));
      sub.append(nt);
      const mine = st.threadsFor === bot.id ? st.threads : [];
      if (!mine.length) sub.append(h("div", "empty-side", st.threadsFor === bot.id ? "No threads yet." : "Loading threads…"));
      for (const s of mine) {
        const b = h("button", "sess"); b.type = "button";
        if (s.id === app.currentId()) b.setAttribute("aria-current", "true");
        const m = h("span", "sess-m");
        const bits = [];
        if (s.peer) bits.push(peerLabel(s.peer, st.bots));
        bits.push(s.surface || "web", ago(s.updatedAt));
        bits.forEach((t, i) => { if (i) m.append(h("span", "", "·")); m.append(h("span", s.peer && i === 0 ? "peer" : "", t)); });
        if (s.live) { m.append(h("span", "", "·"), h("span", "live", s.busy ? "working" : "live")); }
        b.append(h("span", "sess-t", s.title || "Untitled"), m);
        b.addEventListener("click", () => app.openThread({ ...s, bot: s.bot || bot.id }));
        sub.append(b);
      }
      row.append(sub);
    }
    return row;
  }

  async function selectBot(bot) {
    const wasOpen = st.expanded.has(bot.id) && st.selected === bot.id;
    st.selected = bot.id;
    store.set("localStorage", SELECTED_KEY, bot.id);
    if (wasOpen) st.expanded.delete(bot.id); else st.expanded.add(bot.id);
    renderList(); sync();
    if (!wasOpen) await loadThreads(bot.id);
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
    if (st.drawerOpen && !id) closeDrawer();
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
  function regenTemplate() { if (!st.cardDirty) el.bnInstr.value = starterTemplate(el.bnName.value, el.bnPurpose.value); }
  el.bnName.addEventListener("input", regenTemplate);
  el.bnPurpose.addEventListener("input", regenTemplate);
  el.bnInstr.addEventListener("input", () => { st.cardDirty = true; });
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
      const res = await api("/bots", { method: "POST", body: JSON.stringify({ name, purpose, instructions }) });
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
    paintColors();
    el.detailsState.textContent = "";
    el.saveDetails.disabled = true;
    resetDelete();
  }
  function paintColors() {
    el.colors.replaceChildren();
    for (const c of COLORS) {
      const b = h("button", "swatch"); b.type = "button";
      b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(c.hex === st.color)); b.setAttribute("aria-label", c.name); b.title = c.name;
      b.tabIndex = c.hex === st.color ? 0 : -1;
      b.style.setProperty("--sw", c.hex);
      b.addEventListener("click", () => { st.color = c.hex; paintColors(); detailsChanged(); b.focus(); });
      el.colors.append(b);
    }
  }
  el.colors.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const i = COLORS.findIndex((c) => c.hex === st.color);
    const d = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    st.color = COLORS[(i + d + COLORS.length) % COLORS.length].hex;
    paintColors(); detailsChanged();
    el.colors.querySelector('[aria-checked="true"]').focus();
  });
  function detailsChanged() {
    const bot = botById(st.drawerBot);
    if (!bot) return;
    const changed = el.name.value.trim() !== bot.name || el.purpose.value.trim() !== (bot.purpose || "") || st.color !== safeColor(bot.color);
    el.saveDetails.disabled = !changed || !el.name.value.trim();
    el.detailsState.textContent = changed ? "Unsaved changes" : "";
  }
  el.name.addEventListener("input", detailsChanged);
  el.purpose.addEventListener("input", detailsChanged);

  function resetDelete() { el.delConfirm.hidden = true; el.del.hidden = false; }

  async function openDrawer() {
    const id = activeBotId();
    const bot = botById(id);
    if (!id || !bot) return;
    app.closeViolations();
    st.drawerBot = id; st.drawerOpen = true;
    el.drawer.hidden = false;
    el.btnInstr.setAttribute("aria-expanded", "true");
    el.drawerTitle.textContent = `${bot.name} instructions`;
    paintDetails(bot);
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
    st.drawerOpen = false;
    el.drawer.hidden = true;
    el.btnInstr.setAttribute("aria-expanded", "false");
    resetDelete();
    if (!el.btnInstr.hidden) el.btnInstr.focus();
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
    const patch = { name: el.name.value.trim(), purpose: el.purpose.value.trim(), color: st.color };
    el.saveDetails.disabled = true; el.detailsState.textContent = "Saving…";
    try {
      const res = await api(`/bots/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { el.detailsState.textContent = botErrorMessage(res.status, body).text; el.saveDetails.disabled = false; return; }
      Object.assign(bot, body.bot || body, { id });
      el.drawerTitle.textContent = `${bot.name} instructions`;
      el.detailsState.textContent = "Saved";
      el.saveDetails.disabled = true;
      renderList(); sync();
      app.botChanged(bot);
    } catch (e) { if (e.message !== "unauthorized") { el.detailsState.textContent = "Could not save. Try again."; el.saveDetails.disabled = false; } }
  });

  // two-step delete, in the page (never window.confirm)
  el.del.addEventListener("click", () => {
    const bot = botById(st.drawerBot);
    el.delText.textContent = `Delete ${bot ? bot.name : "this bot"}? Its instructions and threads go with it. This cannot be undone.`;
    el.del.hidden = true; el.delConfirm.hidden = false; el.delNo.focus();
  });
  el.delNo.addEventListener("click", () => { resetDelete(); el.del.focus(); });
  el.delYes.addEventListener("click", async () => {
    const id = st.drawerBot;
    el.delYes.disabled = true;
    try {
      const res = await api(`/bots/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) { el.delText.textContent = "Could not delete the bot. Try again."; el.delYes.disabled = false; return; }
      el.delYes.disabled = false;
      st.bots = st.bots.filter((b) => b.id !== id); st.drafts.delete(id); st.expanded.delete(id);
      if (st.selected === id) { st.selected = ""; store.set("localStorage", SELECTED_KEY, ""); }
      st.threads = []; st.threadsFor = "";
      closeDrawer();
      app.botDeleted(id);
      renderList(); sync();
    } catch (e) { el.delYes.disabled = false; if (e.message !== "unauthorized") el.delText.textContent = "Could not delete the bot. Try again."; }
  });

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
    drawerOpen: () => st.drawerOpen,
    cardOpen: () => !el.card.hidden,
    threads: () => st.threads,
    bots: () => st.bots,
    bot: (id) => botById(id),
    selected: () => st.selected,
    /** Make sure the bot list is known (a bot thread can be open while the Sessions view is showing). */
    ensureLoaded: async () => { if (!st.botsLoaded) await refresh(); },
  };
}
