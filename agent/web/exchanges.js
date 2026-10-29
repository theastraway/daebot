// Agent exchanges (web): the cards that say one agent messaged another, the read-only two-sided transcript they open, and the
// "Exchanges" group (with unread dots) in the Bots tab.
//
//   - a "Messaged <face> Name" line + the message bubble sits in the chat where bot_talk was called (live `exchange` events and replayed history)
//   - "<Name> messaged you" shows in the thread of the agent that was messaged while the user was not driving (found by polling GET /exchanges)
//   - tapping either opens the pair's exchange: both agents' faces overlapped in the header, each message under its sender's name,
//     the sender's face beside the bubble, tool calls collapsed, and a Read-only pill where the composer would be (the user watches)
//
// DOM is built with createElement + textContent only; there is no innerHTML. The pure helpers are exported and unit tested.

import { faceSvg } from "./faces.js";

export const POLL_MS = 8000;
export const MAIN_ID = "main";
const DEFAULT_COLOR = "#ffd25a";

// ---------------------------------------------------------------- pure helpers

export function safeColor(c) {
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim().toLowerCase() : DEFAULT_COLOR;
}

export function clip(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** "Today 7:30 PM", "Yesterday 9:05 AM", "Mon 4:10 PM", or "Oct 12, 4:10 PM". `now` is injectable for tests. */
export function dividerLabel(ts, now = Date.now()) {
  const d = new Date(ts), n = new Date(now);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(n) - day0(d)) / 86400000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** Where a timestamp divider goes: before the first message, and again after a gap of an hour or more. */
export function needsDivider(prevAt, at) {
  return prevAt === undefined || at - prevAt >= 60 * 60 * 1000;
}

/** The other end of an exchange summary, seen from `me` ("main" or a bot id). */
export function otherOf(ex, me) {
  return ex.a && ex.a.id === me ? ex.b : ex.a;
}

/** Exchanges with something the user has not seen, newest first. */
export function unreadList(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && x.unread > 0);
}

/** Does this exchange involve this party (a bot id, or "main")? */
export function involves(ex, id) {
  return !!ex && ((ex.a && ex.a.id === id) || (ex.b && ex.b.id === id));
}

/** The "Decision ✓" chip's label: short id, with the role it vouches for. Pure so it is unit tested. */
export function decisionLabel(d) {
  const id = String((d && d.id) || "");
  const short = id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
  return { text: `Decision ✓ ${short}`, title: `${d && d.role === "receiver" ? "Receiver" : "Requester"} OOC/EMR decision record (MIND document ${id})` };
}

export function titleOf(ex) {
  return `${ex.a ? ex.a.name : "?"} ↔ ${ex.b ? ex.b.name : "?"}`;
}

// ---------------------------------------------------------------- UI

export function initExchanges(ctx) {
  const { json, h, icon, ago, app } = ctx;
  const st = { list: [], unread: 0, loaded: false, openId: "", timer: null, loading: false, shown: new Set(), view: null };

  /** A small round face: the agent's face in its LED colour, else its initial. The main Daebot is a warm "D" disc. */
  function face(p, cls = "") {
    const b = h("span", `xf ${p && p.kind === "main" ? "xf-main" : "bot-badge has-face"} ${cls}`.trim());
    b.setAttribute("aria-hidden", "true");
    const svg = p && p.kind === "bot" ? faceSvg(p.face) : null;
    if (svg) b.append(svg);
    else b.textContent = (String((p && p.name) || "?").match(/[\p{L}\p{N}]/u) || ["?"])[0].toUpperCase();
    if (p && p.kind === "bot") b.style.setProperty("--bot", safeColor(p.color));
    return b;
  }
  function facePair(a, b, cls = "") {
    const w = h("span", `xf-pair ${cls}`.trim());
    w.setAttribute("aria-hidden", "true");
    w.append(face(a), face(b));
    return w;
  }

  // ------------------------------------------------------------ data
  async function refresh() {
    if (st.loading) return;
    st.loading = true;
    try {
      const r = await json("/exchanges");
      st.list = Array.isArray(r.exchanges) ? r.exchanges : [];
      st.unread = st.list.filter((x) => x.unread > 0).length;
      st.loaded = true;
      paintTab();
      if (app.listChanged) app.listChanged();
      surfaceInbound();
    } catch { /* not enabled here, or offline: nothing to show */ }
    finally { st.loading = false; }
  }
  function poke() { setTimeout(refresh, 600); }
  function start() {
    if (st.timer) return;
    st.timer = setInterval(() => { if (!document.hidden && app.online()) refresh(); }, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  }

  function paintTab() {
    const tab = document.getElementById("tab-bots");
    if (!tab) return;
    let dot = tab.querySelector(".xchg-dot");
    if (st.unread > 0) {
      if (!dot) { dot = h("i", "xchg-dot"); dot.setAttribute("aria-hidden", "true"); tab.append(dot); }
      tab.setAttribute("aria-label", `Bots, ${st.unread} unread ${st.unread === 1 ? "exchange" : "exchanges"}`);
    } else {
      if (dot) dot.remove();
      tab.removeAttribute("aria-label");
    }
  }

  /** Unread exchanges involving a bot (for the dot on its row). */
  const unreadFor = (id) => st.list.filter((x) => x.unread > 0 && involves(x, id)).length;

  // While the user is looking at an agent's thread, an exchange another agent started with it shows up as a card in that thread.
  function surfaceInbound() {
    const me = app.currentParty();
    if (!me) return;
    for (const ex of unreadList(st.list)) {
      if (!involves(ex, me) || !ex.last || ex.last.from === me) continue;
      const key = `${me}|${ex.id}|${ex.last.at}`;
      if (st.shown.has(key)) continue;
      st.shown.add(key);
      const from = otherOf(ex, me);
      const self = ex.a.id === me ? ex.a : ex.b;
      app.addInbound({ kind: "xin", exchangeId: ex.id, from, to: self, message: ex.last.text, at: ex.last.at });
    }
  }

  // ------------------------------------------------------------ the card in the chat
  const bubble = (text, p, cls) => {
    const row = h("div", `xc-row ${cls}`);
    const b = h("div", "xc-bubble", clip(text, 600));
    row.append(b, face(p, "xf-sm"));
    return row;
  };
  const openBtn = (id, cls, parts, label) => {
    const b = h("button", cls); b.type = "button";
    b.setAttribute("aria-label", label);
    b.append(...parts);
    b.addEventListener("click", () => open(id));
    return b;
  };

  /** it: a live/replayed `exchange` item ({from, to, message, reply?, at}) or an inbound `xin` item. */
  function buildCard(it) {
    const card = h("div", "xchg-card");
    card.dataset.exchange = it.exchangeId;
    card.append(h("div", "xc-time", dividerLabel(it.at)));
    if (it.kind === "xin") {
      card.append(openBtn(it.exchangeId, "xc-line", [face(it.from, "xf-xs"), h("span", "xc-name", it.from.name), h("span", "", "messaged you"), icon("i-chev")], `${it.from.name} messaged you. View exchange`));
      const row = bubble(it.message, it.from, "recv");
      card.append(row, openBtn(it.exchangeId, "xc-view", [document.createTextNode("View exchange")], "View exchange"));
      return card;
    }
    card.append(openBtn(it.exchangeId, "xc-line", [h("span", "", "Messaged"), face(it.to, "xf-xs"), h("span", "xc-name", it.to.name), icon("i-chev")], `Messaged ${it.to.name}. View exchange`));
    card.append(bubble(it.message, it.from, "sent"));
    if (it.reply) {
      card.append(
        openBtn(it.exchangeId, "xc-line", [face(it.to, "xf-xs"), h("span", "xc-name", it.to.name), h("span", "", it.reply.ok ? "replied" : "did not answer"), icon("i-chev")], `${it.to.name} ${it.reply.ok ? "replied" : "did not answer"}. View exchange`),
        bubble(it.reply.text, it.to, "recv"),
      );
    } else {
      card.append(h("div", "xc-pending", `${it.to.name} will answer in the exchange.`));
    }
    card.append(openBtn(it.exchangeId, "xc-view", [document.createTextNode("View exchange")], "View exchange"));
    return card;
  }

  // ------------------------------------------------------------ the exchange view (read-only)
  function ensureView() {
    if (st.view) return st.view;
    const root = h("section", "xv"); root.hidden = true;
    root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "false"); root.setAttribute("aria-label", "Agent exchange");
    const head = h("header", "xv-head");
    const back = h("button", "icon-btn xv-back"); back.type = "button"; back.setAttribute("aria-label", "Back");
    back.append(icon("i-chev")); back.querySelector("svg").classList.add("xv-back-ic");
    back.addEventListener("click", close);
    const titles = h("div", "xv-titles");
    const faces = h("span", "xv-faces");
    const title = h("h2", "xv-title", ""); const sub = h("p", "xv-sub", "");
    titles.append(title, sub);
    head.append(back, faces, titles);
    const scroll = h("div", "xv-scroll");
    const list = h("div", "xv-list"); list.setAttribute("aria-live", "polite");
    scroll.append(list);
    const foot = h("footer", "xv-foot");
    const pill = h("span", "xv-pill"); pill.append(icon("i-lock"), h("span", "", "Read-only"));
    foot.append(pill);
    root.append(head, scroll, foot);
    (document.querySelector(".main") || document.body).append(root);
    root.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    st.view = { root, faces, title, sub, list, scroll, back };
    return st.view;
  }

  function paintTranscript(ex) {
    const v = ensureView();
    const byId = new Map([[ex.a.id, ex.a], [ex.b.id, ex.b]]);
    v.faces.replaceChildren(facePair(ex.a, ex.b, "xf-pair-lg"));
    v.title.textContent = titleOf(ex);
    v.sub.textContent = `${ex.messages.length} ${ex.messages.length === 1 ? "message" : "messages"} · you can watch, not write`;
    const atBottom = v.scroll.scrollHeight - v.scroll.scrollTop - v.scroll.clientHeight < 80;
    v.list.replaceChildren();
    if (!ex.messages.length) v.list.append(h("p", "xv-empty", "No messages yet."));
    let prev;
    for (const m of ex.messages) {
      if (needsDivider(prev, m.at)) v.list.append(h("div", "xv-time", dividerLabel(m.at)));
      prev = m.at;
      const p = byId.get(m.from) || { id: m.from, kind: "bot", name: "a deleted bot" };
      const left = m.from === ex.a.id;
      const row = h("div", `xv-msg ${left ? "left" : "right"} ${m.kind}`);
      const col = h("div", "xv-col");
      col.append(h("div", "xv-name", p.name));
      col.append(h("div", "xv-bubble", m.text));
      if (m.tools && m.tools.length) {
        const d = document.createElement("details"); d.className = "xv-tools";
        const s = document.createElement("summary");
        s.textContent = `${m.tools.length} tool ${m.tools.length === 1 ? "call" : "calls"}`;
        d.append(s);
        for (const t of m.tools) {
          const line = h("div", `xv-tool ${t.ok ? "ok" : "fail"}`);
          line.append(h("span", "xv-tool-name", t.name), h("span", "xv-tool-out", clip(t.preview, 160) || (t.ok ? "ok" : "failed")));
          d.append(line);
        }
        col.append(d);
      }
      if (m.decisions && m.decisions.length) {
        const chips = h("div", "xv-decisions");
        for (const d of m.decisions) {
          const l = decisionLabel(d);
          const a = h("a", `xv-decision ${d.role === "receiver" ? "recv" : "req"}`, l.text);
          a.href = `https://m-i-n-d.ai/documents?q=${encodeURIComponent(d.id)}`; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = l.title;
          a.dataset.decision = d.id;
          chips.append(a);
        }
        col.append(chips);
      }
      col.append(h("div", "xv-at", ago(m.at)));
      row.append(face(p, "xf-md"), col);
      v.list.append(row);
    }
    if (atBottom || !st.openId) v.scroll.scrollTop = v.scroll.scrollHeight;
  }

  let openSeq = 0;
  async function open(id) {
    const seq = ++openSeq;
    let ex;
    try { ex = (await json(`/exchanges/${encodeURIComponent(id)}`)).exchange; } catch { app.notify("That exchange is gone."); return; }
    if (seq !== openSeq || !ex) return;
    app.beforeOpen();
    const v = ensureView();
    st.openId = ex.id;
    st.openEx = ex;
    paintTranscript(ex);
    v.root.hidden = false;
    document.body.classList.add("xv-open");
    v.scroll.scrollTop = v.scroll.scrollHeight;
    v.back.focus({ preventScroll: true });
    json(`/exchanges/${encodeURIComponent(ex.id)}/seen`, { method: "POST" }).then(() => refresh(), () => {});
  }
  function close() {
    if (!st.view) return;
    st.view.root.hidden = true;
    st.openId = "";
    document.body.classList.remove("xv-open");
  }
  // A live exchange keeps updating while it is open (a reply landing, or the next message).
  setInterval(async () => {
    if (!st.openId || document.hidden) return;
    try {
      const ex = (await json(`/exchanges/${encodeURIComponent(st.openId)}`)).exchange;
      if (ex && st.openId === ex.id && (!st.openEx || ex.updatedAt !== st.openEx.updatedAt)) { st.openEx = ex; paintTranscript(ex); json(`/exchanges/${encodeURIComponent(ex.id)}/seen`, { method: "POST" }).catch(() => {}); }
    } catch { /* keep what is on screen */ }
  }, 4000);

  // ------------------------------------------------------------ the sidebar group
  /** The "Exchanges" group for the Bots tab (null when there are none). */
  function group() {
    if (!st.list.length) return null;
    const box = h("div", "xs-group");
    const head = h("div", "xs-head");
    head.append(h("span", "", "Exchanges"));
    if (st.unread) head.append(h("i", "xchg-dot inline"));
    box.append(head);
    for (const ex of st.list.slice(0, 12)) {
      const b = h("button", "xs-row"); b.type = "button";
      if (st.openId === ex.id) b.setAttribute("aria-current", "true");
      b.setAttribute("aria-label", `${titleOf(ex)}${ex.unread ? ", unread" : ""}`);
      const text = h("span", "xs-text");
      text.append(h("span", "xs-title", titleOf(ex)), h("span", "xs-prev", ex.last ? clip(ex.last.text, 80) : ""));
      b.append(facePair(ex.a, ex.b), text, h("span", "xs-ago", ago(ex.updatedAt)));
      if (ex.unread) b.append(h("i", "xchg-dot"));
      b.addEventListener("click", () => open(ex.id));
      box.append(b);
    }
    return box;
  }

  start();
  return { buildCard, open, close, refresh, poke, group, unreadFor, list: () => st.list, isOpen: () => !!st.openId };
}
