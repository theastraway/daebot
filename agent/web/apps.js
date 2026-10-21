// Apps card for Daebot (web). A settings card opened from the "Apps" button at the bottom of the sidebar.
// Sections: "MIND integrations" (Google, Microsoft 365, Dropbox, ...) from GET /apps/integrations, which the gateway
// proxies to MIND with the signed-in user's own key. More sections (e.g. MCP servers) plug in with addSection().
//
// Reusable pieces (the MCP builder uses these, nothing else needs to change):
//   renderEntries(body, entries, handlers)   ONE render function for any list of apps. An entry is
//       { id, name, blurb?, provider?, connected, needsReconnect?, account?, unavailable?, note? }
//       and handlers are { onConnect(entry, ctl), onDisconnect(entry, ctl), confirmText?(entry) } where ctl = { busy(bool), say(text) }.
//   api.addSection({ id, title, note?, search?, load: async () => entries | { entries, message?, signIn?, hidden? }, handlers })
//       registers a section; it loads when the card opens and after the user comes back to the tab. `search` (a placeholder
//       string) adds a search box that filters the section's entries by name, category, description and tags.
//   An entry can also carry { tags: [{ text, tone? }], waiting?, removeLabel? }; handlers can add onManage(entry) for a Manage button on connected rows.
//   api.suspend() / api.resume() hide the card while another dialog (the MCP consent card) is the only thing on screen.
// DOM is built with createElement + textContent only; no innerHTML; same-origin requests only.
import { markFor } from "/apps-icons.js";

/** What the status line says for one entry. */
export function statusOf(e) {
  if (e.unavailable) return { text: e.note || "Not available yet", tone: "off" };
  if (e.waiting && !e.connected) return { text: "Waiting for your approval", tone: "warn" };
  if (e.connected && e.needsReconnect) return { text: "Needs reconnect", tone: "warn" };
  if (e.connected) return { text: e.account ? `Connected · ${e.account}` : "Connected", tone: "ok" };
  return { text: "Not connected", tone: "off" };
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

function logoFor(e) {
  const box = el("span", "app-logo");
  const mark = e.provider ? markFor(e.provider) : null;
  if (mark) box.append(mark);
  else { box.classList.add("letter"); box.textContent = (/[\p{L}\p{N}]/u.exec(String(e.name || "")) || ["?"])[0].toUpperCase(); }
  box.setAttribute("aria-hidden", "true");
  return box;
}

/** Renders `entries` into `body`. Safe to call again with fresh entries; keeps nothing between calls. */
export function renderEntries(body, entries, handlers = {}) {
  body.replaceChildren();
  if (!entries.length) { body.append(el("p", "apps-empty", "Nothing here yet.")); return; }
  for (const e of entries) {
    const st = statusOf(e);
    const row = el("div", "app-row"); row.dataset.app = e.id;
    const main = el("div", "app-main");
    main.append(el("div", "app-name", e.name));
    const sub = el("div", `app-state is-${st.tone}`, st.text); sub.setAttribute("role", "status");
    main.append(sub);
    if (Array.isArray(e.tags) && e.tags.length) {
      const tags = el("div", "app-tags");
      for (const t of e.tags) if (t && t.text) tags.append(el("span", `app-tag${t.tone ? ` is-${t.tone}` : ""}`, t.text));
      main.append(tags);
    }
    if (e.blurb) main.append(el("div", "app-blurb", e.blurb));
    const actions = el("div", "app-actions");
    const btn = el("button", e.connected && !e.needsReconnect ? "btn-quiet app-btn" : "btn-primary app-btn");
    btn.type = "button";
    btn.textContent = e.unavailable ? "Unavailable" : e.connected ? (e.needsReconnect ? "Reconnect" : (e.removeLabel || "Disconnect")) : e.waiting ? "Review" : "Connect";
    btn.disabled = !!e.unavailable;
    btn.setAttribute("aria-label", `${btn.textContent} ${e.name}`);
    if (e.connected && !e.needsReconnect && handlers.onManage) {
      const manage = el("button", "btn-quiet app-btn", "Manage"); manage.type = "button";
      manage.setAttribute("aria-label", `Manage ${e.name}`);
      manage.addEventListener("click", () => handlers.onManage(e));
      actions.append(manage);
    }
    actions.append(btn);
    row.append(logoFor(e), main, actions);
    const confirm = el("div", "app-confirm"); confirm.hidden = true;
    const ctl = {
      busy(on) { btn.disabled = on || !!e.unavailable; if (on) { btn.dataset.label = btn.textContent; btn.textContent = "Working…"; } else if (btn.dataset.label) { btn.textContent = btn.dataset.label; delete btn.dataset.label; } },
      say(text, tone) { sub.textContent = text; sub.className = `app-state is-${tone || "warn"}`; },
    };
    btn.addEventListener("click", () => {
      if (e.connected && !e.needsReconnect) {
        confirm.replaceChildren();
        confirm.append(el("p", "", handlers.confirmText ? handlers.confirmText(e) : `Disconnect ${e.name}? Anything already synced to MIND stays.`));
        const r = el("div", "row");
        const yes = el("button", "btn-danger solid", e.removeLabel || "Disconnect"); yes.type = "button";
        const no = el("button", "btn-quiet", "Keep it"); no.type = "button";
        yes.addEventListener("click", () => { confirm.hidden = true; handlers.onDisconnect && handlers.onDisconnect(e, ctl); });
        no.addEventListener("click", () => { confirm.hidden = true; btn.focus(); });
        r.append(yes, no); confirm.append(r); confirm.hidden = false; no.focus();
      } else handlers.onConnect && handlers.onConnect(e, ctl);
    });
    body.append(row, confirm);
  }
}

export function initApps(ctx) {
  const { api, signOut } = ctx;
  // Like the app's json(), but a failure carries MIND's plain-English message instead of a bare error code.
  const json = async (path, opts) => {
    const res = await api(path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
    return body;
  };
  const $ = (id) => document.getElementById(id);
  const q = { open: $("btn-apps"), card: $("apps-modal"), close: $("apps-close"), list: $("apps-sections"), live: $("apps-live") };
  if (!q.open || !q.card) return { open() {}, close() {}, refresh() {}, addSection() {}, say() {}, suspend() { return false; }, resume() {} };
  const sections = new Map();
  let isOpen = false, suspended = false, lastFocus = null, token = 0;
  const bc = typeof BroadcastChannel === "function" ? new BroadcastChannel("daebot-apps") : null;

  function say(text) { q.live.textContent = text || ""; q.live.hidden = !text; }

  async function loadSection(s) {
    const mine = ++s.token;
    s.body.setAttribute("aria-busy", "true");
    if (!s.loaded) { s.body.replaceChildren(el("p", "apps-empty", "Loading…")); }
    try {
      let out = await s.def.load();
      if (mine !== s.token) return;
      if (Array.isArray(out)) out = { entries: out };
      s.loaded = true;
      s.root.hidden = !!out.hidden;
      s.noteEl.hidden = !(out.message || s.def.note);
      s.noteEl.textContent = out.message || s.def.note || "";
      if (out.signIn) {
        s.body.replaceChildren();
        const row = el("div", "apps-signin");
        row.append(el("p", "", out.message || "Sign in with MIND to connect apps."));
        if (signOut) { const b = el("button", "btn-primary", "Sign in with MIND"); b.type = "button"; b.addEventListener("click", () => signOut()); row.append(b); }
        s.body.append(row);
      } else { s.entries = out.entries || []; paint(s); }
    } catch (err) {
      if (mine !== s.token) return;
      s.body.replaceChildren();
      const row = el("div", "apps-signin");
      row.append(el("p", "", err && err.message ? err.message : "Could not load this section."));
      const b = el("button", "btn-quiet", "Try again"); b.type = "button"; b.addEventListener("click", () => loadSection(s)); row.append(b);
      s.body.append(row);
    } finally { if (mine === s.token) s.body.removeAttribute("aria-busy"); }
  }

  // Draws a section's entries, narrowed by its search box when it has one.
  function paint(s) {
    const needle = s.search ? s.search.value.trim().toLowerCase() : "";
    const all = s.entries || [];
    const shown = needle ? all.filter((e) => [e.name, e.blurb, ...(e.tags || []).map((t) => t.text)].join(" ").toLowerCase().includes(needle)) : all;
    renderEntries(s.body, shown, s.def.handlers || {});
    if (needle && !shown.length) s.body.replaceChildren(el("p", "apps-empty", `Nothing matches "${s.search.value.trim().slice(0, 40)}".`));
    if (s.count) s.count.textContent = all.length ? (needle ? `${shown.length} of ${all.length}` : `${all.length}`) : "";
  }

  function addSection(def) {
    if (sections.has(def.id)) return;
    const root = el("section", "apps-sec"); root.dataset.sec = def.id;
    const h = el("h3", "", def.title); h.id = `apps-h-${def.id}`;
    const noteEl = el("p", "apps-note"); noteEl.hidden = true;
    const body = el("div", "apps-body"); body.setAttribute("role", "group"); body.setAttribute("aria-labelledby", h.id);
    const s = { def, root, body, noteEl, token: 0, loaded: false };
    root.append(h, noteEl);
    if (def.search) {
      const bar = el("div", "apps-search");
      const inp = document.createElement("input");
      inp.type = "search"; inp.className = "fld"; inp.placeholder = def.search; inp.autocomplete = "off"; inp.spellcheck = false;
      inp.setAttribute("aria-label", def.search); inp.id = `apps-q-${def.id}`;
      const count = el("span", "apps-count"); count.setAttribute("aria-live", "polite");
      inp.addEventListener("input", () => paint(s));
      bar.append(inp, count); root.append(bar);
      s.search = inp; s.count = count;
    }
    root.append(body);
    q.list.append(root);
    sections.set(def.id, s);
    if (isOpen) loadSection(s);
  }

  function refresh() { if (suspended) return; for (const s of sections.values()) loadSection(s); }

  function open() {
    if (isOpen) return;
    isOpen = true; lastFocus = document.activeElement;
    q.card.hidden = false; q.open.setAttribute("aria-expanded", "true");
    say(""); refresh(); q.close.focus();
  }
  // The MCP consent card hides this card instead of stacking on top of it: one layer on screen, and no Close button peeking out.
  function suspend() { if (!isOpen || suspended) return false; suspended = true; q.card.hidden = true; return true; }
  function resume() { if (!suspended) return; suspended = false; if (!isOpen) return; q.card.hidden = false; refresh(); q.close.focus(); }
  function close() {
    if (!isOpen) return;
    suspended = false;
    isOpen = false; q.card.hidden = true; q.open.setAttribute("aria-expanded", "false");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  q.open.addEventListener("click", () => (isOpen ? close() : open()));
  q.close.addEventListener("click", close);
  q.card.addEventListener("click", (e) => { if (e.target === q.card) close(); });
  document.addEventListener("keydown", (e) => {
    if (!isOpen || suspended) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "Tab") { // keep focus inside the card
      const f = [...q.card.querySelectorAll("button:not([disabled]), a[href]")].filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, true);

  // Back from the provider's consent page: statuses are re-read from MIND.
  const back = () => { if (isOpen && !suspended && document.visibilityState === "visible") refresh(); };
  window.addEventListener("focus", back);
  document.addEventListener("visibilitychange", back);
  if (bc) bc.onmessage = (m) => { if (m.data && m.data.type === "connected") { if (!isOpen) open(); else refresh(); say(m.data.provider ? `Connected ${m.data.name || m.data.provider}.` : "Connected."); } };

  // The tab MIND bounces to after approval is a full Daebot page: hand the news to the first tab and close.
  {
    const u = new URL(location.href);
    const connected = u.searchParams.get("connected"), failed = u.searchParams.get("error");
    if (connected || failed) {
      u.searchParams.delete("connected"); u.searchParams.delete("error"); u.searchParams.delete("scopes_kept");
      history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
      if (connected && bc) {
        try { bc.postMessage({ type: "connected", provider: connected.slice(0, 40) }); } catch { /* best effort */ }
        try { window.close(); } catch { /* not a script-opened tab */ }
      }
      setTimeout(() => { open(); say(connected ? "Connected. Your apps are up to date." : "That app did not connect. Try again."); }, 400);
    }
  }

  // ---- Section 1: MIND integrations ----
  const toEntry = (p) => ({
    id: p.provider, provider: p.provider, name: p.name, blurb: p.blurb, connected: p.connected, needsReconnect: p.needsReconnect,
    account: p.account, auth: p.auth, unavailable: !p.connected && p.auth === "oauth" && !p.configured, note: "Not set up at MIND yet",
  });
  async function openWindow(url, pre) {
    if (pre && !pre.closed) { pre.location.href = url; return; }
    const w = window.open(url, "_blank");
    if (!w) location.href = url; // pop-up blocked: MIND bounces back here when done
  }
  addSection({
    id: "integrations", title: "MIND integrations",
    async load() {
      const r = await json("/apps/integrations");
      if (r.signedIn === false) return { signIn: true, message: r.message };
      if (r.enabled === false) return { entries: [], message: "Integrations are turned off on this MIND server." };
      return { entries: (r.providers || []).map(toEntry) };
    },
    handlers: {
      async onConnect(e, ctl) {
        ctl.busy(true);
        const pre = e.auth === "credentials" ? null : window.open("", "_blank"); // opened inside the click so the pop-up blocker allows it
        try {
          const r = await json(`/apps/integrations/${encodeURIComponent(e.id)}/connect`, { method: "POST", body: "{}" });
          if (r.authType === "credentials") { if (pre) pre.close(); await openWindow(r.setupUrl, null); say(`Finish ${e.name} setup in MIND, then come back.`); }
          else { await openWindow(r.authUrl, pre); say(`Approve ${e.name} in the new tab, then come back here.`); }
        } catch (err) { if (pre) pre.close(); ctl.say(err && err.message ? err.message : `Could not start ${e.name}.`, "warn"); }
        finally { ctl.busy(false); }
      },
      async onDisconnect(e, ctl) {
        ctl.busy(true);
        try { await json(`/apps/integrations/${encodeURIComponent(e.id)}/disconnect`, { method: "POST", body: "{}" }); say(`Disconnected ${e.name}.`); await loadSection(sections.get("integrations")); }
        catch (err) { ctl.busy(false); ctl.say(err && err.message ? err.message : `Could not disconnect ${e.name}.`, "warn"); }
      },
    },
  });

  return { open, close, refresh, addSection, say, renderEntries, suspend, resume };
}
