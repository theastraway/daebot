// Shared threads, web side. Someone adds other MIND people to one of their threads (Share thread in a row's menu); the thread then shows up for those
// people under "Shared Threads" in their own sidebar, and they read and post in it from their own login. The server does all the deciding
// (src/gateway/shared-threads.ts); this file draws the section and the share dialog.
// Pure helpers are exported and unit tested. DOM is createElement and textContent only.

export const SEEN_KEY = "daebot.shared.seen";
export const SENDER_MARK = /^⟦([^⟧\n]{1,60})⟧ /;

/** The name a guest's message carries (the server puts it in front of the text) and the words without it. */
export function parseSender(text) {
  const t = typeof text === "string" ? text : "";
  const m = SENDER_MARK.exec(t);
  return m ? { name: m[1], text: t.slice(m[0].length) } : { name: "", text: t };
}

export const roleLabel = (role) => (role === "viewer" ? "View only" : "Can post");
export const roleHint = (role) => (role === "viewer" ? "You can read this thread." : "You can read and post in this thread.");

/** What a row in the sidebar reads under the title: "from alice · Atlas bot · 5 min ago". */
export function sharedMeta(t, ago) {
  const who = t.owner && (t.owner.label || t.owner.username);
  return [who ? `from ${who}` : "", t.botName || "", typeof ago === "function" && t.updatedAt ? ago(t.updatedAt) : "", t.role === "viewer" ? "view only" : ""].filter(Boolean).join(" · ");
}

/** A thread as the rest of the app knows a chat row (so opening, history and sending work as they do for any chat). */
export function asRow(t) {
  return { id: t.id, title: t.title || "Untitled", surface: "shared", updatedAt: t.updatedAt || 0, live: false, busy: !!t.busy, shared: { owner: t.owner, role: t.role, botName: t.botName || "" }, unread: false };
}

/** Which of these threads this browser has not been told about yet. */
export function unseenThreads(threads, seen) {
  const s = seen instanceof Set ? seen : new Set(seen || []);
  return (threads || []).filter((t) => !s.has(t.id));
}

export function readSeen(storage) {
  try { const v = JSON.parse(storage.getItem(SEEN_KEY) || "null"); return Array.isArray(v) ? new Set(v.filter((x) => typeof x === "string")) : null; } catch { return null; }
}
export function writeSeen(storage, ids) {
  try { storage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-300))); } catch { /* private mode: the notice may repeat, nothing breaks */ }
}

/**
 * createSharedThreads({ json, h, icon, ago, notify, onOpen, onChange }) ->
 *   { refresh(), threads(), find(id), renderInto(host), openShare(row), forget(id) }
 *   json(path, opts): the app's JSON fetch (throws Error(message) on a failed status)
 *   notify(text): a line in the chat. onOpen(row): open a shared thread (same as clicking a chat row). onChange(): the list changed, redraw the sidebar.
 */
export function createSharedThreads({ json, h, icon, ago, notify, onOpen, onChange, storage = (typeof localStorage !== "undefined" ? localStorage : null) }) {
  let list = [];
  let loaded = false;
  let flight = null;

  async function refresh() {
    if (flight) return flight;
    flight = (async () => {
      let r;
      try { r = await json("/shared-threads"); } catch (e) { return list; } // not signed in / MIND hiccup: the list on screen stays
      const next = Array.isArray(r.threads) ? r.threads : [];
      const seen = storage ? readSeen(storage) : null;
      const fresh = seen === null ? [] : unseenThreads(next, seen); // the first time on a browser nothing is "new"
      list = next;
      if (storage) writeSeen(storage, new Set([...(seen || []), ...next.map((t) => t.id)]));
      for (const t of fresh) {
        const who = t.owner && (t.owner.label || t.owner.username);
        notify(`${who || "Someone"} shared a thread with you: "${t.title}". It is under Shared Threads.`);
        t.isNew = true;
      }
      loaded = true;
      onChange && onChange();
      return list;
    })().finally(() => { flight = null; });
    return flight;
  }

  function row(t, { current }) {
    const b = h("button", "sess shared"); b.type = "button"; b.dataset.sid = t.id;
    if (current === t.id) b.setAttribute("aria-current", "true");
    if (t.isNew || t.unread) { b.classList.add("unread"); b.title = "New"; }
    const title = h("span", "sess-t");
    const ic = icon("i-users"); ic.classList.add("sess-pin"); ic.setAttribute("aria-hidden", "true");
    title.append(ic, document.createTextNode(t.title || "Untitled"));
    const meta = h("span", "sess-m", sharedMeta(t, ago));
    if (t.busy) { meta.append(h("span", "", " · "), h("span", "live", "working")); }
    b.append(title, meta);
    b.addEventListener("click", () => { t.isNew = false; onOpen(asRow(t)); });
    const wrap = h("div", "sess-row"); wrap.append(b);
    return wrap;
  }

  /** Appends the "Shared Threads" section (nothing when no thread is shared with this person). */
  function renderInto(host, { current } = {}) {
    if (!list.length) return;
    const sec = h("section", "env-group shared-threads"); sec.setAttribute("aria-label", "Shared Threads");
    const head = h("div", "env-head static");
    const ic = icon("i-users"); ic.classList.add("env-kind"); ic.setAttribute("aria-hidden", "true");
    head.append(ic, h("span", "env-name", "Shared Threads"), h("span", "env-count", String(list.length)));
    const body = h("div", "env-rows");
    for (const t of list) body.append(row(t, { current }));
    sec.append(head, body);
    host.append(sec);
  }

  // ---- the share dialog (owner side) ----
  let dlg = null;
  async function openShare(s) {
    if (dlg) dlg.close();
    const back = h("div", "gate-token modal"); back.id = "share-modal";
    const card = h("div", "token-card bot-card sh-card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-labelledby", "share-title");
    const title = h("h2", "", "Share this thread"); title.id = "share-title";
    const sub = h("p", "sh-sub"); sub.textContent = `"${s.title || "Untitled"}". The people you add open it from their own Daebot login under Shared Threads, and can read and post. The bot answers them as it answers you, on your account. They never see your other threads, bots, files or memory.`;
    const input = h("input", "sh-input"); input.type = "search"; input.placeholder = "Search MIND people by username or email"; input.autocomplete = "off"; input.spellcheck = false; input.setAttribute("aria-label", "Search MIND people");
    const found = h("div", "sh-found"); found.setAttribute("role", "listbox");
    const msg = h("div", "sh-msg"); msg.setAttribute("aria-live", "polite");
    const mh = h("h3", "sh-h", "On this thread");
    const members = h("div", "sh-members");
    const close = h("button", "btn-quiet", "Done"); close.type = "button";
    const rowEl = h("div", "row"); rowEl.append(close);
    card.append(title, sub, input, found, msg, mh, members, rowEl);
    back.append(card);
    const prev = document.activeElement;
    const api = { close() { document.removeEventListener("keydown", onKey, true); back.remove(); dlg = null; try { prev && prev.focus && prev.focus(); } catch { /* gone */ } } };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); api.close(); } };
    close.addEventListener("click", () => api.close());
    back.addEventListener("click", (e) => { if (e.target === back) api.close(); });
    document.addEventListener("keydown", onKey, true);
    dlg = api;
    document.body.append(back);
    input.focus();

    const say = (t, bad) => { msg.textContent = t || ""; msg.classList.toggle("bad", !!bad); };
    const base = `/sessions/${encodeURIComponent(s.id)}/members`;
    let have = [];
    const drawMembers = () => {
      members.replaceChildren();
      if (!have.length) { members.append(h("div", "sh-none", "Only you, so far.")); return; }
      for (const m of have) {
        const r = h("div", "sh-member");
        r.append(h("span", "sh-name", m.label && m.label !== m.username ? `${m.label} (${m.username})` : m.username));
        const sel = h("select", "sh-role"); sel.setAttribute("aria-label", `What ${m.username} can do`);
        for (const v of ["editor", "viewer"]) { const o = h("option", "", roleLabel(v)); o.value = v; if (v === m.role) o.selected = true; sel.append(o); }
        sel.addEventListener("change", async () => { try { have = (await json(base, { method: "POST", body: JSON.stringify({ username: m.username, role: sel.value }) })).members; say(`${m.username} is now ${roleLabel(sel.value).toLowerCase()}.`); } catch (e) { say(e.message, true); } drawMembers(); });
        const rm = h("button", "btn-quiet sh-rm", "Remove"); rm.type = "button";
        rm.addEventListener("click", async () => { rm.disabled = true; try { have = (await json(`${base}/${encodeURIComponent(m.username)}`, { method: "DELETE" })).members; say(`${m.username} can no longer open this thread.`); } catch (e) { say(e.message, true); } drawMembers(); });
        r.append(sel, rm);
        members.append(r);
      }
    };
    try { have = (await json(base)).members || []; } catch (e) { say(e.message, true); }
    drawMembers();

    let timer = 0, seq = 0;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      found.replaceChildren();
      if (q.length < 2) return;
      const mine = ++seq;
      timer = setTimeout(async () => {
        let users = [];
        try { users = (await json(`/shared-threads/search?q=${encodeURIComponent(q)}`)).users || []; } catch (e) { if (mine === seq) say(e.message, true); return; }
        if (mine !== seq) return;
        found.replaceChildren();
        const free = users.filter((u) => !have.some((m) => m.username === u.username));
        if (!free.length) { found.append(h("div", "sh-none", users.length ? "Already on this thread." : "No MIND person by that name. Use their username or the email on their account.")); return; }
        for (const u of free) {
          const b = h("button", "sh-pick"); b.type = "button"; b.setAttribute("role", "option");
          b.append(h("span", "sh-name", u.label && u.label !== u.username ? `${u.label} (${u.username})` : u.username), h("span", "sh-add", "Add"));
          b.addEventListener("click", async () => {
            b.disabled = true;
            try { have = (await json(base, { method: "POST", body: JSON.stringify({ username: u.username, role: "editor" }) })).members; say(`${u.username} was added. They were notified in MIND.`); input.value = ""; found.replaceChildren(); drawMembers(); }
            catch (e) { say(e.message, true); b.disabled = false; }
          });
          found.append(b);
        }
      }, 220);
    });
  }

  return { refresh, threads: () => list, find: (id) => list.find((t) => t.id === id), renderInto, openShare, forget(id) { list = list.filter((t) => t.id !== id); onChange && onChange(); } };
}
