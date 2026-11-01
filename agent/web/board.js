// Task board drawer: a right-side pop-out (a sibling of the violations drawer) that shows every task Daebot is working on,
// across all of the signed-in user's sessions, as the same traffic-light boxes the Astra AI client portal uses.
// red = not started, yellow = in progress, green = ready to test. In Daebot red ALSO means STOPPED: Daebot is waiting on
// the user for a question or a decision. A stopped row opens into a small reply box; Submit sends the reply into THAT session.
// Each card also shows where the task lives: a scope chip (Astra AI or MIND), its MIND LIFE project, and, when a choice was involved, a Decision
// link that opens the OOC/EMR document. A card can be cancelled (kept as history) or deleted (from the board and from MIND, after a confirm).
// The list can be filtered by scope and by project. All dynamic text goes through textContent. No innerHTML.

/** Colors and labels copied from the client portal's TodoStatusBox. "stopped" is the same red with its own label. */
export const LIGHTS = {
  not_started: { label: "Not started", cls: "red" },
  in_progress: { label: "In progress", cls: "yellow" },
  ready_to_test: { label: "Ready to test", cls: "green" },
  stopped: { label: "Waiting on you", cls: "red" },
  cancelled: { label: "Cancelled", cls: "grey" },
};
export const SCOPES = { astra: "Astra AI", mind: "MIND" };
export const light = (status) => LIGHTS[status] || LIGHTS.not_started;
/** A stopped row raised by a peer request reads "Awaiting decision" (same red). */
export const labelOf = (r) => (r && r.peer && r.status === "stopped" ? "Awaiting decision" : light(r && r.status).label);

export const REFRESH_MS = 10000;

/** Rows come flat from GET /board; the drawer shows them under their session. Sessions that wait on the user come first. */
export function groupRows(rows) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.sessionId !== "string") continue;
    if (!by.has(r.sessionId)) by.set(r.sessionId, { sessionId: r.sessionId, title: r.sessionTitle || "Untitled", rows: [] });
    by.get(r.sessionId).rows.push(r);
  }
  const groups = [...by.values()];
  const waiting = (g) => g.rows.some((r) => r.status === "stopped");
  return [...groups.filter(waiting), ...groups.filter((g) => !waiting(g))];
}

export const stoppedCount = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && r.status === "stopped").length;

/** Keeps the rows that match the scope ("all" | "astra" | "mind") and the project id ("all" or a LIFE project id). */
export function filterRows(rows, f) {
  const scope = (f && f.scope) || "all", project = (f && f.project) || "all";
  return (Array.isArray(rows) ? rows : []).filter((r) => r && (scope === "all" || r.scope === scope) && (project === "all" || (r.project && r.project.id === project)));
}
/** The projects present on the board, for the project filter (limited to the chosen scope). */
export function projectsOf(rows, scope) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) if (r && r.project && r.project.id && (!scope || scope === "all" || r.scope === scope)) by.set(r.project.id, r.project.name);
  return [...by].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
export const rowKey = (r) => `${r.sessionId}\u0000${r.id}`;

/** Enter submits, Shift+Enter is a new line (and an IME composition never submits). */
export function submitsOnKey(e) {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing;
}

export function initBoard({ json, h, els, app }) {
  const st = { rows: [], open: false, timer: null, loading: false, expanded: new Set(), drafts: new Map(), sending: new Set(), errors: new Map(), deferred: false, loaded: false, failed: "", filter: { scope: "all", project: "all" }, confirmDelete: null, acting: new Set() };

  function setCount(n) { els.count.hidden = n === 0; els.count.textContent = String(n); els.btn.setAttribute("aria-label", n ? `Task board, ${n} waiting on you` : "Task board"); }

  async function load() {
    if (st.loading) return;
    st.loading = true;
    try {
      const out = await json("/board");
      st.rows = Array.isArray(out.tasks) ? out.tasks : [];
      st.loaded = true; st.failed = "";
    } catch (e) {
      if (e && e.message === "unauthorized") return;
      st.failed = (e && e.message) || "failed";
    } finally { st.loading = false; }
    setCount(stoppedCount(st.rows));
    if (st.open) render();
  }

  function box(status) {
    const l = light(status);
    const b = h("span", `bd-box ${l.cls}`);
    b.dataset.status = status;
    b.setAttribute("aria-hidden", "true");
    if (status === "ready_to_test") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 12 12"); svg.setAttribute("width", "12"); svg.setAttribute("height", "12");
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", "M2.5 6.5l2.4 2.4L9.5 3.6"); p.setAttribute("fill", "none"); p.setAttribute("stroke", "#fff");
      p.setAttribute("stroke-width", "2.2"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
      svg.append(p); b.append(svg);
    }
    return b;
  }

  function taskRow(r) {
    const key = rowKey(r);
    const li = h("li", `bd-task ${light(r.status).cls}`);
    li.dataset.status = r.status;
    const stopped = r.status === "stopped";
    const open = stopped && st.expanded.has(key);
    const head = h(stopped ? "button" : "div", "bd-row");
    if (stopped) { head.type = "button"; head.setAttribute("aria-expanded", String(open)); }
    const text = h("span", "bd-text");
    text.append(h("span", "bd-title", r.title));
    if (stopped && r.question && !open) text.append(h("span", "bd-q", r.question));
    let peerChips = null;
    if (r.peer) {
      const chips = h("span", "bd-decisions");
      for (const [role, id] of [["requester", r.peer.issuer], ["receiver", r.peer.receiver]]) {
        const a = h("a", `bd-decision ${role}`, `Decision ✓ ${String(id).length > 14 ? `${String(id).slice(0, 8)}…${String(id).slice(-4)}` : id}`);
        a.href = "https://m-i-n-d.ai/documents"; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.title = `${role === "receiver" ? "Receiver" : "Requester"} OOC/EMR decision record (MIND document ${id})`; a.dataset.decision = id;
        a.addEventListener("click", (e) => { e.stopPropagation(); try { navigator.clipboard.writeText(id); } catch { /* clipboard blocked */ } });
        chips.append(a);
      }
      peerChips = chips;
    }
    head.append(box(r.status), text, h("span", "bd-label", labelOf(r)));
    li.append(head);
    const meta = metaLine(r);
    if (meta) li.append(meta);
    if (peerChips) li.append(peerChips);
    li.append(actions(r, key));
    if (stopped) {
      head.addEventListener("click", () => {
        if (st.expanded.has(key)) st.expanded.delete(key); else st.expanded.add(key);
        render();
        if (st.expanded.has(key)) { const ta = els.list.querySelector(`textarea[data-key="${CSS.escape(key)}"]`); if (ta) ta.focus(); }
      });
    }
    if (open) li.append(replyForm(r, key));
    return li;
  }

  /** Scope chip, LIFE project, Decision link, and a plain note when the MIND side is not in step. */
  function metaLine(r) {
    const wrap = h("div", "bd-meta");
    if (r.scope && SCOPES[r.scope]) { const c = h("span", `bd-chip scope-${r.scope}`, SCOPES[r.scope]); c.title = `${SCOPES[r.scope]} task, from the MIND Focus its project sits under`; wrap.append(c); }
    if (r.project && r.project.name) { const c = h("span", "bd-chip project", r.project.name); c.title = r.project.focus ? `MIND LIFE project, in the Focus ${r.project.focus}` : "MIND LIFE project"; wrap.append(c); }
    const d = r.decision;
    if (d && d.id) {
      if (d.local) { const c = h("span", "bd-chip decision-local", `Decision: ${d.winner} (not saved in MIND)`); wrap.append(c); }
      else {
        const a = h("a", "bd-chip decision", `Decision: ${d.winner}`);
        a.href = `/board/decision/${encodeURIComponent(d.id)}`; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.title = `OOC/EMR decision for this task. Opens the private document from your MIND (${d.subject || "decision"})`; a.dataset.decision = d.id;
        a.addEventListener("click", (e) => e.stopPropagation());
        wrap.append(a);
      }
    }
    if (r.sync) { const c = h("span", "bd-chip warn", r.sync); wrap.append(c); }
    return wrap.childNodes.length ? wrap : null;
  }

  /** Cancel (kept as history, tagged in MIND) and Delete (board and MIND; asks first). */
  function actions(r, key) {
    const wrap = h("div", "bd-actions");
    const busy = st.acting.has(key);
    if (st.confirmDelete === key) {
      const q = h("span", "bd-confirm", r.lifeId ? "Delete this task from the board and from MIND?" : "Delete this task from the board?");
      const yes = h("button", "bd-act danger", busy ? "Deleting…" : "Delete"); yes.type = "button"; yes.disabled = busy; yes.dataset.act = "confirm-delete";
      yes.addEventListener("click", (e) => { e.stopPropagation(); void act(r, key, "delete"); });
      const no = h("button", "bd-act", "Keep"); no.type = "button"; no.disabled = busy; no.dataset.act = "keep";
      no.addEventListener("click", (e) => { e.stopPropagation(); st.confirmDelete = null; render(); });
      wrap.append(q, yes, no);
    } else {
      if (r.status !== "cancelled") {
        const c = h("button", "bd-act", busy ? "Cancelling…" : "Cancel"); c.type = "button"; c.disabled = busy; c.dataset.act = "cancel";
        c.title = "Stop this task and keep it in history (also marked cancelled in MIND)";
        c.addEventListener("click", (e) => { e.stopPropagation(); void act(r, key, "cancel"); });
        wrap.append(c);
      }
      const d = h("button", "bd-act", "Delete"); d.type = "button"; d.disabled = busy; d.dataset.act = "delete";
      d.title = "Remove this task from the board and from MIND";
      d.addEventListener("click", (e) => { e.stopPropagation(); st.confirmDelete = key; render(); });
      wrap.append(d);
    }
    const err = st.errors.get("act:" + key);
    if (err) { const p = h("p", "bd-err", err); p.setAttribute("role", "alert"); wrap.append(p); }
    return wrap;
  }

  async function act(r, key, what) {
    if (st.acting.has(key)) return;
    st.acting.add(key); st.errors.delete("act:" + key); render();
    const url = `/board/tasks/${encodeURIComponent(r.sessionId)}/${encodeURIComponent(r.id)}`;
    try {
      if (what === "cancel") await json(`${url}/cancel`, { method: "POST", body: "{}" });
      else await json(url, { method: "DELETE" });
      st.confirmDelete = null; st.acting.delete(key);
      await load();
    } catch (e) {
      st.acting.delete(key);
      if (!(e && e.message === "unauthorized")) st.errors.set("act:" + key, (e && e.message) || `Could not ${what} the task.`);
      render();
    }
  }

  /** Scope and project filters above the list. */
  function renderFilters() {
    if (!els.filters) return;
    els.filters.replaceChildren();
    if (!st.rows.length) { els.filters.hidden = true; return; }
    els.filters.hidden = false;
    const mk = (label, value, options, onChange) => {
      const sel = h("select", "bd-filter"); sel.setAttribute("aria-label", label);
      for (const [v, t] of options) { const o = h("option", "", t); o.value = v; sel.append(o); }
      sel.value = options.some(([v]) => v === value) ? value : options[0][0];
      sel.addEventListener("change", () => onChange(sel.value));
      return sel;
    };
    const projects = projectsOf(st.rows, st.filter.scope);
    if (st.filter.project !== "all" && !projects.some((p) => p.id === st.filter.project)) st.filter.project = "all";
    els.filters.append(
      mk("Filter by scope", st.filter.scope, [["all", "All scopes"], ["astra", "Astra AI"], ["mind", "MIND"]], (v) => { st.filter.scope = v; render(); }),
      mk("Filter by project", st.filter.project, [["all", "All projects"], ...projects.map((p) => [p.id, p.name])], (v) => { st.filter.project = v; render(); }),
    );
  }

  function replyForm(r, key) {
    const form = h("form", "bd-reply");
    const q = h("p", "bd-qfull", r.question || "Daebot is waiting for your reply.");
    const ta = h("textarea", "bd-input");
    ta.rows = 2; ta.dataset.key = key; ta.placeholder = "Type your reply"; ta.setAttribute("aria-label", `Reply to: ${r.title}`);
    ta.value = st.drafts.get(key) || "";
    ta.addEventListener("input", () => { st.drafts.set(key, ta.value); });
    ta.addEventListener("keydown", (e) => { if (submitsOnKey(e)) { e.preventDefault(); form.requestSubmit(); } });
    ta.addEventListener("blur", () => { if (st.deferred) { st.deferred = false; setTimeout(() => { if (!els.list.contains(document.activeElement)) render(); }, 0); } });
    const btn = h("button", "bd-submit", st.sending.has(key) ? "Sending…" : "Submit");
    btn.type = "submit"; btn.disabled = st.sending.has(key);
    const err = st.errors.get(key);
    form.append(q, ta, btn);
    if (err) { const p = h("p", "bd-err", err); p.setAttribute("role", "alert"); form.append(p); }
    form.addEventListener("submit", (e) => { e.preventDefault(); void submit(r, key, ta.value); });
    return form;
  }

  async function submit(r, key, raw) {
    const text = String(raw || "").trim();
    if (!text || st.sending.has(key)) return;
    st.sending.add(key); st.errors.delete(key);
    // Optimistic: the row turns yellow at once; the server does the same when the turn starts.
    const prev = st.rows.map((x) => ({ ...x }));
    st.rows = st.rows.map((x) => (rowKey(x) === key ? { ...x, status: "in_progress", question: undefined } : x));
    st.drafts.delete(key); st.expanded.delete(key);
    if (document.activeElement && els.list.contains(document.activeElement)) document.activeElement.blur(); // a focused box would hold the redraw back
    setCount(stoppedCount(st.rows)); render();
    try {
      await app.reply(r.sessionId, text);
      st.sending.delete(key);
      setTimeout(load, 1200); // let the server's own view (the turn has started) replace the optimistic one
    } catch (e) {
      st.sending.delete(key);
      st.rows = prev; st.drafts.set(key, text); st.expanded.add(key); st.errors.set(key, (e && e.message) || "Could not send the reply.");
      setCount(stoppedCount(st.rows)); render();
    }
  }

  function render() {
    // Never rebuild under the user's cursor: a refresh while they type waits until the box loses focus.
    const a = document.activeElement;
    if (a && a.tagName === "TEXTAREA" && els.list.contains(a)) { st.deferred = true; return; }
    renderFilters();
    const shown = filterRows(st.rows, st.filter);
    const groups = groupRows(shown);
    const waiting = stoppedCount(st.rows);
    els.note.textContent = st.failed && !st.loaded ? `Could not load the board: ${st.failed}`
      : !st.rows.length ? "Nothing on the board yet. When Daebot starts real work for you, it shows up here and in your MIND LIFE."
      : !groups.length ? "No tasks match this filter."
      : waiting ? `${waiting} waiting on you. Click a red item to reply.` : "Red: not started or waiting on you. Yellow: in progress. Green: ready to test. Grey: cancelled.";
    els.list.replaceChildren();
    for (const g of groups) {
      const sec = h("section", "bd-sess");
      const head = h("button", "bd-sess-title", g.title);
      head.type = "button"; head.title = "Open this session";
      head.addEventListener("click", () => { app.openSession(g.sessionId); });
      const ul = h("ul", "bd-tasks");
      for (const r of g.rows) ul.append(taskRow(r));
      sec.append(head, ul);
      els.list.append(sec);
    }
  }

  function isOpen() { return st.open; }
  function setOpen(on) {
    if (on === st.open) return;
    st.open = on;
    els.drawer.hidden = !on;
    els.btn.setAttribute("aria-expanded", String(on));
    clearInterval(st.timer); st.timer = null;
    if (on) {
      app.closeOthers();
      render(); load();
      st.timer = setInterval(load, REFRESH_MS);
    }
  }
  els.btn.addEventListener("click", () => setOpen(!st.open));
  els.close.addEventListener("click", () => setOpen(false));

  return {
    isOpen, close: () => setOpen(false), refresh: load,
    /** A run event that can change the board (a tool finished, a turn ended): refresh now if the drawer is open. */
    poke() { if (st.open) void load(); },
  };
}
