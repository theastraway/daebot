// MINDClaw web client. A thin client of the gateway: HTTP + SSE. Never touches the provider/tools/kernel.
// All dynamic text goes through textContent / createTextNode. No innerHTML anywhere.

import { initVoice } from "/voice.js";
import { initScreen } from "/screen.js";
import { initHotkeys } from "/hotkeys.js";
import { initUpdates } from "/updates.js";
import { initBots, generalSessions, peerLabel } from "/bots.js";
import { initScrollbars } from "/scrollbars.js";
import { initModels } from "/models.js";
import { initApps } from "/apps.js";
import { initMcp } from "/mcp.js";
import { initConnectors } from "/connectors.js";
import { openConnectorDetail } from "/connector-detail.js";
import { transcriptBehind } from "/sync.js";
import { lruPut, raceAbort, windowPlan, scrollMemory } from "/switchcache.js";
import { confirmDialog, deleteControl, renameControl, editInline, isRenaming, sessionDeleteText } from "/manage.js";
import { compareBuild, webUpdateText, WEB_CHECK_MS } from "/webupdate.js";
import { buildPermissionCard, initChatMode, initPermissions } from "/permissions.js";
import { initAccount } from "/account.js";
import { initMainBot } from "/mainbot.js";
import { initUsage } from "/usage.js";
import { initBoard } from "/board.js";
import { initExchanges } from "/exchanges.js";
import { initSuggest } from "/suggest.js";
import { initGift } from "/gift.js";
import { initSearch } from "/search.js";
import { initPhotos, normQueue, packQueue, queueLabel, SAYS as PHOTO_SAYS } from "/photos.js";
import { calendarCapabilities, createDeviceCalls } from "/device-calendar.js";
import { initMessageMenu, copyText } from "/msgmenu.js";
initScrollbars(); // scrollbars stay hidden until the user scrolls

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
  attachStrip: $("attach-strip"), attachNote: $("attach-note"), dropOverlay: $("drop-overlay"), photoInput: $("photo-input"), btnAttach: $("btn-attach"),
};

// ---------- storage (always guarded) ----------
const store = {
  get(area, k) { try { return window[area].getItem(k); } catch { return null; } },
  set(area, k, v) { try { window[area].setItem(k, v); } catch { /* private mode etc */ } },
};

// ---------- token: read ?token= once, keep in sessionStorage, scrub the URL ----------
let account; // the sidebar bar + account menu (account.js), assigned below once the helpers it needs exist
let chatMode; // the per-chat permission control above the composer
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
// Apple Calendar on the user's own device (the iPhone and Mac apps): the agent's device_call events are answered here, natively, and POSTed back.
const deviceCalls = createDeviceCalls({ post: (sid, body) => api(`/sessions/${encodeURIComponent(sid)}/device-result`, { method: "POST", body: JSON.stringify(body) }) });

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

// ---------- photos (drag and drop, paste, attach button) ----------
const photos = initPhotos({
  els: { strip: els.attachStrip, note: els.attachNote, overlay: els.dropOverlay, picker: els.photoInput, btn: els.btnAttach, input: els.input },
  h, icon, api,
});

// ---------- thread rendering ----------
let stick = true;
els.scroll.addEventListener("scroll", () => {
  stick = els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < 80;
});
function toBottom(force) { if (force || stick) els.scroll.scrollTop = els.scroll.scrollHeight; }
// The on-screen keyboard rose or fell (shell.js): a reader who was at the bottom stays at the bottom.
window.addEventListener("daebot:viewport", () => toBottom());

function renderEmpty() {
  const box = h("div", "empty");
  box.append(h("h2", "", "What should we work on?"));
  box.append(h("p", "", "Every claim here is checked by the kernel. Gate interventions and confirmations show up inline."));
  els.thread.append(box);
}

function buildItem(it, tr) {
  let node;
  switch (it.kind) {
    case "user":
      node = h("div", (it.photos?.length ? "msg-user has-photos" : "msg-user") + (it.quote ? " has-quote" : ""), it.text || undefined);
      if (it.photos?.length) node.prepend(photos.thumbs(it.photos, tkey()));
      if (it.quote?.text) node.prepend(h("div", "mx-quote", oneLine(it.quote.text, 200)));
      break;
    case "assistant": node = h("div", "msg-asst"); node.tabIndex = 0; node.setAttribute("aria-haspopup", "menu"); updateAssistant(node, it); break;
    case "tool": node = buildTool(it); break;
    case "gate": node = buildGate(it); break;
    case "confirm": node = buildConfirm(it); break;
    case "permission": node = buildPermissionCard(it, { json, h, notify, onChange: () => toBottom() }); break;
    case "mcp": node = mcp.buildCard(it.pending, () => { it.done = true; }); if (it.done) node.classList.add("done"); break;
    case "exchange": case "xin": node = xchg ? xchg.buildCard(it) : h("div", "notice", "Agent exchange"); break; // bot_talk cards: "Messaged <agent>" and "<agent> messaged you"
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
  // Emoji reactions sit under the message; tapping one toggles your own.
  if (it.reactions?.length && !it.streaming) {
    const row = h("div", "mx-reacts");
    for (const e of it.reactions) {
      const b = h("button", "mx-react", e); b.type = "button"; b.setAttribute("aria-label", `Remove reaction ${e}`);
      b.addEventListener("click", () => msgReact(it, e));
      row.append(b);
    }
    node.append(row);
  }
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
// A permission card in the thread. state: pending (waiting on a click) | resolved | gone (a saved transcript, nothing waits).
function permissionItem(ev) {
  return { kind: "permission", id: ev.id, tool: ev.tool, cls: ev.cls, title: ev.title, detail: ev.detail || [], args: ev.args || {},
    allowOptions: ev.allowOptions || [], denyOptions: ev.denyOptions || [], suggest: ev.suggest, expiresAt: ev.expiresAt, state: "pending" };
}
function resolvePermission(it, ev) {
  it.state = "resolved"; it.outcome = ev.outcome; it.remembered = ev.remembered;
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

// A chat shows its newest FIRST_PAINT items at once (what fits on screen), the rest of a WINDOW_ITEMS window is filled in
// above them while the browser is idle, and anything older loads when you scroll up. A 300-message chat costs the same
// to open as a 10-message one. Items whose DOM node already exists (the chat was open before) are re-attached, not rebuilt.
const FIRST_PAINT_ITEMS = 6, WINDOW_ITEMS = 40, OLDER_STEP = 40, SLICE_MS = 8;
const REUSE_KINDS = new Set(["user", "tool", "gate", "notice"]);
let renderGen = 0, olderIO = null;
const whenIdle = (f) => (window.requestIdleCallback ? window.requestIdleCallback(f, { timeout: 250 }) : setTimeout(f, 16));
// The thread is a polite live region: while history is being built into it, screen readers must not read it all out.
let busyT = 0;
function threadBusy() { els.thread.setAttribute("aria-busy", "true"); clearTimeout(busyT); busyT = setTimeout(() => els.thread.removeAttribute("aria-busy"), 400); }
function nodeFor(it, tr, old) {
  const reuse = it.node && (REUSE_KINDS.has(it.kind) || (it.kind === "assistant" && !it.streaming));
  const n = reuse ? it.node : buildItem(it, tr);
  if (old) n.classList.add("cv"); else n.classList.remove("cv"); // offscreen history skips layout and paint until scrolled near
  return n;
}
/** Insert nodes above everything shown and keep the reader looking at the same message. */
function prependKeep(frag) {
  const sc = els.scroll, before = sc.scrollHeight, top = sc.scrollTop;
  const older = els.thread.querySelector(":scope > .older");
  els.thread.insertBefore(frag, older ? older.nextSibling : els.thread.firstChild);
  sc.scrollTop = top + (sc.scrollHeight - before);
}
function placeOlder(tr) {
  if (olderIO) { olderIO.disconnect(); olderIO = null; }
  els.thread.querySelector(":scope > .older")?.remove();
  if (!(tr.from > 0)) return;
  const b = h("button", "older", `Show earlier messages (${tr.from})`); b.type = "button";
  b.addEventListener("click", () => loadOlder(tr));
  els.thread.prepend(b);
  if (window.IntersectionObserver) {
    olderIO = new IntersectionObserver((en) => { if (en.some((x) => x.isIntersecting)) loadOlder(tr); }, { root: els.scroll, rootMargin: "500px 0px 0px 0px" });
    olderIO.observe(b);
  }
}
function loadOlder(tr) {
  if (transcript(tkey()) !== tr || !(tr.from > 0)) return;
  threadBusy();
  const from = Math.max(0, tr.from - OLDER_STEP), frag = document.createDocumentFragment();
  for (let i = from; i < tr.from; i++) frag.append(nodeFor(tr.items[i], tr, true));
  tr.from = from;
  prependKeep(frag);
  placeOlder(tr);
}
function renderThread() {
  const gen = ++renderGen;
  threadBusy();
  const tr = transcript(tkey()), items = tr.items, total = items.length;
  if (olderIO) { olderIO.disconnect(); olderIO = null; }
  els.thread.replaceChildren();
  if (!total) {
    if (!tr.pending) renderEmpty(); // a chat still loading shows nothing (no "What should we work on?" flash)
    renderHeader(); paintReplyChip(); toBottom(true);
    return;
  }
  const mem = tr.scrollMem; tr.scrollMem = undefined;
  const { away, tailFrom, fillTo } = windowPlan({ total, mem, first: FIRST_PAINT_ITEMS, win: WINDOW_ITEMS }); // away: came back to a chat that was scrolled up
  const frag = document.createDocumentFragment();
  for (let i = tailFrom; i < total; i++) frag.append(nodeFor(items[i], tr, false)); // coming back to a scrolled-up chat builds it whole (no estimated heights) so the reader lands exactly where they were
  els.thread.append(frag);
  tr.from = tailFrom;
  renderHeader(); paintReplyChip();
  if (away) { stick = false; els.scroll.scrollTop = els.scroll.scrollHeight - els.scroll.clientHeight - mem.fromBottom; }
  else toBottom(true);
  // Short items at the end of a chat may not fill the screen: add earlier ones now, or the idle fill would push what is on screen down.
  while (!away && tr.from > 0 && els.scroll.scrollHeight < els.scroll.clientHeight * 1.3) {
    const f = document.createDocumentFragment(), from = Math.max(0, tr.from - 4);
    for (let i = from; i < tr.from; i++) f.append(nodeFor(items[i], tr, false));
    tr.from = from;
    els.thread.insertBefore(f, els.thread.firstChild);
  }
  if (!away && tr.from > fillTo) {
    // The rest of the window is built a few items at a time, each slice capped at SLICE_MS, so typing and scrolling never wait on it.
    const slice = () => {
      if (gen !== renderGen || transcript(tkey()) !== tr) return; // another chat was opened meanwhile
      const f = document.createDocumentFragment(), t0 = performance.now();
      let from = tr.from;
      while (from > fillTo && (from === tr.from || performance.now() - t0 < SLICE_MS)) { from--; f.prepend(nodeFor(items[from], tr, true)); }
      tr.from = from;
      threadBusy();
      prependKeep(f);
      if (tr.from > fillTo) whenIdle(slice); else placeOlder(tr);
    };
    whenIdle(slice);
  } else placeOlder(tr);
}
/** Remember where the reader was in the chat being left. */
function rememberScroll() {
  const tr = state.transcripts.get(tkey());
  if (!tr || !tr.items.length) return;
  const sc = els.scroll;
  tr.scrollMem = scrollMemory({ scrollHeight: sc.scrollHeight, scrollTop: sc.scrollTop, clientHeight: sc.clientHeight, total: tr.items.length, from: tr.from });
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
  const items = [], byReceipt = new Map(), usage = { in: 0, out: 0, cost: 0 }, permById = new Map();
  let asst = null, model = "";
  for (const ev of events) {
    switch (ev.type) {
      case "user": asst = null; items.push({ kind: "user", text: ev.text, ...(ev.id ? { mid: ev.id } : {}), ...(ev.rid ? { rid: ev.rid } : {}), ...(ev.quote ? { quote: ev.quote } : {}), ...(ev.photos?.length ? { photos: ev.photos } : {}) }); break;
      case "text":
        if (!asst) { asst = { kind: "assistant", text: "", streaming: false, ...(ev.id ? { mid: ev.id } : {}), ...(ev.rid ? { rid: ev.rid } : {}) }; items.push(asst); }
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
      case "permission": { asst = null; const it = permissionItem(ev); items.push(it); permById.set(ev.id, it); break; }
      case "permissionResolved": { const it = permById.get(ev.id); if (it) resolvePermission(it, ev); break; }
      case "notice": items.push({ kind: "notice", level: ev.level, text: ev.text }); break;
      case "exchange": asst = null; items.push({ kind: "exchange", exchangeId: ev.exchangeId, from: ev.from, to: ev.to, message: ev.message, reply: ev.reply, at: ev.at }); break;
      case "usage": usage.in += ev.usage.promptTokens; usage.out += ev.usage.completionTokens; usage.cost = ev.totalCostUsd; if (ev.model) model = ev.model; break;
      default: break;
    }
  }
  for (const it of items) if (it.kind === "tool" && it.status === "run") it.status = "fail";
  for (const it of items) if (it.kind === "permission" && it.state === "pending") it.state = "gone"; // a finished transcript has no card still waiting
  return { items, usage, model };
}

// ---------- history: one cached, conditional read per chat ----------
// The last transcript the server sent for each chat (newest HIST_MAX kept). A chat that is already here paints at once on
// open and is only re-checked in the background; GET history carries an ETag, so an unchanged chat costs a 304.
const HIST_MAX = 12;
const hist = new Map();       // id -> { events, meta, run, etag }
const histFlight = new Map(); // id -> Promise: one request per chat at a time, shared by hover prefetch, a switch and the sync tick
function histPut(id, e) { lruPut(hist, id, e, HIST_MAX); }
function getHistory(id, { signal } = {}) {
  let p = histFlight.get(id);
  if (!p) {
    const prev = hist.get(id);
    p = (async () => {
      const res = await api(`/sessions/${encodeURIComponent(id)}/history`, prev?.etag ? { headers: { "if-none-match": prev.etag } } : {});
      if (res.status === 304 && prev) return prev;
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const body = await res.json();
      const e = { events: body.events, meta: body.meta, run: body.run, etag: res.headers.get("etag") || "" };
      histPut(id, e);
      return e;
    })().finally(() => histFlight.delete(id));
    histFlight.set(id, p);
  }
  return raceAbort(p, signal);
}
/** Warm the cache for a chat the user is about to open (hover, focus, press, neighbours of the open one). */
function prefetchHistory(id) {
  if (!id || id === state.currentId || hist.has(id) || histFlight.has(id)) return;
  void getHistory(id).catch(() => { /* a failed prefetch only means the click fetches it */ });
}
function fillTranscript(tr, e) {
  const r = itemsFromHistory(e.events);
  tr.items.length = 0; tr.items.push(...r.items);
  applyMeta(tr, e.meta);
  tr.usage = r.usage; if (r.model) tr.model = r.model;
}
// Bring a chat's transcript up to what the server holds. Returns true when the visible thread was rebuilt.
// Fills an empty transcript (first open, resume after a restart), picks up turns that happened elsewhere, and attaches to a
// reply still being written.
function reconcile(id, e) {
  const tr = transcript(id);
  if (!e || !Array.isArray(e.events) || state.busy.has(id)) return false;
  tr.pending = false;
  if (e.run && e.run.status === "running") { tr.appliedEtag = undefined; void attachRun(id, e.events); return true; } // a reply is still being written on the server
  if (tr.appliedEtag && tr.appliedEtag === e.etag && tr.items.length) return false; // nothing changed since the last look
  const empty = !tr.items.length;
  applyMeta(tr, e.meta); // reactions made on another device (or before a reload) show up even when no new message did
  const localUsers = tr.items.filter((x) => x.kind === "user").length;
  const { behind, dones } = transcriptBehind({ events: e.events, localUsers, lastDones: tr.syncDones });
  tr.syncDones = dones;
  tr.appliedEtag = e.etag || undefined;
  if (!empty && !behind) return false;
  if (empty && !e.events.length) { if (id === tkey()) renderThread(); return false; }
  const top = els.scroll.scrollTop, pinned = stick;
  fillTranscript(tr, e);
  if (id === tkey()) {
    renderThread();
    if (!empty && !pinned) els.scroll.scrollTop = top;
  }
  saveTranscriptSoon(id);
  return true;
}

// Pull in turns that happened outside this tab (a MINDbots reply run through /api/agent/turn, another device).
// Only the open conversation, only while it is idle here and the tab is visible; the server history is the truth.
let syncing = false;
async function syncCurrent() {
  const id = state.currentId;
  if (!id || syncing || document.hidden || state.busy.has(id) || !state.online) return;
  syncing = true;
  try {
    const e = await getHistory(id);
    if (id !== state.currentId || state.busy.has(id)) return;
    reconcile(id, e);
  } catch { /* offline or no saved history yet: try again on the next tick */ }
  finally { syncing = false; }
}
setInterval(syncCurrent, 4000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) syncCurrent(); });

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

// ---------- message menu: react, reply, mark unread, copy, select, request id, report ----------
const enc = encodeURIComponent;
// The server's per-message extras (reactions, feedback) and unread marker, kept on the transcript and painted onto the messages.
function applyMeta(tr, meta) {
  if (!meta) return;
  tr.meta = meta;
  for (const it of tr.items) {
    if (it.kind !== "assistant" || !it.mid) continue;
    const next = meta.messages?.[it.mid]?.reactions || [];
    if (JSON.stringify(next) === JSON.stringify(it.reactions || [])) continue;
    it.reactions = next;
    if (it.node && !it.streaming) updateAssistant(it.node, it);
  }
}
// Messages streamed in this tab have no server id yet. Read the saved thread and match the two lists from the end (same kind, same words).
async function resolveIds(id) {
  const tr = transcript(id);
  if (!tr.items.some((x) => (x.kind === "assistant" || x.kind === "user") && !x.mid)) return true;
  try {
    const { events, meta, run } = await json(`/sessions/${enc(id)}/history`);
    if (run && run.status === "running") return false; // the saved thread stops before the turn still being written
    const srv = itemsFromHistory(events || []).items.filter((x) => x.kind === "assistant" || x.kind === "user");
    const loc = tr.items.filter((x) => x.kind === "assistant" || x.kind === "user");
    const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
    for (let i = 1; i <= Math.min(srv.length, loc.length); i++) {
      const a = srv[srv.length - i], b = loc[loc.length - i];
      if (a.kind !== b.kind || norm(a.text) !== norm(b.text)) break;
      if (!b.mid) { b.mid = a.mid; if (a.rid) b.rid = a.rid; }
    }
    applyMeta(tr, meta);
    saveTranscript(id);
    return true;
  } catch { return false; }
}
const itemOfNode = (node) => (node ? transcript(tkey()).items.find((x) => x.node === node) : undefined);
const replies = new Map(); // chat id -> the message being replied to { mid, text }
const chipEl = $("reply-chip"), chipText = $("reply-chip-text");
function paintReplyChip() {
  const q = replies.get(tkey());
  chipEl.hidden = !q;
  chipText.textContent = q ? q.text : "";
}
$("reply-chip-x").addEventListener("click", () => { replies.delete(tkey()); paintReplyChip(); els.input.focus(); });
const plain = (md) => String(md || "").replace(/```[a-z]*\n?/gi, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*`#]+/g, "");
const oneLine = (t, n) => { const x = plain(t).replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1) + "…" : x; };

async function msgReact(it, emoji) {
  const id = state.currentId;
  if (!id || !it.mid) return;
  try {
    const r = await json(`/sessions/${enc(id)}/messages/${enc(it.mid)}/react`, { method: "POST", body: JSON.stringify({ emoji }) });
    it.reactions = r.reactions || [];
    const tr = transcript(id);
    if (tr.meta) { const m = (tr.meta.messages ||= {}); if (it.reactions.length || r.feedback) m[it.mid] = { reactions: it.reactions, ...(r.feedback ? { feedback: r.feedback } : {}) }; else delete m[it.mid]; }
    if (it.node) updateAssistant(it.node, it);
    saveTranscript(id);
    if (r.feedback && (emoji === "👍" || emoji === "👎")) menu.toast("Thanks, Daebot will learn from this");
  } catch (e) { if (e.message !== "unauthorized") menu.toast(`Could not react: ${e.message}`); }
}
function setUnreadLocal(id, unread) {
  for (const list of [state.sessions, bots.threads(), ...bots.cached()]) for (const r of list) if (r.id === id) { if (unread) r.unread = true; else delete r.unread; }
  renderSessions(); bots.renderList();
}
async function msgUnread(it) {
  const id = state.currentId;
  if (!id || !it.mid) return;
  try {
    await json(`/sessions/${enc(id)}`, { method: "PATCH", body: JSON.stringify({ unreadFrom: it.mid }) });
    setUnreadLocal(id, true);
    menu.toast("Marked as unread");
  } catch (e) { if (e.message !== "unauthorized") menu.toast(`Could not mark unread: ${e.message}`); }
}
async function clearUnread(s) {
  if (!s.unread) return;
  setUnreadLocal(s.id, false);
  try { await api(`/sessions/${enc(s.id)}`, { method: "PATCH", body: JSON.stringify({ unreadFrom: null }) }); } catch { /* the next list refresh shows the truth */ }
}
async function openMessageMenu(node, point) {
  const id = state.currentId;
  const it = itemOfNode(node);
  if (!id || !it || it.kind !== "assistant" || it.streaming || state.busy.has(id) && !it.mid) return menu.toast("Daebot is still replying");
  if (!it.mid && !(await resolveIds(id))) return menu.toast("Could not open the menu, try again in a moment");
  if (!it.mid) return menu.toast("Could not open the menu for this message");
  menu.open({
    node, point, reactions: it.reactions || [],
    act: {
      react: (e) => msgReact(it, e),
      reply: () => { replies.set(id, { mid: it.mid, text: oneLine(it.text, 160), full: it.text }); paintReplyChip(); els.input.focus(); },
      unread: () => msgUnread(it),
      copy: async () => menu.toast((await copyText(it.text)) ? "Copied" : "Could not copy"),
      select: () => { if (menu.phone() || matchMedia("(pointer: coarse)").matches) menu.selectSheet(it.text); else menu.selectDesktop(node); },
      copyId: async () => menu.toast(it.rid ? ((await copyText(it.rid)) ? "Request ID copied" : "Could not copy") : "No request ID for this message"),
      report: async (reason, comment) => {
        try {
          await json(`/sessions/${enc(id)}/messages/${enc(it.mid)}/report`, { method: "POST", body: JSON.stringify({ reason, ...(comment ? { comment } : {}) }) });
          it.reactions = [...new Set([...(it.reactions || []).filter((x) => x !== "👍"), "👎"])];
          if (it.node) updateAssistant(it.node, it);
          menu.toast("Thanks, reported");
          return true;
        } catch (e) { if (e.message !== "unauthorized") menu.toast(`Could not send the report: ${e.message}`); return false; }
      },
    },
  });
}
const menu = initMessageMenu({ h, icon, host: els.thread, pick: (n) => (n && itemOfNode(n) ? n : null), onRequest: (node, point) => { void openMessageMenu(node, point); } });

// ---------- header / sessions ----------
// The row of a chat: the plain list, the selected bot's threads, any bot's cached thread list, or the row that was just clicked
// (a thread opened from a bot list that is not the selected one is in none of the lists until they refresh).
function metaById(id) {
  return state.sessions.find((s) => s.id === id) || bots.threads().find((s) => s.id === id)
    || bots.cached().reduce((hit, list) => hit || list.find((s) => s.id === id), undefined)
    || (state.openedRow && state.openedRow.id === id ? state.openedRow : undefined);
}
function currentMeta() { return metaById(state.currentId); }
function renderHeader() {
  const meta = currentMeta();
  const bot = state.curBot ? bots.bot(state.curBot) : null;
  if (isRenaming()) return;
  els.title.textContent = meta ? meta.title || "Untitled" : bot ? "New thread" : "New session";
  els.title.classList.toggle("renamable", !!meta);
  els.title.title = meta ? "Click to rename" : "";
  els.subtitle.textContent = meta
    ? [bot && bot.name, meta.peer && peerLabel(meta.peer, bots.bots()), `${meta.surface}${meta.live ? " · live" : ""}`].filter(Boolean).join(" · ")
    : bot ? `${bot.name} · Not started` : "Not started";
  const u = transcript(tkey()).usage;
  els.usage.hidden = !(u.in || u.out || u.cost);
  els.usageTokens.textContent = `${fmtTok(u.in)} in / ${fmtTok(u.out)} out`;
  els.usageCost.textContent = fmtCost(u.cost);
  const tm = transcript(tkey()).model || state.model; els.usage.title = tm ? `Model: ${tm}` : "";
  models.setServed(transcript(tkey()).model || "");
  models.setPinned(bot && bot.model ? bot.model : ""); // a bot thread whose bot has its own model: the badge shows it, locked
  bots.sync();
  setBusyUi();
  chatMode?.render();
}
// Messages sent while Dae is working wait here (per chat) and go out in order, one per turn, when Dae finishes (drainQueue).
// Each one also has Send now (stops the running turn first), Copy, and remove. Kept in sessionStorage so a reload does not drop them.
var QKEY = "daebot.queue";
// A queued message is { text, photos: [{ name, dataUrl, width, height }], lost }. Photos stay in memory; a reload restores them only
// while they fit the sessionStorage budget (packQueue), and says how many it could not keep.
var queue = (() => { try { return normQueue(JSON.parse(sessionStorage.getItem(QKEY) || "{}")); } catch { return {}; } })();
function saveQueue() {
  try {
    const { json, dropped } = packQueue(queue);
    sessionStorage.setItem(QKEY, json);
    if (dropped) photos.say(`Queued photos are too big to keep across a reload; ${dropped} will be lost if you reload now.`);
  } catch { /* private mode */ }
}
function queueFor(key) { if (!queue) queue = {}; return queue[key]; }
function enqueue(key, text, attached = [], quote) { (queue[key] ||= []).push({ text: text.trim(), photos: attached, lost: 0, ...(quote ? { quote } : {}) }); saveQueue(); renderQueue(); }
// Send one queued message now. If Dae is still working, stop that turn first, then send it the moment the turn ends.
var queueSendWanted = null;
async function sendQueued(i) {
  const key = tkey(), q = queueFor(key);
  if (!q || !q[i]) return;
  const item = q.splice(i, 1)[0];
  if (!q.length) delete queue[key];
  saveQueue(); renderQueue();
  if (!state.busy.has(key)) return sendMessage(item.text, item.photos, item.quote);
  queueSendWanted = { key, item };
  await abortTurn();
  const t0 = Date.now();
  const wait = () => {
    if (!queueSendWanted || queueSendWanted.key !== key) return;
    if (!state.busy.has(key)) { const w = queueSendWanted; queueSendWanted = null; sendMessage(w.item.text, w.item.photos, w.item.quote); return; }
    if (Date.now() - t0 > 15000) { enqueue(key, queueSendWanted.item.text, queueSendWanted.item.photos, queueSendWanted.item.quote); queueSendWanted = null; notify("Dae did not stop in time; the message is back in the queue."); return; }
    setTimeout(wait, 150);
  };
  wait();
}
// The turn in this chat ended: send the next queued message. Runs after the turn's own cleanup, never while a Send now is pending.
function drainQueue(key) {
  setTimeout(() => {
    if (key !== tkey() || state.busy.has(key) || queueSendWanted) return;
    const q = queueFor(key);
    if (!q || !q.length) return;
    const item = q.shift();
    if (!q.length) delete queue[key];
    saveQueue(); renderQueue();
    sendMessage(item.text, item.photos, item.quote);
  }, 0);
}
function renderQueue() {
  let box = document.getElementById("queue");
  const q = queueFor(tkey()) || [];
  if (!box) { box = document.createElement("div"); box.id = "queue"; box.className = "queue"; (els.attachNote || els.composer).before(box); }
  box.replaceChildren();
  box.hidden = !q.length;
  q.forEach((it, i) => {
    const t = it.text;
    const row = h("div", "queue-item");
    row.append(h("span", "queue-tag", `Queued ${i + 1}`));
    if (it.photos.length) row.append(photos.mini(it.photos));
    const label = queueLabel(it) + (it.lost ? ` (${it.lost} photo${it.lost === 1 ? "" : "s"} not kept after the reload)` : "");
    const lbl = h("span", "queue-text", label); lbl.title = t; row.append(lbl); // full text on hover; the row stays one line
    const send = h("button", "btn-quiet queue-btn", "Send now"); send.type = "button";
    send.title = state.busy.has(tkey()) ? "Stop what Dae is doing and send this now" : "Send this message";
    send.onclick = () => { sendQueued(i); };
    const copy = h("button", "btn-quiet queue-btn", "Copy"); copy.type = "button"; copy.title = "Copy this message"; copy.hidden = !t.trim();
    copy.onclick = async () => { try { await navigator.clipboard.writeText(t); copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1200); } catch { els.input.value = t; grow(); els.input.focus(); } };
    const x = h("button", "btn-quiet queue-x", "×"); x.type = "button"; x.title = "Remove from queue"; x.setAttribute("aria-label", "Remove queued message");
    x.onclick = () => { q.splice(i, 1); if (!q.length) delete queue[tkey()]; saveQueue(); renderQueue(); };
    row.append(send, copy, x); box.append(row);
  });
}
function setBusyUi() {
  const busy = state.busy.has(tkey());
  els.btnSend.hidden = false; els.btnStop.hidden = !busy; // Send stays: while busy it queues
  els.btnSend.setAttribute("aria-label", busy ? "Queue message" : "Send"); els.btnSend.title = busy ? "Queue: sends when Dae finishes" : "Send";
  renderQueue();
  workingSignal(state.busy.size > 0);
}

// "Still working" signal: while any turn is in flight the sidebar M thinks and the tab favicon shows a slowly breathing
// LED dot, so a long turn never looks idle. Back to the plain icon the moment every turn ends.
var favTimer = 0, favImg = null, favLinks = null, favOrig = null; // var, not let: setBusyUi may run before this line
function workingSignal(on) {
  if (!favLinks) { favLinks = [...document.querySelectorAll('link[rel="icon"]')]; favOrig = favLinks.map((l) => l.href); }
  const bot = document.querySelector("m-bot.brand-bot");
  if (bot) { if (on) { if (bot.mood === "idle") bot.mood = "think"; } else if (bot.mood === "think") bot.mood = "idle"; }
  if (on === !!favTimer) return;
  if (!on) { clearInterval(favTimer); favTimer = 0; favLinks.forEach((l, i) => { l.href = favOrig[i]; }); return; }
  const c = document.createElement("canvas"); c.width = c.height = 32;
  const g = c.getContext("2d");
  if (!g) return;
  if (!favImg) { favImg = new Image(); favImg.src = favOrig[0] || "/brand/favicon-32.png"; }
  const t0 = performance.now();
  favTimer = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 3.2)); // slow breathe
    g.clearRect(0, 0, 32, 32);
    if (favImg.complete && favImg.naturalWidth) g.drawImage(favImg, 0, 0, 32, 32);
    g.beginPath(); g.arc(25, 25, 6.5, 0, Math.PI * 2); g.fillStyle = "#0c0b0a"; g.fill();
    g.beginPath(); g.arc(25, 25, 4.5, 0, Math.PI * 2); g.fillStyle = `rgba(255, 90, 82, ${a.toFixed(2)})`; g.fill();
    const url = c.toDataURL("image/png");
    favLinks.forEach((l) => { l.href = url; });
  }, 250);
}
function renderSessions() {
  if (isRenaming()) return; // an inline rename is open: the list is redrawn when it ends
  els.list.replaceChildren();
  const shown = generalSessions(state.sessions); // bot threads live under their bot, in the Bots view
  if (!shown.length) { els.list.append(h("div", "empty-side", "No sessions yet.")); return; }
  for (const s of shown) {
    const b = h("button", "sess"); b.type = "button"; b.dataset.sid = s.id;
    if (s.id === state.currentId) b.setAttribute("aria-current", "true");
    if (s.unread) { b.classList.add("unread"); b.title = "Unread"; }
    const m = h("span", "sess-m");
    m.append(h("span", "", s.surface), h("span", "", "·"), h("span", "", ago(s.updatedAt)));
    if (s.live) { m.append(h("span", "", "·"), h("span", "live", s.busy ? "working" : "live")); }
    b.append(h("span", "sess-t", s.title || "Untitled"), m);
    b.addEventListener("click", () => selectSession(s, { userClick: true }));
    const row = h("div", "sess-row");
    const startRename = () => renameRow(b, s);
    b.addEventListener("dblclick", (e) => { e.preventDefault(); startRename(); });
    row.append(b, renameControl(row, icon, `Rename session ${s.title || "Untitled"}`, startRename), deleteControl(row, icon, `Delete session ${s.title || "Untitled"}`, () => deleteSession(s)));
    els.list.append(row);
  }
}
// Rename a thread (session or bot thread): PATCH the title, keep it in every cached copy, redraw. The server keeps it for good.
async function renameThread(s, title) {
  const prev = s.title;
  const apply = (t) => { for (const x of [state.sessions, bots.threads(), ...bots.cached()]) for (const r of x) if (r.id === s.id) r.title = t; renderSessions(); renderHeader(); bots.renderList(); };
  apply(title);
  try {
    const r = await api(`/sessions/${encodeURIComponent(s.id)}`, { method: "PATCH", body: JSON.stringify({ title }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  } catch (e) { apply(prev); if (e.message !== "unauthorized") notify(`Could not rename the thread: ${e.message}`); }
}
function renameRow(btn, s) {
  editInline({ host: btn, current: s.title || "", onSave: (t) => renameThread(s, t), onEnd: () => { renderSessions(); bots.renderList(); } });
}
// The chat title in the header renames the open thread the same way.
function renameCurrent() {
  const meta = currentMeta();
  if (!meta) return;
  editInline({ host: els.title, current: meta.title || "", className: "head-edit", onSave: (t) => renameThread(meta, t), onEnd: () => { renderHeader(); } });
}
// Delete a session for good: confirm (naming it), the server removes it and its messages, the list updates; if it was open, land on a new session.
async function deleteSession(s) {
  const t = sessionDeleteText(s.title);
  if (!(await confirmDialog(t))) return;
  try {
    const res = await api(`/sessions/${encodeURIComponent(s.id)}?purge=1`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
  } catch (e) { if (e.message !== "unauthorized") notify(`Could not delete the session: ${e.message}`); return; }
  state.transcripts.delete(s.id);
  hist.delete(s.id);
  try { sessionStorage.removeItem(`daebot:t:${s.id}`); } catch { /* none */ }
  const wasOpen = state.currentId === s.id;
  state.sessions = state.sessions.filter((x) => x.id !== s.id);
  if (wasOpen) { newSession(); }
  await refreshSessions();
}
// View-aware: the Sessions view lists plain sessions; the Bots view also refreshes the bots and the selected bot's threads.
// A bot thread can be open while the Sessions view shows, so its bot is kept fresh too.
async function refreshSessions() {
  try { state.sessions = (await json("/sessions")).sessions; } catch { /* shown via connection state */ }
  if (bots.view() === "bots" || state.curBot) await bots.refresh();
  renderSessions(); renderHeader();
}

// Opening a chat: paint what we already hold for it right away (memory, then this tab's saved copy, then the last server read),
// then check with the server in the background. The network is never on the path to the first frame.
let switchSeq = 0, switchCtl = null;
const resuming = new Map(); // chat id -> Promise: the server is bringing a saved chat back to life; a send waits for it
function markCurrentRows() {
  for (const b of document.querySelectorAll(".sess[aria-current]")) b.removeAttribute("aria-current");
  const cur = state.currentId;
  if (!cur) return;
  for (const b of document.querySelectorAll(".sess[data-sid]")) if (b.dataset.sid === cur) b.setAttribute("aria-current", "true");
}
function resumeSession(s, signal) {
  const p = (async () => {
    const { sessionId } = await json("/sessions", { method: "POST", signal, body: JSON.stringify({ surface: "web", title: s.title, resumeId: s.id, ...(s.bot ? { bot: s.bot } : {}) }) });
    s.live = true;
    for (const r of state.sessions) if (r.id === s.id) r.live = true;
    return sessionId;
  })().finally(() => { if (resuming.get(s.id) === p) resuming.delete(s.id); });
  resuming.set(s.id, p);
  return p;
}
async function selectSession(s, opts = {}) {
  if (xchg) xchg.close("nav"); // opening a session leaves any open agent exchange
  const seq = ++switchSeq;
  if (switchCtl) switchCtl.abort(); // the previous chat's resume / read stops; whatever it still returns is ignored below
  const ctl = switchCtl = new AbortController();
  const gone = () => seq !== switchSeq;
  closeSidebar();
  suggest.clear();
  rememberScroll();
  state.currentId = s.id;
  state.curBot = s.bot || "";
  state.openedRow = s;
  const tr = transcript(s.id);
  if (!tr.items.length) restoreTranscript(s.id); // this tab's saved copy of the thread
  const held = hist.get(s.id);
  if (!tr.items.length && held && !held.run) { fillTranscript(tr, held); tr.appliedEtag = undefined; }
  tr.pending = !tr.items.length; // nothing to show yet: a blank thread, not the "What should we work on?" card
  markCurrentRows(); bots.sync();
  renderThread();
  // Background: bring the saved chat back to life if needed, and read the server's copy. Both at once.
  const resume = s.live ? null : resumeSession(s, ctl.signal);
  const read = getHistory(s.id, { signal: ctl.signal });
  try {
    const e = await read;
    if (gone()) return;
    reconcile(s.id, e);
  } catch (err) {
    if (gone() || (err && (err.name === "AbortError" || err.message === "unauthorized"))) return;
    transcript(s.id).pending = false;
    if (!transcript(s.id).items.length) renderThread(); // no saved history: the session starts empty
  }
  if (resume) {
    try {
      const sid = await resume;
      if (gone()) return;
      if (sid !== s.id) { transcript(sid); state.currentId = sid; markCurrentRows(); }
      renderSessions(); bots.renderList(); // the row now reads "live"
    } catch (err) {
      if (gone() || (err && (err.name === "AbortError" || err.message === "unauthorized"))) return;
      return notify(`Could not resume: ${err.message}`);
    }
  }
  if (opts.userClick) await clearUnread(s); // opening the thread yourself reads it; a reload that lands back on it does not
  if (gone()) return;
  if (!els.drawer.hidden) loadViolations();
  whenIdle(() => { if (!gone()) { saveTranscriptSoon(state.currentId); prefetchNeighbors(); } });
}
// Hover, keyboard focus or the start of a press on a chat row: read that chat now, so the click that follows finds it in memory.
{
  let hoverT = 0;
  const sidOf = (ev) => (ev.target && ev.target.closest ? ev.target.closest(".sess[data-sid]") : null)?.dataset.sid;
  for (const root of [els.list, document.getElementById("bot-list")]) {
    if (!root) continue;
    root.addEventListener("pointerover", (ev) => { const id = sidOf(ev); if (!id) return; clearTimeout(hoverT); hoverT = setTimeout(() => prefetchHistory(id), 70); });
    root.addEventListener("pointerout", () => clearTimeout(hoverT));
    root.addEventListener("pointerdown", (ev) => { const id = sidOf(ev); if (id) prefetchHistory(id); });
    root.addEventListener("focusin", (ev) => { const id = sidOf(ev); if (id) prefetchHistory(id); });
  }
}
// Warm the chats on either side of the open one in the list, one at a time while the page is idle.
function prefetchNeighbors() {
  const rows = [...document.querySelectorAll(".sess[data-sid]")].map((b) => b.dataset.sid);
  const i = rows.indexOf(state.currentId);
  const near = (i < 0 ? rows.slice(0, 3) : [rows[i + 1], rows[i - 1], rows[i + 2], rows[i - 2]]).filter(Boolean);
  const next = () => { const id = near.shift(); if (!id) return; if (hist.has(id) || histFlight.has(id) || id === state.currentId) return next(); getHistory(id).catch(() => {}).finally(() => whenIdle(next)); };
  whenIdle(next);
}
function newSession() {
  if (xchg) xchg.close("nav");
  rememberScroll();
  closeSidebar();
  suggest.clear();
  state.currentId = null;
  state.curBot = "";
  state.transcripts.delete(DRAFT);
  renderSessions(); renderThread();
  els.input.focus();
}
// A new thread with one of the user's bots: a draft until the first message, like a new session.
function newBotThread(botId) {
  if (xchg) xchg.close("nav");
  rememberScroll();
  closeSidebar();
  suggest.clear();
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
  if (state.currentId) { const r = resuming.get(state.currentId); if (r) await r; return state.currentId; } // a saved chat must be live before it can take a message
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

// ---------- server-owned runs: stream, re-attach, resume ----------
// A turn keeps running on the server when this connection drops (app closed, phone locked, tab closed, another session opened).
// readStream feeds one SSE response into ctx; pumpRun re-attaches with ?after=<last seq> until the run reports done.
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function readStream(res, ctx) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const lines = chunk.split("\n");
      const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      const idl = lines.find((l) => l.startsWith("id:"));
      if (idl) { const n = Number(idl.slice(3)); if (n > ctx.seq) ctx.seq = n; }
      if (ev.type === "done") ctx.sawDone = true;
      ctx.handle(ev);
    }
  }
}
async function pumpRun(id, ctx, res) {
  let tries = 0;
  for (;;) {
    try { await readStream(res, ctx); tries = 0; } catch (e) { if (e && e.message === "unauthorized") throw e; }
    if (ctx.sawDone) return;
    for (;;) { // dropped before the run finished: it is still going on the server, so take it up again from where we stopped
      if (++tries > 30) throw new Error("Lost connection to the gateway.");
      await sleepMs(Math.min(500 * tries, 4000));
      try {
        const r = await api(`/sessions/${encodeURIComponent(id)}/events?after=${ctx.seq}`);
        if (r.status === 404) { ctx.lost = true; return; }
        if (r.ok) { res = r; setOnline(true); break; }
      } catch (e) { if (e && e.message === "unauthorized") throw e; setOnline(false); }
    }
  }
}
// Replace the visible transcript with the server's saved one (the truth after a restart or a lost run).
async function resyncFromServer(id) {
  try {
    const { events, meta } = await json(`/sessions/${encodeURIComponent(id)}/history`);
    if (!Array.isArray(events)) return;
    const tr = transcript(id), r = itemsFromHistory(events);
    tr.items.length = 0; tr.items.push(...r.items); tr.usage = r.usage; if (r.model) tr.model = r.model;
    applyMeta(tr, meta);
    if (id === tkey()) renderThread();
  } catch { /* offline: the next sync tick retries */ }
}
// Pick up a turn that is running on the server but not driven by this tab (reload, app reopened, another device).
const attached = new Set();
async function attachRun(id, baseEvents) {
  if (attached.has(id) || state.busy.has(id)) return;
  attached.add(id); state.busy.add(id);
  const tr = transcript(id), r = itemsFromHistory(baseEvents);
  tr.items.length = 0; tr.items.push(...r.items); tr.usage = r.usage; if (r.model) tr.model = r.model;
  if (id === tkey()) renderThread();
  setBusyUi();
  const ctx = {
    seq: 0, sawDone: false, lost: false, asst: null, tools: new Map(),
    handle(ev) {
      if (ev.type === "user") { addItem(id, { kind: "user", text: ev.text, ...(ev.photos?.length ? { photos: ev.photos } : {}) }); return; }
      if (ev.type === "device_call") { void deviceCalls.handle(id, ev); return; } // the device runs it; the turn keeps streaming
      ctx.asst = onEvent(id, ev, ctx.asst, ctx.tools);
    },
  };
  try {
    const res = await api(`/sessions/${encodeURIComponent(id)}/events?after=0`);
    if (res.ok) await pumpRun(id, ctx, res); else ctx.lost = true;
  } catch (e) { if (!e || e.message !== "unauthorized") ctx.lost = true; }
  finally {
    if (ctx.asst) { ctx.asst.streaming = false; if (ctx.asst.node) updateAssistant(ctx.asst.node, ctx.asst); }
    if (ctx.lost || !ctx.sawDone) await resyncFromServer(id);
    state.busy.delete(id); attached.delete(id); void resolveIds(id); setBusyUi(); markInflight(id, false);
    renderQueue();
    drainQueue(id);
    transcript(id).syncDones = undefined;
    saveTranscript(id); refreshSessions();
  }
}

async function sendMessage(text, attached = [], quote) {
  text = text.trim();
  if (!text && !attached.length) return;
  suggest.onSend(text); // tells Dae whether the suggested replies were taken, edited or ignored, and clears them
  // Show the message immediately; opening a session can take several seconds while MIND boots.
  const startKey = tkey();
  const userItem = addItem(startKey, { kind: "user", text, ...(quote ? { quote: { id: quote.mid, text: quote.text } } : {}), ...(attached.length ? { photos: attached.map((p) => ({ name: p.name, dataUrl: p.dataUrl, width: p.width, height: p.height })) } : {}) });
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
    if (attached.length && !photos.count()) photos.set(attached);
    return notify(`Could not start a session: ${e.message}`);
  }
  if (startKey !== id) { state.busy.delete(startKey); state.busy.add(id); }
  markInflight(id, true); // a reload or reopen mid-reply lands back on this chat and picks the reply up
  refreshSessions();
  const tr = transcript(id);
  const meta = metaById(id);
  if (meta && (!meta.title || meta.title === "New session")) meta.title = text.slice(0, 60) || (attached.length ? "Photo" : meta.title);
  let first = true;
  const ctx = {
    seq: 0, sawDone: false, lost: false, asst: null, tools: new Map(),
    handle(ev) {
      // The server stored the photos: remember their ids so the thumbnails can be loaded again after a reload.
      if (ev.type === "photos") { (userItem.photos || []).forEach((p, i) => { if (ev.photos?.[i]) p.id = ev.photos[i].id; }); return; }
      if (ev.type === "device_call") { void deviceCalls.handle(id, ev); return; } // the device runs it; the turn keeps streaming
      if (first && ev.type !== "usage") { first = false; dropWaiting(); }
      ctx.asst = onEvent(id, ev, ctx.asst, ctx.tools);
    },
  };
  let refused = false; // the server turned the message away before any turn started
  try {
    const capabilities = calendarCapabilities(); // ["apple_calendar"] inside the iPhone and Mac apps, [] anywhere else
    const body = { text, ...(quote ? { quote: { id: quote.mid, text: (quote.full || quote.text).slice(0, 600) } } : {}), ...(attached.length ? { photos: attached.map(({ name, dataUrl }) => ({ name, dataUrl })) } : {}), ...(capabilities.length ? { capabilities } : {}) };
    const res = await api(`/sessions/${encodeURIComponent(id)}/send`, { method: "POST", body: JSON.stringify(body) });
    if (res.status === 409) throw new Error("This session is busy with another turn.");
    if (!res.ok) { refused = true; throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`); }
    setOnline(true);
    // The turn runs on the server and keeps going if this connection drops; pumpRun re-attaches from the last event seen.
    await pumpRun(id, ctx, res);
  } catch (e) {
    if (e.message !== "unauthorized") { notify(e.message === "Failed to fetch" ? "Lost connection to the gateway." : e.message); if (e.message === "Failed to fetch") setOnline(false); }
    // A message with photos that the server refused (too big, wrong type, chat full) never reached Dae: take it back out of the
    // transcript and put the words and photos back in the composer so nothing is lost.
    if (refused && attached.length) {
      const t = transcript(id), i = t.items.indexOf(userItem);
      if (i >= 0) t.items.splice(i, 1);
      if (userItem.node) userItem.node.remove();
      if (!els.input.value.trim()) { els.input.value = text; grow(); }
      if (!photos.count()) photos.set(attached);
    }
  } finally {
    dropWaiting();
    const asst = ctx.asst;
    if (asst) { asst.streaming = false; if (asst.node) updateAssistant(asst.node, asst); }
    state.busy.delete(id); setBusyUi(); markInflight(id, false);
    renderQueue();
    if (ctx.lost) await resyncFromServer(id); // the run is gone from the server (restart): show what it saved, including the interrupted note
    transcript(id).syncDones = undefined; // this tab just ran the turn itself: re-baseline instead of re-rendering it
    saveTranscript(id);
    void resolveIds(id); // so the message menu works on this turn without a wait
    refreshSessions();
    if (!els.drawer.hidden) loadViolations(); else refreshViolCount();
    board.refresh();
    if (id === state.currentId || id === tkey()) voice.turnDone(answerText(transcript(id), userItem));
    else voice.turnDone("");
    if (id === state.currentId) suggest.load(id); // drafts what the user will probably say next, if the reply waits on them
    drainQueue(id); if (startKey !== id) drainQueue(startKey); // the next queued message goes out now
  }
}

// Remember which chat has a reply being written (tab: sessionStorage; app/browser closed: localStorage), so reopening lands on it.
function markInflight(id, on) {
  try {
    if (on) {
      sessionStorage.setItem("daebot:current", id); sessionStorage.setItem("daebot:bot", state.curBot || "");
      localStorage.setItem("daebot:inflight", JSON.stringify({ id, bot: state.curBot || "" }));
    } else {
      const cur = JSON.parse(localStorage.getItem("daebot:inflight") || "null");
      if (cur && cur.id === id) localStorage.removeItem("daebot:inflight");
    }
  } catch { /* storage unavailable */ }
}

// The assistant text of one turn: every assistant block after that turn's user message.
function answerText(tr, userItem) {
  const i = tr.items.indexOf(userItem);
  return tr.items.slice(i < 0 ? 0 : i + 1).filter((x) => x.kind === "assistant").map((x) => x.text).join("\n\n");
}

// Keep the visible conversation across reloads (this browser tab only).
const TLRU_KEY = "daebot:tlru", TLRU_MAX = 14;
// The saved copies are kept for the TLRU_MAX most recently used chats; when storage is full the oldest go first.
function touchTranscriptLru(id, drop) {
  let order = [];
  try { order = JSON.parse(sessionStorage.getItem(TLRU_KEY) || "[]").filter((x) => typeof x === "string" && x !== id); } catch { order = []; }
  if (!drop) order.push(id);
  while (order.length > TLRU_MAX) { try { sessionStorage.removeItem(`daebot:t:${order.shift()}`); } catch { /* none */ } }
  try { sessionStorage.setItem(TLRU_KEY, JSON.stringify(order)); } catch { /* none */ }
  return order;
}
function saveTranscript(id) {
  try {
    // Photo data never goes into sessionStorage (it would fill it); a photo is shown again from the server by its id.
    const items = transcript(id).items.filter((it) => it.kind !== "notice" || it.level === "warn").map(({ node, parts, ...rest }) => (rest.photos ? { ...rest, photos: rest.photos.map(({ dataUrl, ...p }) => p) } : rest));
    const val = JSON.stringify(items.slice(-200)), key = `daebot:t:${id}`;
    try { sessionStorage.setItem(key, val); }
    catch { // full: drop the oldest saved chats until it fits
      for (const old of touchTranscriptLru(id, true)) { try { sessionStorage.removeItem(`daebot:t:${old}`); sessionStorage.setItem(key, val); break; } catch { /* next */ } }
    }
    touchTranscriptLru(id);
    if (id === state.currentId) { // "the chat to reopen" is the one on screen, not whichever finished last in the background
      sessionStorage.setItem("daebot:current", id);
      sessionStorage.setItem("daebot:bot", state.curBot || "");
    }
  } catch { /* storage unavailable: transcript stays in memory */ }
}
const saveQueued = new Set();
/** saveTranscript off the click path: serialising a long chat is work the reader should not wait for. */
function saveTranscriptSoon(id) {
  if (saveQueued.has(id)) return;
  saveQueued.add(id);
  whenIdle(() => { saveQueued.delete(id); saveTranscript(id); });
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
      // Daebot proposed an MCP server: put the consent card in the thread (only the card's Connect button can connect it).
      if (ev.tool === "task_board") board.poke(); // the board changed: refresh it if it is open
      if (ev.tool === "bot_manage") bots.refresh(); // Daebot just made, changed or deleted a bot: the Bots tab shows it without a reload
      if (ev.tool === "mcp_connect" && ev.ok) mcp.newPending().then((ps) => { for (const p of ps) addItem(id, { kind: "mcp", pending: p }); }).catch(() => {});
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
    case "permission": {
      board.poke(); // a card is waiting on the user: that session turns red on the board
      if (asst) { asst.streaming = false; paintAssistant(asst); }
      const it = addItem(id, permissionItem(ev));
      (tr.perms ||= new Map()).set(ev.id, it);
      return null;
    }
    case "permissionResolved": {
      const it = tr.perms && tr.perms.get(ev.id);
      if (it) { resolvePermission(it, ev); if (it.repaint) it.repaint(); }
      return asst;
    }
    case "notice":
      addItem(id, { kind: "notice", level: ev.level, text: ev.text });
      return asst;
    case "exchange":
      if (asst) { asst.streaming = false; paintAssistant(asst); }
      addItem(id, { kind: "exchange", exchangeId: ev.exchangeId, from: ev.from, to: ev.to, message: ev.message, reply: ev.reply, at: ev.at });
      if (xchg) xchg.poke();
      return null;
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

// ---------- reply from the task board ----------
// The session on screen takes the normal composer path (so the reply streams into the chat). Any other session is brought back
// live and gets the same POST /sessions/:id/send; the turn is server-owned, so we only wait for the server to accept it.
async function replyInto(id, text) {
  if (id === state.currentId) {
    if (state.busy.has(id)) { enqueue(id, text, []); return; }
    sendMessage(text, []);
    return;
  }
  const row = state.sessions.find((x) => x.id === id);
  const opened = await json("/sessions", { method: "POST", body: JSON.stringify({ surface: "web", title: row ? row.title : "", resumeId: id }) });
  const sid = opened.sessionId || id;
  const res = await api(`/sessions/${encodeURIComponent(sid)}/send`, { method: "POST", body: JSON.stringify({ text, ...(calendarCapabilities().length ? { capabilities: calendarCapabilities() } : {}) }) });
  if (!res.ok) throw new Error(res.status === 409 ? "That session is busy right now. Try again in a moment." : (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  try { await res.body?.cancel(); } catch { /* the run continues on the server */ }
  state.transcripts.delete(sid); // our copy is now behind the server's; reopening the session reloads it
  refreshSessions();
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
  if (open) { bots.closeDrawer(); board.close(); loadViolations(); }
}

// ---------- theme ----------
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = effectiveDark();
  els.themeIc.firstElementChild.setAttribute("href", dark ? "#i-sun" : "#i-moon");
  try { window.mindclawDesktop?.titleBar?.setTheme(dark); } catch { /* not the desktop app */ } // Windows/Linux window buttons follow the page
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
  account?.setOnline(!!on);
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
    if (r.ok) { const h = await r.json().catch(() => ({})); state.hosted = h.hosted === true; applyBotsFlag(h.bots === true); els.btnLogout.hidden = !state.hosted && !desktopBridge(); if (h.model !== state.model) { state.model = h.model || ""; renderConn(); models.setHealth(typeof state.model === "string" ? state.model : state.model.id || state.model.name || ""); } if (state.hosted && !state.who) showWho(); else if (!state.hosted && !state.who) showDesktopWho(); }
  } catch { setOnline(false); }
}

// Re-read the usage line after a turn (and whenever the account menu opens). The gateway holds the plan; MIND answers GET /usage.
function refreshPlan() { usage?.refresh(); }

// Desktop app: the shell exposes signOut(); the gateway answers /account with the MIND account the app signed in as.
function desktopBridge() { return typeof window.mindclawDesktop?.signOut === "function" ? window.mindclawDesktop : null; }
async function showDesktopWho() {
  try {
    const r = await api("/account");
    if (!r.ok) return;
    const me = await r.json().catch(() => ({}));
    if (!me.signedIn || !me.username) return;
    state.who = me.username; window.dispatchEvent(new Event("daebot:who"));
    account?.setIdentity({ username: me.username, owner: false, sub: "MIND account" });
    usage?.refresh();
  } catch { /* shown on the next ping */ }
}

// Desktop app: the shell checks for updates on launch and every hour and downloads in the background. The account menu shows
// "New update available" with a Restart button, and a "Check for updates" item (account.js).
function desktopUpdates() { const u = desktopBridge()?.updates; return u && typeof u.get === "function" ? u : null; }
function renderUpdate(s) { account?.setUpdate(s); }
async function initDesktopUpdates() {
  const u = desktopUpdates();
  if (!u) return;
  u.onChange(renderUpdate);
  try { renderUpdate(await u.get()); } catch { /* older shell */ }
}
initDesktopUpdates();

// Web and mobile apps: same bar, but "latest" is the live gateway's build. A newer build shows Reload; Check for updates re-reads it now.
let webBuild = null;
async function checkWebUpdate(manual) {
  const box = document.getElementById("upd"), text = document.getElementById("upd-text"), btn = document.getElementById("upd-btn");
  if (!box || desktopUpdates()) return;
  let h = null;
  try { const r = await fetch("/health", { cache: "no-store" }); if (r.ok) h = await r.json(); } catch { /* offline: keep what is shown */ }
  if (!h && !manual) return;
  const st = compareBuild(webBuild, h);
  webBuild = st.loaded;
  const t = webUpdateText(st);
  box.hidden = false; box.classList.toggle("ready", st.stale);
  text.textContent = h || webBuild ? t.text : "Daebot · update check failed";
  btn.textContent = t.button; btn.hidden = false; btn.disabled = false;
  btn.onclick = st.stale ? () => location.reload() : () => { btn.disabled = true; checkWebUpdate(true); };
}
if (!desktopUpdates()) { checkWebUpdate(false); setInterval(() => checkWebUpdate(false), WEB_CHECK_MS); document.addEventListener("visibilitychange", () => { if (!document.hidden) checkWebUpdate(false); }); }

// Hosted: show which MIND account this session is acting as (its own MIND, or the owner's).
async function showWho() {
  try {
    const r = await fetch("/auth/me", { credentials: "same-origin" });
    if (!r.ok) return r.status === 401 ? false : true; // 401 = not signed in; anything else is a hiccup, not a sign-out
    const me = await r.json();
    state.who = me.username; window.dispatchEvent(new Event("daebot:who"));
    account?.setIdentity({ username: me.username, owner: me.owner, planName: me.tierName });
    usage?.refresh();
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
initGift();
$("btn-newbot").addEventListener("click", () => { closeSidebar(); bots.openCard(); });
initSearch({
  h, getSessions: () => state.sessions, getBots: () => bots.bots(), ensureLoaded: async () => { await bots.ensureLoaded(); try { state.sessions = (await json("/sessions")).sessions; } catch { /* the list on screen */ } },
  openSession: (s) => selectSession(s, { userClick: true }), openBot: (id) => bots.pickBot(id), closeSidebar,
});
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
  if (!t.trim() && !photos.count()) return;
  if (photos.preparing()) { photos.say(PHOTO_SAYS.preparing); return; } // the words stay in the box
  els.input.value = ""; grow();
  photos.say("");
  const attached = photos.take();
  const quote = replies.get(tkey());
  replies.delete(tkey()); paintReplyChip();
  if (state.busy.has(tkey())) { enqueue(tkey(), t, attached, quote); return; } // never refuse: hold it and send when the turn ends
  sendMessage(t, attached, quote);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.busy.has(tkey())) { e.preventDefault(); abortTurn(); }
  else if (!els.drawer.hidden) toggleDrawer(false);
  else if (board.isOpen()) board.close();
  else if (bots.drawerOpen()) bots.closeDrawer();
  else closeSidebar();
});

// ---------- voice (MIND Voice: mic, spoken answers, hands-free; billed to the user's MIND credits) ----------
const voice = initVoice({
  els: { mic: $("btn-mic"), voiceBtn: $("btn-voice"), pill: $("voice-pill"), speak: $("btn-speak"), convo: $("btn-convo"), dock: $("voice-dock"), status: $("voice-status"), stop: $("voice-stop"),
         bars: [...document.querySelectorAll("#voice-dock .vbars i")], composer: els.composer, input: els.input },
  authHeaders: () => (token ? { authorization: `Bearer ${token}` } : {}),
  onUnauthorized: () => { if (state.hosted) location.replace("/"); else showTokenGate("That token was not accepted."); },
  isBusy: () => state.busy.has(tkey()),
  notify: (t) => notify(t),
  creditsChanged: () => refreshPlan(),
  bots: () => [...document.querySelectorAll(".hero-bot, .bot-dock m-bot")],
});

// Hold-to-talk hotkeys (Right Option = dictation, Right Command = voice by default) + the Keyboard shortcuts card.
const hotkeys = initHotkeys({
  voice, h, icon, notify,
  getUser: () => state.who || "",
  desktop: () => (typeof window.mindclawDesktop?.shortcuts?.get === "function" ? window.mindclawDesktop : null),
  hintEl: $("hotkey-hint"), buttons: { dictate: $("btn-mic"), voice: $("btn-voice") }, openButton: $("am-keys"),
});
$("am-keys").addEventListener("click", closeSidebar);
// "Let Daebot watch my screen" (desktop app only; hidden everywhere else): the menu switch, the red pill with Stop, the permission card.
initScreen({ h, item: $("am-screen"), pill: $("screen-pill") });

// ---------- suggested replies + permissions ----------
const suggest = initSuggest({
  json, h, wrap: $("suggest"), input: els.input, grow,
  currentId: () => state.currentId, isBusy: (id) => state.busy.has(id),
});
const permissions = initPermissions({ json, h, icon, notify, button: $("btn-perms") });
$("btn-perms").addEventListener("click", closeSidebar);
chatMode = initChatMode({
  json, h, icon, notify,
  ids: { btn: "mode-btn", label: "mode-label", menu: "mode-menu" },
  ensureSession: () => ensureSession(),
  getSessionId: () => state.currentId,
  getRow: () => state.sessions.find((s) => s.id === state.currentId),
  onRowMode: (id, mode) => { const r = state.sessions.find((s) => s.id === id); if (r) { if (mode) r.permMode = mode; else delete r.permMode; } },
});
const usage = initUsage({ json, notify });
account = initAccount({
  json, h, icon, notify,
  onOpen: () => usage.refresh(),
  desktop: () => desktopBridge(),
  isHosted: () => state.hosted,
  closeSidebar,
  openApps: () => $("btn-apps").click(),
});
if (state.online !== null) account.setOnline(!!state.online);

// ---------- bots + model picker ----------
const models = initModels({
  json, store, notify, icon,
  getSessionId: () => state.currentId,
  onPicked: () => renderHeader(),
  onPinnedClick: () => { if (state.curBot) bots.openSettings(state.curBot); },
});
els.title.addEventListener("click", () => renameCurrent());
let xchg = null; // agent exchanges (cards in the chat, the read-only transcript, the Bots tab group); assigned just after the bots module
const bots = initBots({
  json, api, store, h, icon, ago, notify,
  app: {
    exchangesGroup: () => (xchg ? xchg.group() : null),
    exchangeUnread: (id) => (xchg ? xchg.unreadFor(id) : 0),
    currentBot: () => state.curBot,
    mainSettings: () => $("acct-btn").click(),
    currentId: () => state.currentId,
    refresh: () => refreshSessions(),
    newThread: (id) => newBotThread(id),
    openThread: (s) => selectSession(s, { userClick: true }),
    closeViolations: () => { if (!els.drawer.hidden) toggleDrawer(false); board.close(); },
    botChanged: () => renderHeader(),
    modelRows: async () => { if (!models) return []; await models.list(); return models.rows(); },
    botDeleted: (id) => { if (state.curBot === id) newSession(); refreshSessions(); },
    threadDeleted: (s) => deleteSession(s),
    renameThread: (btn, s) => renameRow(btn, s),
  },
});
// A setup link from Daebot (#setup=<bot id>/<routine id>) opens that routine's Set up step.
{
  const openFromHash = (tries = 4) => { const m = /^#setup=(b_[0-9a-f]{12})\/(r_[0-9a-f]{12})$/.exec(location.hash); if (m) bots.openSetup(m[1], m[2]).then((ok) => { if (ok) history.replaceState(null, "", location.pathname + location.search); else if (tries > 1) setTimeout(() => openFromHash(tries - 1), 1500); }).catch(() => { if (tries > 1) setTimeout(() => openFromHash(tries - 1), 1500); }); };
  openFromHash();
  window.addEventListener("hashchange", () => openFromHash());
}

xchg = initExchanges({
  json, h, icon, ago,
  app: {
    online: () => state.online,
    notify,
    // The agent whose thread is on screen: a bot id, or "main" for a plain session. Cards "X messaged you" appear in that thread.
    currentParty: () => (state.currentId ? (state.curBot || "main") : ""),
    addInbound: (it) => { if (state.currentId) addItem(state.currentId, it); },
    beforeOpen: () => { closeSidebar(); if (!els.drawer.hidden) toggleDrawer(false); board.close(); },
    listChanged: () => bots.renderList(),
  },
});
bots.renderList();

// ---------- task board (right-side drawer, sibling of the violations drawer) ----------
const board = initBoard({
  json, h,
  els: { btn: $("btn-board"), count: $("board-count"), drawer: $("board-drawer"), close: $("btn-board-close"), note: $("board-note"), list: $("board-list") },
  app: {
    closeOthers: () => { if (!els.drawer.hidden) toggleDrawer(false); bots.closeDrawer(); },
    openSession: async (id) => {
      const s = state.sessions.find((x) => x.id === id);
      if (!s) return notify("That session is not in your list any more.");
      if (matchMedia("(max-width: 700px)").matches) board.close(); // on a phone the sheet covers the chat
      await selectSession(s);
    },
    // The reply goes through the normal durable send path, into the session the question belongs to.
    reply: (id, text) => replyInto(id, text),
  },
});

// Apps card: the sidebar's Apps button opens MIND integrations (and any section other modules add with apps.addSection).
const apps = initApps({ api, signOut: () => els.btnLogout.click() });
$("btn-apps").addEventListener("click", closeSidebar); // phones: the drawer steps aside for the card
// "Connected MCP servers" is a section of the Apps card (hidden when the deployment has the feature off).
// "Connectors" (the MIND App Store's MCP servers) is registered first so it sits above the connected-servers list.
let mcp; // assigned just below; the Connectors section only uses it after the user clicks
initConnectors({ apps, json, getMcp: () => mcp, openDetail: openConnectorDetail });
const mcpSec = h("section", "apps-sec"); mcpSec.dataset.sec = "mcp"; mcpSec.hidden = true;
const mcpHead = h("h3", "", "Connected MCP servers"); mcpHead.id = "apps-h-mcp";
const mcpBody = h("div", "apps-body mcp-panel"); mcpBody.setAttribute("role", "group"); mcpBody.setAttribute("aria-labelledby", "mcpHead");
mcpBody.setAttribute("aria-labelledby", "apps-h-mcp");
mcpSec.append(mcpHead, h("p", "apps-note", "Daebot can find a server and ask to connect it. Only your click connects it."), mcpBody);
$("apps-sections").append(mcpSec);
mcp = initMcp({ json, api, h, icon, notify, mount: mcpBody, section: mcpSec, openApps: () => $("btn-apps").click(), suspendApps: () => apps.suspend(), resumeApps: () => apps.resume() });
$("btn-apps").addEventListener("click", () => mcp.load());
{
  // Back from a server's sign-in: this gateway's own callback sends ?mcp=connected|failed, MIND's sends ?mcp_connected=<server id> or ?mcp_error=<code>.
  const sp = new URL(location.href).searchParams;
  const q = sp.get("mcp"), okId = sp.get("mcp_connected"), errCode = sp.get("mcp_error");
  if (q || okId || errCode) { mcp.returned(q, { connectedId: okId || "", errorCode: errCode || "" }); history.replaceState(null, "", location.pathname); }
}

// ---------- boot ----------
const mainBot = initMainBot({ json, onChange: () => bots.sync() });
async function boot() {
  renderThread();
  await ping();
  if (!token && !state.hosted) return showTokenGate();
  // Prewarming a session boots MIND, so it only ever runs for a signed-in user (hosted: the session cookie must be valid).
  if (state.hosted && !(await showWho())) return location.replace("/");
  await refreshSessions();
  mainBot.refresh();
  board.refresh();
  xchg.refresh();
  mcp.load();
  permissions.probe();
  chatMode.probe();
  let last = null;
  try { last = sessionStorage.getItem("daebot:current"); } catch { /* none */ }
  if (!last) { try { const f = JSON.parse(localStorage.getItem("daebot:inflight") || "null"); if (f && f.id) { last = f.id; sessionStorage.setItem("daebot:bot", f.bot || ""); } } catch { /* none */ } }
  let known = last && state.sessions.find((s) => s.id === last); // live, or saved on the server (survives restarts)
  let lastBot = ""; try { lastBot = sessionStorage.getItem("daebot:bot") || ""; } catch { /* none */ }
  if (!known && last && lastBot) { // a bot thread may not be in the plain list
    try { known = ((await json(`/sessions?bot=${encodeURIComponent(lastBot)}`)).sessions || []).find((s) => s.id === last); if (known && !known.bot) known = { ...known, bot: lastBot }; } catch { /* no such bot */ }
  }
  if (known && known.live && restoreTranscript(last)) { state.currentId = last; state.curBot = known.bot || ""; await bots.ensureLoaded(); renderSessions(); renderThread(); }
  else if (known) { await selectSession(known); } // resumes and replays the saved transcript
  else if (!state.currentId) { ensureSession().then(() => { renderSessions(); renderHeader(); }).catch(() => { /* first send retries */ }); }
  syncCurrent(); // a reply still running on the server is picked up and keeps streaming
}
boot();
setInterval(ping, 10000);
setInterval(() => { if ((token || state.hosted) && state.online) { refreshSessions(); mainBot.refresh(); board.refresh(); } }, 30000);
initUpdates();
