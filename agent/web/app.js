// MINDClaw web client. A thin client of the gateway: HTTP + SSE. Never touches the provider/tools/kernel.
// All dynamic text goes through textContent / createTextNode. No innerHTML anywhere.

import { initVoice } from "/voice.js";
import { initBots, generalSessions, peerLabel } from "/bots.js";
import { initModels } from "/models.js";

const $ = (id) => document.getElementById(id);
const els = {
  app: $("app"), sidebar: $("sidebar"), scrim: $("scrim"), list: $("session-list"), btnNew: $("btn-new"),
  btnMenu: $("btn-menu"), title: $("title"), subtitle: $("subtitle"), usage: $("usage"),
  usageTokens: $("usage-tokens"), usageCost: $("usage-cost"), btnViol: $("btn-violations"), violCount: $("viol-count"),
  btnTheme: $("btn-theme"), themeIc: $("theme-ic"), scroll: $("scroll"), thread: $("thread"),
  composer: $("composer"), input: $("input"), btnSend: $("btn-send"), btnStop: $("btn-stop"),
  drawer: $("drawer"), drawerClose: $("btn-drawer-close"), drawerNote: $("drawer-note"), violList: $("viol-list"),
  connDot: $("conn-dot"), connText: $("conn-text"), tokenGate: $("token-gate"), tokenForm: $("token-form"),
  tokenInput: $("token-input"), tokenErr: $("token-err"), btnLogout: $("btn-logout"),
};

// ---------- storage (always guarded) ----------
const store = {
  get(area, k) { try { return window[area].getItem(k); } catch { return null; } },
  set(area, k, v) { try { window[area].setItem(k, v); } catch { /* private mode etc */ } },
};

// ---------- token: read ?token= once, keep in sessionStorage, scrub the URL ----------
let token = store.get("sessionStorage", "mc_token") || "";
{
  const u = new URL(location.href);
  const t = u.searchParams.get("token");
  if (t) {
    token = t;
    store.set("sessionStorage", "mc_token", t);
    u.searchParams.delete("token");
    history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
  }
}

// ---------- state ----------
const state = {
  sessions: [],            // server list
  currentId: null,         // gateway session id, null = draft (created on first send)
  transcripts: new Map(),  // id -> { items: [], usage: {in,out,cost}, violCount }
  busy: new Set(),         // ids with a turn in flight
  online: null,
  model: "",               // the LLM powering the agent, from /health
  hosted: false,           // public deployment: cookie login instead of the pasted gateway token
  curBot: "",              // id of the bot whose thread is on screen (or being drafted); "" = a plain session
};
const DRAFT = "__draft__";
const tkey = () => state.currentId ?? DRAFT;
function transcript(id) {
  if (!state.transcripts.has(id)) state.transcripts.set(id, { items: [], usage: { in: 0, out: 0, cost: 0 }, nodes: new Map() });
  return state.transcripts.get(id);
}

// ---------- api ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    credentials: "same-origin",
    headers: { ...(opts.headers || {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.body ? { "content-type": "application/json" } : {}) },
  });
  if (res.status === 401) {
    if (state.hosted) { location.replace("/"); throw new Error("unauthorized"); } // session ended: back to the sign-in screen
    showTokenGate("That token was not accepted."); throw new Error("unauthorized");
  }
  return res;
}
async function json(path, opts) {
  const res = await api(path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

// ---------- markdown-lite (DOM-built; escapes everything by construction) ----------
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>)\]]+)|(\*[^*\n]+\*)/g;

function inline(parent, text) {
  let last = 0;
  INLINE.lastIndex = 0;
  for (let m; (m = INLINE.exec(text)); ) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    if (m[1]) { const c = document.createElement("code"); c.textContent = m[1].slice(1, -1); parent.append(c); }
    else if (m[2]) { const b = document.createElement("strong"); b.textContent = m[2].slice(2, -2); parent.append(b); }
    else if (m[3]) { parent.append(link(m[3].slice(1, m[3].indexOf("](")), m[4])); }
    else if (m[5]) { parent.append(link(m[5], m[5])); }
    else if (m[6]) { const em = document.createElement("em"); em.textContent = m[6].slice(1, -1); parent.append(em); }
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}
function link(label, href) {
  const a = document.createElement("a");
  a.textContent = label; a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer nofollow";
  return a;
}

function codeBlock(lang, body) {
  const wrap = document.createElement("div"); wrap.className = "code";
  const head = document.createElement("div"); head.className = "code-head";
  const l = document.createElement("span"); l.textContent = lang || "code";
  const copy = document.createElement("button"); copy.type = "button"; copy.className = "copy";
  copy.append(icon("i-copy"), document.createTextNode("Copy"));
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(body); copy.lastChild.textContent = "Copied"; setTimeout(() => (copy.lastChild.textContent = "Copy"), 1200); } catch { /* clipboard blocked */ }
  });
  head.append(l, copy);
  const pre = document.createElement("pre"); const code = document.createElement("code"); code.textContent = body; pre.append(code);
  wrap.append(head, pre);
  return wrap;
}

function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let para = [], list = null, i = 0;
  const flushPara = () => { if (para.length) { const p = document.createElement("p"); inline(p, para.join("\n")); frag.append(p); para = []; } };
  const flushList = () => { list = null; };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushPara(); flushList();
      const body = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or EOF while streaming)
      frag.append(codeBlock(fence[1], body.join("\n")));
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); const e = document.createElement(h[1].length <= 2 ? "h3" : "h4"); inline(e, h[2]); frag.append(e); }
    else if (li) {
      flushPara();
      if (!list) { list = document.createElement(/^\s*\d+\./.test(line) ? "ol" : "ul"); frag.append(list); }
      const item = document.createElement("li"); inline(item, li[1]); list.append(item);
    } else if (line.trim() === "") { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
    i++;
  }
  flushPara();
  return frag;
}

// ---------- small DOM helpers ----------
function icon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ic");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function argSummary(args) {
  const parts = [];
  for (const [k, v] of Object.entries(args || {})) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${s.replace(/\s+/g, " ").slice(0, 70)}`);
    if (parts.join(" ").length > 90) break;
  }
  return parts.join("  ");
}
const pretty = (v) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const fmtCost = (n) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// ---------- thread rendering ----------
let stick = true;
els.scroll.addEventListener("scroll", () => {
  stick = els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < 80;
});
function toBottom(force) { if (force || stick) els.scroll.scrollTop = els.scroll.scrollHeight; }

function renderEmpty() {
  const box = h("div", "empty");
  box.append(h("h2", "", "What should we work on?"));
  box.append(h("p", "", "Every claim here is checked by the kernel. Gate interventions and confirmations show up inline."));
  els.thread.append(box);
}

function buildItem(it, tr) {
  let node;
  switch (it.kind) {
    case "user": node = h("div", "msg-user", it.text); break;
    case "assistant": node = h("div", "msg-asst"); updateAssistant(node, it); break;
    case "tool": node = buildTool(it); break;
    case "gate": node = buildGate(it); break;
    case "confirm": node = buildConfirm(it); break;
    default: // a billing notice carries an upgrade link; anything else stays plain text
      node = h("div", `notice ${it.level === "warn" ? "warn" : ""}`, /https?:\/\//.test(it.text) ? undefined : it.text);
      if (/https?:\/\//.test(it.text)) inline(node, it.text);
  }
  it.node = node;
  return node;
}
function updateAssistant(node, it) {
  node.replaceChildren(renderMarkdown(it.text));
  node.classList.toggle("streaming", !!it.streaming);
}
function buildTool(it) {
  const d = document.createElement("details"); d.className = `tool ${it.status}`;
  const s = document.createElement("summary");
  const chev = icon("i-chev"); chev.classList.add("chev");
  const state = h("span", "tool-state");
  s.append(chev, h("span", "tool-name", it.tool), h("span", "tool-args", argSummary(it.args)), state);
  const body = h("div", "tool-body");
  const a = h("div"); a.append(h("h4", "", "Arguments"), h("pre", "", pretty(it.args)));
  body.append(a);
  const r = h("div"); r.hidden = true; r.append(h("h4", "", "Result"), h("pre", "", ""));
  body.append(r);
  d.append(s, body);
  it.parts = { state, result: r };
  refreshTool(it);
  return d;
}
function refreshTool(it) {
  const { state, result } = it.parts;
  it.node && (it.node.className = `tool ${it.status}`);
  state.replaceChildren();
  if (it.status === "ok") state.append(icon("i-check"), document.createTextNode("ok"));
  else if (it.status === "fail") state.append(icon("i-x"), document.createTextNode("failed"));
  else state.append(document.createTextNode("running"));
  if (it.preview !== undefined) { result.hidden = false; result.querySelector("pre").textContent = it.preview || "(empty)"; }
}
function buildGate(it) {
  const v = it.verdict;
  const g = h("div", `gate ${it.enforced ? "enforced" : "shadow"}`);
  g.append(h("span", "gate-label", "Gate"), h("span", "gate-name", v.gate), h("span", "gate-mode", `${v.action} · ${it.enforced ? "enforced" : "shadow"}`), h("span", "gate-reason", v.reason));
  return g;
}
function buildConfirm(it) {
  const c = h("div", "confirm");
  if (it.done) c.classList.add("done"); // replayed from history: the moment to answer has passed
  c.append(h("h3", "", "Confirmation needed"), h("p", "why", it.reason));
  const act = h("div", "act"); act.append(h("div", "act-tool", it.tool), h("pre", "", pretty(it.args)));
  c.append(act);
  c.append(h("p", "hint-line", "Nothing runs until you reply. Reply “send it” to approve, or say what to change."));
  const row = h("div", "reply");
  const input = document.createElement("input");
  input.value = "send it"; input.setAttribute("aria-label", "Your reply"); input.spellcheck = false;
  const send = h("button", "btn-primary", "Send reply"); send.type = "button";
  const dismiss = h("button", "btn-quiet", "Dismiss"); dismiss.type = "button";
  const go = () => { const t = input.value.trim(); if (!t) return; c.classList.add("done"); sendMessage(t); };
  send.addEventListener("click", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
  dismiss.addEventListener("click", () => c.classList.add("done"));
  row.append(input, send, dismiss);
  c.append(row);
  return c;
}

function renderThread() {
  els.thread.replaceChildren();
  const tr = transcript(tkey());
  if (!tr.items.length) renderEmpty();
  for (const it of tr.items) els.thread.append(buildItem(it, tr));
  renderHeader();
  toBottom(true);
}

// Swap one transcript item for another in place (a retracted draft becomes a "rewriting" note).
function replaceItem(sessionId, oldIt, newIt) {
  const tr = transcript(sessionId);
  const i = tr.items.indexOf(oldIt);
  if (i < 0) return addItem(sessionId, newIt);
  tr.items[i] = newIt;
  if (sessionId === tkey() && oldIt.node) {
    const node = buildItem(newIt, tr);
    oldIt.node.replaceWith(node);
  }
  return newIt;
}

// Rebuild transcript items from the server's saved history (same shapes the live stream produces).
function itemsFromHistory(events) {
  const items = [], byReceipt = new Map(), usage = { in: 0, out: 0, cost: 0 };
  let asst = null, model = "";
  for (const ev of events) {
    switch (ev.type) {
      case "user": asst = null; items.push({ kind: "user", text: ev.text }); break;
      case "text":
        if (!asst) { asst = { kind: "assistant", text: "", streaming: false }; items.push(asst); }
        asst.text += ev.delta; break;
      case "retract": {
        const note = { kind: "notice", level: "info", text: `rewriting: ${ev.reason}` };
        if (asst) items[items.indexOf(asst)] = note; else items.push(note);
        asst = null; break;
      }
      case "toolStart": {
        asst = null;
        const it = { kind: "tool", receiptId: ev.receiptId, tool: ev.tool, args: ev.args, status: "run" };
        byReceipt.set(ev.receiptId, it); items.push(it); break;
      }
      case "toolEnd": { const it = byReceipt.get(ev.receiptId); if (it) { it.status = ev.ok ? "ok" : "fail"; it.preview = ev.preview; } break; }
      case "gate": asst = null; items.push({ kind: "gate", verdict: ev.verdict, enforced: ev.enforced }); break;
      case "confirm": asst = null; items.push({ kind: "confirm", id: ev.id, tool: ev.tool, args: ev.args, reason: ev.reason, done: true }); break;
      case "notice": items.push({ kind: "notice", level: ev.level, text: ev.text }); break;
      case "usage": usage.in += ev.usage.promptTokens; usage.out += ev.usage.completionTokens; usage.cost = ev.totalCostUsd; if (ev.model) model = ev.model; break;
      default: break;
    }
  }
  for (const it of items) if (it.kind === "tool" && it.status === "run") it.status = "fail";
  return { items, usage, model };
}

// Fill an empty transcript from the server (resume after a restart, or a live session this browser has not seen).
async function loadHistory(id) {
  const tr = transcript(id);
  if (tr.items.length) return;
  try {
    const { events } = await json(`/sessions/${encodeURIComponent(id)}/history`);
    if (!events || !events.length || tr.items.length) return;
    const r = itemsFromHistory(events);
    tr.items.push(...r.items);
    tr.usage = r.usage;
    if (r.model) tr.model = r.model;
  } catch { /* no saved history: the session starts empty */ }
}

function addItem(sessionId, it) {
  const tr = transcript(sessionId);
  tr.items.push(it);
  if (sessionId === tkey()) {
    if (tr.items.length === 1) els.thread.replaceChildren();
    els.thread.append(buildItem(it, tr));
    toBottom();
  }
  return it;
}

// ---------- header / sessions ----------
function metaById(id) { return state.sessions.find((s) => s.id === id) || bots.threads().find((s) => s.id === id); }
function currentMeta() { return metaById(state.currentId); }
function renderHeader() {
  const meta = currentMeta();
  const bot = state.curBot ? bots.bot(state.curBot) : null;
  els.title.textContent = meta ? meta.title || "Untitled" : bot ? "New thread" : "New session";
  els.subtitle.textContent = meta
    ? [bot && bot.name, meta.peer && peerLabel(meta.peer, bots.bots()), `${meta.surface}${meta.live ? " · live" : ""}`].filter(Boolean).join(" · ")
    : bot ? `${bot.name} · Not started` : "Not started";
  const u = transcript(tkey()).usage;
  els.usage.hidden = !(u.in || u.out || u.cost);
  els.usageTokens.textContent = `${fmtTok(u.in)} in / ${fmtTok(u.out)} out`;
  els.usageCost.textContent = fmtCost(u.cost);
  const tm = transcript(tkey()).model || state.model; els.usage.title = tm ? `Model: ${tm}` : "";
  models.setServed(transcript(tkey()).model || "");
  bots.sync();
  setBusyUi();
}
function setBusyUi() {
  const busy = state.busy.has(tkey());
  els.btnSend.hidden = busy; els.btnStop.hidden = !busy;
}
function renderSessions() {
  els.list.replaceChildren();
  const shown = generalSessions(state.sessions); // bot threads live under their bot, in the Bots view
  if (!shown.length) { els.list.append(h("div", "empty-side", "No sessions yet.")); return; }
  for (const s of shown) {
    const b = h("button", "sess"); b.type = "button";
    if (s.id === state.currentId) b.setAttribute("aria-current", "true");
    const m = h("span", "sess-m");
    m.append(h("span", "", s.surface), h("span", "", "·"), h("span", "", ago(s.updatedAt)));
    if (s.live) { m.append(h("span", "", "·"), h("span", "live", s.busy ? "working" : "live")); }
    b.append(h("span", "sess-t", s.title || "Untitled"), m);
    b.addEventListener("click", () => selectSession(s));
    els.list.append(b);
  }
}
// View-aware: the Sessions view lists plain sessions; the Bots view also refreshes the bots and the selected bot's threads.
// A bot thread can be open while the Sessions view shows, so its bot is kept fresh too.
async function refreshSessions() {
  try { state.sessions = (await json("/sessions")).sessions; } catch { /* shown via connection state */ }
  if (bots.view() === "bots" || state.curBot) await bots.refresh();
  renderSessions(); renderHeader();
}

async function selectSession(s) {
  closeSidebar();
  if (!s.live) {
    try {
      const { sessionId } = await json("/sessions", { method: "POST", body: JSON.stringify({ surface: "web", title: s.title, resumeId: s.id, ...(s.bot ? { bot: s.bot } : {}) }) });
      if (sessionId !== s.id) { transcript(sessionId); }
      state.currentId = sessionId;
      state.curBot = s.bot || "";
      await loadHistory(sessionId);
    } catch (e) { return notify(`Could not resume: ${e.message}`); }
  } else {
    state.currentId = s.id;
    state.curBot = s.bot || "";
    await loadHistory(s.id);
  }
  await refreshSessions();
  renderThread();
  if (!els.drawer.hidden) loadViolations();
}
function newSession() {
  closeSidebar();
  state.currentId = null;
  state.curBot = "";
  state.transcripts.delete(DRAFT);
  renderSessions(); renderThread();
  els.input.focus();
}
// A new thread with one of the user's bots: a draft until the first message, like a new session.
function newBotThread(botId) {
  closeSidebar();
  state.currentId = null;
  state.curBot = botId;
  state.transcripts.delete(DRAFT);
  renderSessions(); renderThread();
  bots.renderList();
  els.input.focus();
}
function notify(text) { addItem(tkey(), { kind: "notice", level: "warn", text }); }

// ---------- sending ----------
let opening = null; // one in-flight session open, shared by the boot prewarm and the first send
async function ensureSession() {
  if (state.currentId) return state.currentId;
  if (!opening) {
    opening = (async () => {
      const body = { surface: "web", title: "New session" };
      if (state.curBot) body.bot = state.curBot;
      const dm = models.defaultForNew();
      let sessionId;
      try { ({ sessionId } = await json("/sessions", { method: "POST", body: JSON.stringify(dm ? { ...body, model: dm } : body) })); }
      catch (e) { if (!dm || e.message === "unauthorized") throw e; ({ sessionId } = await json("/sessions", { method: "POST", body: JSON.stringify(body) })); } // a remembered model the plan no longer allows: start on the default
      // migrate draft transcript
      const draft = state.transcripts.get(DRAFT);
      if (draft && !state.transcripts.has(sessionId)) { state.transcripts.set(sessionId, draft); state.transcripts.delete(DRAFT); }
      state.currentId = sessionId;
      return sessionId;
    })().finally(() => { opening = null; });
  }
  return opening;
}

async function sendMessage(text) {
  text = text.trim();
  if (!text) return;
  // Show the message immediately; opening a session can take several seconds while MIND boots.
  const startKey = tkey();
  const userItem = addItem(startKey, { kind: "user", text });
  voice.turnStart();
  const waiting = addItem(startKey, { kind: "notice", level: "info", text: "Thinking…" });
  state.busy.add(startKey); setBusyUi(); stick = true; toBottom(true);
  const dropWaiting = () => {
    const t = transcript(tkey());
    const i = t.items.indexOf(waiting);
    if (i >= 0) t.items.splice(i, 1);
    if (waiting.node) waiting.node.remove();
  };
  let id;
  try { id = await ensureSession(); } catch (e) {
    state.busy.delete(startKey); setBusyUi(); dropWaiting();
    els.input.value = text; grow();
    return notify(`Could not start a session: ${e.message}`);
  }
  if (startKey !== id) { state.busy.delete(startKey); state.busy.add(id); }
  refreshSessions();
  const tr = transcript(id);
  const meta = metaById(id);
  if (meta && (!meta.title || meta.title === "New session")) meta.title = text.slice(0, 60);
  let asst = null;
  let first = true;
  const toolByReceipt = new Map();
  try {
    const res = await api(`/sessions/${encodeURIComponent(id)}/send`, { method: "POST", body: JSON.stringify({ text }) });
    if (res.status === 409) throw new Error("This session is busy with another turn.");
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    setOnline(true);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        if (first && ev.type !== "usage") { first = false; dropWaiting(); }
        asst = onEvent(id, ev, asst, toolByReceipt);
      }
    }
  } catch (e) {
    if (e.message !== "unauthorized") { notify(e.message === "Failed to fetch" ? "Lost connection to the gateway." : e.message); if (e.message === "Failed to fetch") setOnline(false); }
  } finally {
    dropWaiting();
    if (asst) { asst.streaming = false; if (asst.node) updateAssistant(asst.node, asst); }
    state.busy.delete(id); setBusyUi();
    saveTranscript(id);
    refreshSessions();
    if (!els.drawer.hidden) loadViolations(); else refreshViolCount();
    if (id === state.currentId || id === tkey()) voice.turnDone(answerText(transcript(id), userItem));
    else voice.turnDone("");
  }
}

// The assistant text of one turn: every assistant block after that turn's user message.
function answerText(tr, userItem) {
  const i = tr.items.indexOf(userItem);
  return tr.items.slice(i < 0 ? 0 : i + 1).filter((x) => x.kind === "assistant").map((x) => x.text).join("\n\n");
}

// Keep the visible conversation across reloads (this browser tab only).
function saveTranscript(id) {
  try {
    const items = transcript(id).items.filter((it) => it.kind !== "notice" || it.level === "warn").map(({ node, parts, ...rest }) => rest);
    sessionStorage.setItem(`daebot:t:${id}`, JSON.stringify(items.slice(-200)));
    sessionStorage.setItem("daebot:current", id);
    sessionStorage.setItem("daebot:bot", state.curBot || "");
  } catch { /* storage unavailable: transcript stays in memory */ }
}
function restoreTranscript(id) {
  try {
    const raw = sessionStorage.getItem(`daebot:t:${id}`);
    if (!raw) return false;
    const tr = transcript(id);
    if (tr.items.length) return true;
    for (const it of JSON.parse(raw)) tr.items.push(it);
    return true;
  } catch { return false; }
}

const pendingPaint = new Set();
function paintAssistant(it) {
  if (pendingPaint.has(it)) return;
  pendingPaint.add(it);
  requestAnimationFrame(() => { pendingPaint.delete(it); if (it.node) { updateAssistant(it.node, it); toBottom(); } });
}

function onEvent(id, ev, asst, toolByReceipt) {
  const tr = transcript(id);
  switch (ev.type) {
    case "text":
      if (!asst) asst = addItem(id, { kind: "assistant", text: "", streaming: true });
      asst.text += ev.delta; paintAssistant(asst);
      return asst;
    case "retract": {
      // A gate withheld the draft that just streamed: swap it for a small note; the rewrite streams in a new block.
      const note = { kind: "notice", level: "info", text: `rewriting: ${ev.reason}` };
      if (asst) replaceItem(id, asst, note); else addItem(id, note);
      return null;
    }
    case "toolStart": {
      if (asst) { asst.streaming = false; paintAssistant(asst); }
      const it = addItem(id, { kind: "tool", receiptId: ev.receiptId, tool: ev.tool, args: ev.args, status: "run" });
      toolByReceipt.set(ev.receiptId, it);
      return null; // text after a tool starts a new block
    }
    case "toolEnd": {
      const it = toolByReceipt.get(ev.receiptId);
      if (it) { it.status = ev.ok ? "ok" : "fail"; it.preview = ev.preview; if (it.parts) refreshTool(it); }
      return asst;
    }
    case "gate":
      if (asst) { asst.streaming = false; paintAssistant(asst); }
      addItem(id, { kind: "gate", verdict: ev.verdict, enforced: ev.enforced });
      return null;
    case "confirm":
      if (asst) { asst.streaming = false; paintAssistant(asst); }
      addItem(id, { kind: "confirm", id: ev.id, tool: ev.tool, args: ev.args, reason: ev.reason });
      return null;
    case "notice":
      addItem(id, { kind: "notice", level: ev.level, text: ev.text });
      return asst;
    case "usage":
      tr.usage.in += ev.usage.promptTokens; tr.usage.out += ev.usage.completionTokens; tr.usage.cost = ev.totalCostUsd;
      if (ev.model) tr.model = ev.model;
      models.answered(id, id === state.currentId ? ev.model : "");
      if (id === tkey()) renderHeader();
      return asst;
    case "done":
      if (asst) { asst.streaming = false; paintAssistant(asst); }
      refreshPlan();
      return null;
    default: return asst;
  }
}

async function abortTurn() {
  const id = state.currentId;
  if (!id || !state.busy.has(id)) return;
  try { await api(`/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" }); } catch { /* the stream will report */ }
}

// ---------- violations drawer ----------
async function loadViolations() {
  const id = state.currentId;
  els.violList.replaceChildren();
  if (!id) { els.drawerNote.textContent = "Start a session to see kernel activity."; return; }
  try {
    const { violations } = await json(`/sessions/${encodeURIComponent(id)}/violations`);
    setViolCount(violations.length);
    els.drawerNote.textContent = violations.length
      ? `${violations.length} gate event${violations.length === 1 ? "" : "s"} in this session.`
      : "No violations. The kernel has had nothing to correct.";
    for (const v of violations.slice().reverse()) {
      const li = h("li", "viol");
      const top = h("div", "viol-top");
      top.append(h("span", "g", v.gate), h("span", "a", v.action), h("span", `m ${v.enforced ? "" : "shadow"}`, v.enforced ? "Enforced" : "Shadow"));
      const t = document.createElement("time"); t.textContent = new Date(v.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      li.append(top, h("p", "", v.reason), t);
      els.violList.append(li);
    }
  } catch (e) { els.drawerNote.textContent = `Could not load violations: ${e.message}`; }
}
async function refreshViolCount() {
  if (!state.currentId) return setViolCount(0);
  try { setViolCount((await json(`/sessions/${encodeURIComponent(state.currentId)}/violations`)).violations.length); } catch { /* ignore */ }
}
function setViolCount(n) { els.violCount.hidden = n === 0; els.violCount.textContent = String(n); }
function toggleDrawer(open) {
  els.drawer.hidden = !open;
  els.btnViol.setAttribute("aria-expanded", String(open));
  if (open) { bots.closeDrawer(); loadViolations(); }
}

// ---------- theme ----------
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = effectiveDark();
  els.themeIc.firstElementChild.setAttribute("href", dark ? "#i-sun" : "#i-moon");
}
const effectiveDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};
const toggleTheme = () => {
  const next = effectiveDark() ? "light" : "dark";
  store.set("localStorage", "mc_theme", next); applyTheme(next);
};
els.btnTheme.addEventListener("click", toggleTheme);
$("btn-theme-side").addEventListener("click", toggleTheme); // phones: the top bar has no room for it
applyTheme(store.get("localStorage", "mc_theme"));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(store.get("localStorage", "mc_theme")));

// ---------- connection ----------
function renderConn() {
  // The model badge in the header is filled by brand.js from /health; this line stays plain.
  els.connText.textContent = state.online ? "Connected" : "Gateway offline";
}
function setOnline(on) {
  if (state.online === on) return;
  state.online = on;
  els.connDot.className = `dot ${on ? "on" : "off"}`;
  renderConn();
}
// DAEBOT_BOTS_ENABLED: when the gateway says bots are off, the Sessions|Bots toggle is hidden and the sidebar stays on Sessions.
function applyBotsFlag(on) {
  const seg = document.getElementById("seg");
  if (seg) { seg.hidden = !on; seg.style.display = on ? "" : "none"; }
  if (!on && typeof bots !== "undefined" && bots.view() === "bots") bots.setView("sessions", { silent: true });
}
async function ping() {
  try {
    const r = await fetch("/health", { cache: "no-store" });
    setOnline(r.ok);
    if (r.ok) { const h = await r.json().catch(() => ({})); state.hosted = h.hosted === true; applyBotsFlag(h.bots === true); els.btnLogout.hidden = !state.hosted; if (h.model !== state.model) { state.model = h.model || ""; renderConn(); models.setHealth(typeof state.model === "string" ? state.model : state.model.id || state.model.name || ""); } if (state.hosted && !state.who) showWho(); }
  } catch { setOnline(false); }
}

// DAEBOT_BILLING=mind: a usage meter ("Plan usage · 62% left", small plan name, Manage plan link). Usage language only, never the billing unit.
function showPlan(me) {
  const box = document.getElementById("plan");
  if (!box) return;
  if (!me || !me.tierName) { box.hidden = true; return; }
  const pct = typeof me.usageLeftPct === "number" && isFinite(me.usageLeftPct) ? Math.max(0, Math.min(100, me.usageLeftPct)) : null;
  const bar = document.getElementById("plan-bar");
  document.getElementById("plan-text").textContent = pct === null ? "Usage billed as you go" : `Plan usage · ${pct}% left`;
  document.getElementById("plan-name").textContent = me.tierName;
  bar.hidden = pct === null;
  bar.classList.toggle("low", pct !== null && pct <= 20 && pct > 5);
  bar.classList.toggle("empty", pct !== null && pct <= 5);
  if (pct !== null) { bar.setAttribute("aria-valuenow", String(pct)); document.getElementById("plan-fill").style.width = `${pct}%`; }
  box.title = pct === null ? `${me.tierName} plan, usage billed as you go` : `${me.tierName} plan, ${pct}% of this period's usage left`;
  const a = document.getElementById("plan-link");
  let href = "";
  try { const u = new URL(me.upgradeUrl || ""); if (u.protocol === "https:" || u.protocol === "http:") href = u.href; } catch { /* no link */ }
  a.hidden = !href; if (href) a.href = href;
  box.hidden = false;
}

// Re-read the plan after a turn: the gateway already holds the X-MIND-Credits-Remaining value from that turn's calls, else it re-fetches.
async function refreshPlan() {
  if (!state.hosted || document.getElementById("plan").hidden) return; // only when a plan is shown (mind billing)
  try { const r = await fetch("/auth/me?fresh=1", { credentials: "same-origin" }); if (r.ok) showPlan(await r.json()); } catch { /* keep what is shown */ }
}

// Hosted: show which MIND account this session is acting as (its own MIND, or the owner's).
async function showWho() {
  try {
    const r = await fetch("/auth/me", { credentials: "same-origin" });
    if (!r.ok) return r.status === 401 ? false : true; // 401 = not signed in; anything else is a hiccup, not a sign-out
    const me = await r.json();
    state.who = me.username;
    showPlan(me);
    const el = document.getElementById("who");
    if (el) { el.textContent = me.owner ? "Signed in as Owner" : `Signed in as ${me.username}`; el.title = me.owner ? "Owner access code" : `MIND account ${me.username}`; el.hidden = false; }
    return true;
  } catch { return true; /* network blip: not a sign-out */ }
}

function showTokenGate(msg) {
  els.tokenGate.hidden = false;
  els.tokenErr.hidden = !msg; els.tokenErr.textContent = msg || "";
  els.tokenInput.focus();
}
els.tokenForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  token = els.tokenInput.value.trim();
  store.set("sessionStorage", "mc_token", token);
  els.tokenInput.value = "";
  try { const r = await fetch("/sessions", { headers: { authorization: `Bearer ${token}` } }); if (r.status === 401) return showTokenGate("That token was not accepted."); } catch { return showTokenGate("Could not reach the gateway."); }
  els.tokenGate.hidden = true; boot();
});

// ---------- chrome ----------
function openSidebar() { els.sidebar.classList.add("open"); els.scrim.hidden = false; }
function closeSidebar() { els.sidebar.classList.remove("open"); els.scrim.hidden = true; }
els.btnMenu.addEventListener("click", openSidebar);
els.scrim.addEventListener("click", closeSidebar);
els.btnNew.addEventListener("click", () => (bots.view() === "bots" ? bots.openCard() : newSession()));
els.btnViol.addEventListener("click", () => toggleDrawer(els.drawer.hidden));
els.drawerClose.addEventListener("click", () => toggleDrawer(false));
els.btnStop.addEventListener("click", abortTurn);

function grow() { els.input.style.height = "auto"; els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`; }
els.input.addEventListener("input", grow);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.composer.requestSubmit(); }
});
els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const t = els.input.value;
  if (!t.trim() || state.busy.has(tkey())) return;
  els.input.value = ""; grow();
  sendMessage(t);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.busy.has(tkey())) { e.preventDefault(); abortTurn(); }
  else if (!els.drawer.hidden) toggleDrawer(false);
  else if (bots.drawerOpen()) bots.closeDrawer();
  else closeSidebar();
});

// ---------- voice (MIND Voice: mic, spoken answers, hands-free; billed to the user's MIND credits) ----------
const voice = initVoice({
  els: { mic: $("btn-mic"), speak: $("btn-speak"), convo: $("btn-convo"), dock: $("voice-dock"), status: $("voice-status"), stop: $("voice-stop"),
         bars: [...document.querySelectorAll("#voice-dock .vbars i")], composer: els.composer, input: els.input },
  authHeaders: () => (token ? { authorization: `Bearer ${token}` } : {}),
  onUnauthorized: () => { if (state.hosted) location.replace("/"); else showTokenGate("That token was not accepted."); },
  isBusy: () => state.busy.has(tkey()),
  notify: (t) => notify(t),
  creditsChanged: () => refreshPlan(),
  bots: () => [...document.querySelectorAll(".hero-bot, .bot-dock m-bot")],
});

// ---------- bots + model picker ----------
const models = initModels({
  json, store, notify, icon,
  getSessionId: () => state.currentId,
  onPicked: () => renderHeader(),
});
const bots = initBots({
  json, api, store, h, icon, ago, notify,
  app: {
    currentBot: () => state.curBot,
    currentId: () => state.currentId,
    refresh: () => refreshSessions(),
    newThread: (id) => newBotThread(id),
    openThread: (s) => selectSession(s),
    closeViolations: () => { if (!els.drawer.hidden) toggleDrawer(false); },
    botChanged: () => renderHeader(),
    botDeleted: (id) => { if (state.curBot === id) newSession(); refreshSessions(); },
  },
});

// ---------- boot ----------
async function boot() {
  renderThread();
  await ping();
  if (!token && !state.hosted) return showTokenGate();
  // Prewarming a session boots MIND, so it only ever runs for a signed-in user (hosted: the session cookie must be valid).
  if (state.hosted && !(await showWho())) return location.replace("/");
  await refreshSessions();
  let last = null;
  try { last = sessionStorage.getItem("daebot:current"); } catch { /* none */ }
  let known = last && state.sessions.find((s) => s.id === last); // live, or saved on the server (survives restarts)
  let lastBot = ""; try { lastBot = sessionStorage.getItem("daebot:bot") || ""; } catch { /* none */ }
  if (!known && last && lastBot) { // a bot thread may not be in the plain list
    try { known = ((await json(`/sessions?bot=${encodeURIComponent(lastBot)}`)).sessions || []).find((s) => s.id === last); if (known && !known.bot) known = { ...known, bot: lastBot }; } catch { /* no such bot */ }
  }
  if (known && known.live && restoreTranscript(last)) { state.currentId = last; state.curBot = known.bot || ""; await bots.ensureLoaded(); renderSessions(); renderThread(); }
  else if (known) { await selectSession(known); } // resumes and replays the saved transcript
  else if (!state.currentId) { ensureSession().then(() => { renderSessions(); renderHeader(); }).catch(() => { /* first send retries */ }); }
}
boot();
setInterval(ping, 10000);
setInterval(() => { if ((token || state.hosted) && state.online) refreshSessions(); }, 30000);
els.btnLogout.addEventListener("click", async () => {
  try { await fetch("/logout", { method: "POST", credentials: "same-origin" }); } catch { /* leaving anyway */ }
  location.replace("/");
});
