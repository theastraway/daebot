// Permissions (web). Two pieces:
//   1. The permission card: shown in the thread when a tool call needs the user's answer. The turn is paused on the server until
//      a button here is pressed (Allow once / Always allow... / Deny / Always deny...). "Always..." opens scope choices that the
//      SERVER generated from the real call; this file only sends back the id of the one picked.
//   2. Settings > Permissions: mode, saved rules (edit / delete), and what Dae has learned from the user's refusals.
// DOM is built with createElement + textContent only. Everything in a card (commands, paths, URLs) is untrusted text.

const CLS_WORDS = { outward: "Reaches someone outside", irreversible: "Cannot be undone", public: "Posts publicly", write: "Changes something", read: "Reads" };

export function classWord(cls) { return CLS_WORDS[cls] || ""; }

/** The one-line summary left behind after a card is answered. */
export function outcomeText(outcome, remembered) {
  if (outcome === "allowed") return remembered ? `Always allowed: ${remembered}` : "Allowed once";
  if (outcome === "denied") return remembered ? `Always denied: ${remembered}` : "Denied";
  if (outcome === "expired") return "No answer in time, so it was skipped";
  return "Answered";
}

export function suggestText(s) {
  if (!s) return "";
  return s.effect === "deny"
    ? `You have said no to this ${s.count} times. Always deny this?`
    : `You have said yes to this ${s.count} times. Always allow this?`;
}

export const MODE_INFO = {
  risky: { name: "Ask for risky things", desc: "Cards for anything that reaches other people, deletes, pays or posts publicly. Everything else just runs." },
  writes: { name: "Also ask before changes", desc: "Also a card before Daebot runs a command, writes a file, or changes anything in your apps." },
  everything: { name: "Ask for everything", desc: "A card for every action except reading your own files and MIND." },
};

/** The per-chat choices in the composer. "default" = follow the account setting in Settings > Permissions. */
export const CHAT_MODES = [
  { id: "risky", name: "Ask for risky things", desc: "Cards only for anything that reaches other people, deletes, pays or posts publicly." },
  { id: "writes", name: "Ask before changes", desc: "Also a card before a command, a file change, or a change in your apps." },
  { id: "everything", name: "Ask for everything", desc: "A card for every action except reading your own files and MIND." },
  { id: "bypass", name: "Bypass permissions", desc: "No cards, no confirmations. Your own Always-deny rules still apply.", danger: true },
];

export function chatModeName(mode, accountMode) {
  const m = CHAT_MODES.find((x) => x.id === (mode || accountMode));
  return m ? m.name : "Ask for risky things";
}

export function ruleLine(r) {
  return `${r.effect === "allow" ? "Allow" : "Deny"} · ${r.tool} · ${r.scope}`;
}

/** The card. `it` = { id, tool, cls, title, detail, args, allowOptions, denyOptions, suggest, expiresAt, state, outcome, remembered }. */
export function buildPermissionCard(it, { json, h, notify, onChange }) {
  const card = h("div", "confirm perm");
  card.dataset.permId = it.id;
  const head = h("div", "perm-head");
  head.append(h("h3", "", it.title || "Permission needed"));
  const w = classWord(it.cls);
  if (w) head.append(h("span", `perm-cls ${it.cls}`, w));
  card.append(head);
  const rows = h("dl", "perm-rows");
  for (const d of it.detail || []) { rows.append(h("dt", "", d.label), h("dd", /^(Command|File|Folder|URL|Recipient|Tool)$/.test(d.label) ? "mono" : "", d.value)); }
  card.append(rows);
  if (it.args && Object.keys(it.args).length) {
    const det = document.createElement("details"); det.className = "perm-args";
    det.append(h("summary", "", "Exact details"));
    let txt; try { txt = JSON.stringify(it.args, null, 2); } catch { txt = String(it.args); }
    det.append(h("pre", "", txt));
    card.append(det);
  }
  const body = h("div", "perm-body");
  card.append(body);

  let busy = false;
  const done = (outcome, remembered) => { it.state = "resolved"; it.outcome = outcome; it.remembered = remembered; paint(); if (onChange) onChange(); };

  async function send(decision, remember, scope) {
    if (busy) return;
    busy = true; paint();
    try {
      const r = await json(`/permissions/${encodeURIComponent(it.id)}/decide`, { method: "POST", body: JSON.stringify({ decision, remember, ...(scope ? { scope } : {}) }) });
      const label = r.rule ? r.rule.scope : undefined;
      done(decision === "allow" ? "allowed" : "denied", label);
    } catch (e) {
      busy = false;
      if (/no such pending/i.test(String(e.message))) { done("expired"); return; }
      notify(`Could not send your answer: ${e.message}`);
      paint();
    }
  }

  let mode = "main"; // main | allow-scope | deny-scope
  let picked = "";
  function scopeChooser(effect) {
    const opts = effect === "allow" ? it.allowOptions : it.denyOptions;
    const box = h("div", "perm-scope");
    box.append(h("p", "perm-scope-title", effect === "allow" ? "Always allow, but only for:" : "Always deny, for:"));
    const list = h("div", "perm-scope-list"); list.setAttribute("role", "radiogroup");
    if (!picked || !opts.some((o) => o.id === picked)) picked = (it.suggest && it.suggest.effect === effect && opts.some((o) => o.id === it.suggest.optionId)) ? it.suggest.optionId : (opts[0] && opts[0].id) || "";
    for (const o of opts) {
      const lab = h("label", `perm-opt${o.broad ? " broad" : ""}`);
      const rb = document.createElement("input"); rb.type = "radio"; rb.name = `perm-${it.id}`; rb.value = o.id; rb.checked = o.id === picked;
      rb.addEventListener("change", () => { picked = o.id; });
      lab.append(rb, h("span", "", o.label));
      list.append(lab);
    }
    box.append(list);
    const act = h("div", "perm-actions");
    const go = h("button", effect === "allow" ? "btn-primary" : "btn-danger", effect === "allow" ? "Always allow this" : "Always deny this"); go.type = "button"; go.disabled = busy || !picked;
    go.addEventListener("click", () => send(effect, "always", picked));
    const back = h("button", "btn-quiet", "Back"); back.type = "button"; back.disabled = busy;
    back.addEventListener("click", () => { mode = "main"; paint(); });
    act.append(go, back);
    box.append(act);
    return box;
  }

  function paint() {
    body.replaceChildren();
    card.classList.toggle("done", it.state !== "pending");
    if (it.state !== "pending") {
      const gone = it.state === "gone";
      body.append(h("p", `perm-result ${it.outcome || ""}`, gone ? "No longer waiting" : outcomeText(it.outcome, it.remembered)));
      return;
    }
    if (mode === "allow-scope") { body.append(scopeChooser("allow")); return; }
    if (mode === "deny-scope") { body.append(scopeChooser("deny")); return; }
    if (it.suggest) {
      const sg = h("div", "perm-suggest");
      sg.append(h("span", "", suggestText(it.suggest)));
      const opts = it.suggest.effect === "deny" ? it.denyOptions : it.allowOptions;
      const o = opts.find((x) => x.id === it.suggest.optionId);
      if (o) {
        const b = h("button", it.suggest.effect === "deny" ? "btn-danger" : "btn-primary", it.suggest.effect === "deny" ? "Yes, always deny" : "Yes, always allow"); b.type = "button"; b.disabled = busy;
        b.title = o.label;
        b.addEventListener("click", () => send(it.suggest.effect, "always", o.id));
        sg.append(b);
      }
      body.append(sg);
    }
    const row = h("div", "perm-actions");
    const mk = (cls, text, fn) => { const b = h("button", cls, text); b.type = "button"; b.disabled = busy; b.addEventListener("click", fn); row.append(b); return b; };
    mk("btn-primary", "Allow once", () => send("allow", "once"));
    if (it.allowOptions && it.allowOptions.length) mk("btn-quiet", "Always allow…", () => { mode = "allow-scope"; picked = ""; paint(); });
    mk("btn-quiet", "Deny", () => send("deny", "once"));
    if (it.denyOptions && it.denyOptions.length) mk("btn-quiet", "Always deny…", () => { mode = "deny-scope"; picked = ""; paint(); });
    body.append(row);
    body.append(h("p", "perm-note", "Nothing runs until you answer."));
  }
  paint();
  it.repaint = paint;
  return card;
}

// ---------------------------------------------------------------- Settings > Permissions

export function initPermissions({ json, h, icon, notify, button }) {
  let modal = null, snap = null, closeFn = null;

  function ruleRow(r) {
    const li = h("li", `perm-rule ${r.effect}`);
    const top = h("div", "perm-rule-top");
    top.append(h("span", `perm-eff ${r.effect}`, r.effect === "allow" ? "Allow" : "Deny"), h("span", "perm-rule-tool", r.tool));
    li.append(top, h("p", "perm-rule-scope", r.scope));
    const meta = h("p", "perm-rule-meta", `Used ${r.uses} time${r.uses === 1 ? "" : "s"}${r.lastUsedAt ? ` · last ${new Date(r.lastUsedAt).toLocaleDateString()}` : ""}`);
    li.append(meta);
    const act = h("div", "perm-actions");
    const flip = h("button", "btn-quiet", r.effect === "allow" ? "Change to deny" : "Change to allow"); flip.type = "button";
    flip.addEventListener("click", async () => { try { await json(`/permissions/rules/${encodeURIComponent(r.id)}`, { method: "PATCH", body: JSON.stringify({ effect: r.effect === "allow" ? "deny" : "allow" }) }); await load(); } catch (e) { notify(`Could not change the rule: ${e.message}`); } });
    act.append(flip);
    if (r.matcher && r.matcher.value !== undefined) {
      const ed = h("button", "btn-quiet", "Edit"); ed.type = "button";
      ed.addEventListener("click", () => {
        const input = document.createElement("input"); input.className = "fld"; input.value = r.matcher.value; input.setAttribute("aria-label", "Rule value");
        const save = h("button", "btn-primary", "Save"); save.type = "button";
        const cancel = h("button", "btn-quiet", "Cancel"); cancel.type = "button";
        const edit = h("div", "perm-edit"); edit.append(input, save, cancel);
        li.replaceChild(edit, act);
        cancel.addEventListener("click", () => load());
        save.addEventListener("click", async () => { try { await json(`/permissions/rules/${encodeURIComponent(r.id)}`, { method: "PATCH", body: JSON.stringify({ value: input.value }) }); await load(); } catch (e) { notify(`Could not save: ${e.message}`); } });
        input.focus();
      });
      act.append(ed);
    }
    const del = h("button", "btn-quiet", "Delete"); del.type = "button";
    del.addEventListener("click", async () => { try { await json(`/permissions/rules/${encodeURIComponent(r.id)}`, { method: "DELETE" }); await load(); } catch (e) { notify(`Could not delete: ${e.message}`); } });
    act.append(del);
    li.append(act);
    return li;
  }

  function paint() {
    if (!modal) return;
    const card = modal.querySelector(".perm-panel");
    card.replaceChildren();
    const head = h("div", "apps-head");
    const t = h("div"); t.append(h("h2", "", "Permissions"), h("p", "", "Daebot asks first. Your answers teach it what to do next time."));
    const x = h("button", "icon-btn", ""); x.type = "button"; x.setAttribute("aria-label", "Close"); x.append(icon("i-x"));
    x.addEventListener("click", () => closeFn && closeFn());
    head.append(t, x);
    card.append(head);
    if (!snap) { card.append(h("p", "apps-note", "Loading…")); return; }

    const sec = h("section", "apps-sec");
    sec.append(h("h3", "", "When to ask"));
    const modes = h("div", "perm-modes"); modes.setAttribute("role", "radiogroup");
    for (const m of snap.modes) {
      const info = MODE_INFO[m] || { name: m, desc: "" };
      const lab = h("label", "perm-mode");
      const rb = document.createElement("input"); rb.type = "radio"; rb.name = "perm-mode"; rb.value = m; rb.checked = snap.mode === m;
      rb.addEventListener("change", async () => { try { await json("/permissions/mode", { method: "PUT", body: JSON.stringify({ mode: m }) }); snap.mode = m; } catch (e) { notify(`Could not change the mode: ${e.message}`); await load(); } });
      const txt = h("span", "perm-mode-text"); txt.append(h("strong", "", info.name), h("span", "", info.desc));
      lab.append(rb, txt);
      modes.append(lab);
    }
    sec.append(modes);
    card.append(sec);

    if (snap.waiver) {
      const ws = h("section", "apps-sec");
      ws.append(h("h3", "", "Bypass permissions"));
      ws.append(h("p", "apps-note", snap.waiver.accepted
        ? `You accepted the waiver${snap.waiver.at ? ` on ${new Date(snap.waiver.at).toLocaleDateString()}` : ""}. Bypass can be turned on per chat, from the permissions control above the message box.`
        : "Bypass lets Daebot act without asking in a chat where you turn it on. You accept a waiver the first time you do."));
      if (snap.waiver.accepted) {
        const row = h("div", "perm-waiver");
        const rv = h("button", "btn-quiet", "Withdraw the waiver"); rv.type = "button";
        rv.addEventListener("click", async () => { try { await json("/permissions/waiver", { method: "DELETE" }); await load(); } catch (e) { notify(`Could not withdraw the waiver: ${e.message}`); } });
        row.append(rv);
        ws.append(row);
      }
      card.append(ws);
    }

    const rs = h("section", "apps-sec");
    rs.append(h("h3", "", `Your rules (${snap.rules.length})`));
    if (!snap.rules.length) rs.append(h("p", "apps-note", "No rules yet. Press Always allow or Always deny on a permission card and the rule shows up here."));
    else { const ul = h("ul", "perm-rules"); for (const r of snap.rules) ul.append(ruleRow(r)); rs.append(ul); }
    card.append(rs);

    if (snap.learned && snap.learned.length) {
      const ls = h("section", "apps-sec");
      ls.append(h("h3", "", "Dae has noticed"), h("p", "apps-note", "You keep saying no to these. Dae will not propose them again, and offers to make it a rule."));
      const ul = h("ul", "perm-rules");
      for (const l of snap.learned) ul.append(h("li", "perm-rule deny", `${l.label} (declined ${l.deny} times)`));
      ls.append(ul);
      card.append(ls);
    }
  }

  async function load() {
    try { snap = await json("/permissions"); } catch { snap = null; }
    paint();
  }

  function open() {
    if (modal) return;
    modal = h("div", "gate-token modal"); modal.id = "perm-modal";
    const card = h("div", "token-card bot-card apps-card perm-panel"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-label", "Permissions");
    modal.append(card);
    document.body.append(modal);
    const onKey = (e) => { if (e.key === "Escape") closeFn(); };
    closeFn = () => { document.removeEventListener("keydown", onKey); modal.remove(); modal = null; if (button) button.setAttribute("aria-expanded", "false"); };
    document.addEventListener("keydown", onKey);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeFn(); });
    if (button) button.setAttribute("aria-expanded", "true");
    snap = null; paint(); load();
  }
  if (button) button.addEventListener("click", open);
  // The sidebar button only shows where this deployment keeps permissions (a runtime with a data dir).
  async function probe() {
    if (!button) return;
    try { await json("/permissions"); button.hidden = false; } catch { button.hidden = true; }
  }
  return { open, load, probe };
}


// ---------------------------------------------------------------- Bypass waiver

/**
 * The waiver modal. Resolves true only after the box is ticked, the button pressed AND the server recorded the acceptance (POST /permissions/waiver).
 * The button stays disabled until the box is ticked; the server refuses bypass without a recorded waiver no matter what this page does.
 */
export function askWaiver({ json, h, icon, notify, info }) {
  return new Promise((resolve) => {
    const text = (info && info.text) || "I understand this gives the AI permission to take any action without asking, including sending messages, deleting data and spending money, and that every action it takes is my responsibility.";
    const version = info && Number.isInteger(info.version) ? info.version : 1;
    const modal = h("div", "gate-token modal"); modal.id = "waiver-modal";
    const card = h("div", "token-card bot-card waiver-card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-labelledby", "waiver-title");
    card.append(h("h2", "", "Turn on Bypass permissions"));
    card.lastChild.id = "waiver-title";
    card.append(h("p", "", "Daebot will stop asking. It can act on its own in any chat where Bypass is on."));
    card.append(h("p", "waiver-text", text));
    const lab = h("label", "waiver-check");
    const box = document.createElement("input"); box.type = "checkbox"; box.id = "waiver-box";
    lab.append(box, h("span", "", "I have read this and I accept."));
    card.append(lab);
    const err = h("p", "err", ""); err.hidden = true; err.setAttribute("role", "alert");
    card.append(err);
    const row = h("div", "row");
    const go = h("button", "btn-danger solid", "Turn on Bypass"); go.type = "button"; go.disabled = true; go.id = "waiver-accept";
    const no = h("button", "btn-quiet", "Cancel"); no.type = "button";
    row.append(go, no);
    card.append(row);
    modal.append(card);
    document.body.append(modal);
    const prev = document.activeElement;
    const close = (v) => { document.removeEventListener("keydown", onKey); modal.remove(); try { prev && prev.focus && prev.focus(); } catch { /* gone */ } resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(false); };
    document.addEventListener("keydown", onKey);
    box.addEventListener("change", () => { go.disabled = !box.checked; });
    no.addEventListener("click", () => close(false));
    modal.addEventListener("click", (e) => { if (e.target === modal) close(false); });
    go.addEventListener("click", async () => {
      if (!box.checked) return;
      go.disabled = true; err.hidden = true;
      try {
        await json("/permissions/waiver", { method: "POST", body: JSON.stringify({ acknowledged: true, version }) });
        close(true);
      } catch (e) {
        err.textContent = `Could not record your acceptance: ${e.message}`; err.hidden = false; go.disabled = !box.checked;
      }
    });
    box.focus();
  });
}

// ---------------------------------------------------------------- per-chat mode (composer)

/**
 * The mode control above the composer. It is also the Bypass indicator: with Bypass on its LED glyph and label turn accent red
 * (the composer hairline follows), and clicking it opens the same menu as always.
 *   getSessionId(): the chat on screen (creates nothing); ensureSession(): its id, creating the session first if needed.
 *   getRow(): the session list row of the chat on screen (carries permMode from the server) or undefined.
 * The mode is stored with the session on the server (PATCH /sessions/:id { permMode }); null falls back to the account default.
 */
export function initChatMode({ json, h, icon, notify, ids, ensureSession, getSessionId, getRow, onRowMode }) {
  const btn = document.getElementById(ids.btn), label = document.getElementById(ids.label), menu = document.getElementById(ids.menu);
  if (!btn || !menu) return { render() {}, probe() {} };
  let snap = null;            // { mode (account default), waiver: {accepted, text, version} }
  const local = new Map();    // sessionId -> mode set in this page (the list row can lag a refresh)
  let open = false;

  const modeOf = () => {
    const id = getSessionId();
    if (id && local.has(id)) return local.get(id);
    const row = getRow();
    return row && row.permMode ? row.permMode : null;
  };
  const effective = () => {
    const m = modeOf();
    if (m === "bypass" && !(snap && snap.waiver && snap.waiver.accepted)) return snap ? snap.mode : null; // the server ignores it without a waiver
    return m;
  };

  function render() {
    if (!snap) { btn.hidden = true; return; }
    const eff = effective();
    const shown = eff || snap.mode;
    btn.hidden = false;
    label.textContent = shown === "bypass" ? "Bypass" : chatModeName(eff, snap.mode);
    btn.dataset.mode = CHAT_MODES.some((m) => m.id === shown) ? shown : "risky";   // CSS lights the LED glyph from this
    btn.classList.toggle("is-bypass", eff === "bypass");
    const aria = eff === "bypass" ? "Permissions: Bypass is on, Daebot acts without asking. Change" : `Permissions: ${chatModeName(eff, snap.mode)}. Change`;
    btn.setAttribute("aria-label", aria);
    btn.title = eff === "bypass" ? "Bypass is on in this chat: Daebot acts without asking. Open to change it." : "What Daebot may do in this chat without asking";
    if (open) paintMenu();
  }

  function paintMenu() {
    menu.replaceChildren();
    const eff = effective() || snap.mode;
    for (const m of CHAT_MODES) {
      const it = h("button", `mm-item${m.danger ? " bypass" : ""}`); it.type = "button"; it.setAttribute("role", "menuitemradio"); it.setAttribute("aria-checked", String(eff === m.id));
      it.append(icon("i-check"), h("strong", "", m.name), h("small", "", m.id === snap.mode && !modeOf() ? `${m.desc} (your default)` : m.desc));
      it.addEventListener("click", () => { toggle(false); void choose(m.id); });
      menu.append(it);
    }
  }

  function toggle(on) {
    open = on;
    menu.hidden = !on;
    btn.setAttribute("aria-expanded", String(on));
    if (on) { paintMenu(); const first = menu.querySelector('[aria-checked="true"]') || menu.firstChild; first && first.focus(); }
  }

  async function patch(id, mode) {
    await json(`/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ permMode: mode }) });
    local.set(id, mode);
    if (onRowMode) onRowMode(id, mode);
  }

  async function choose(mode) {
    let id;
    try { id = await ensureSession(); } catch (e) { notify(`Could not start a chat: ${e.message}`); return; }
    if (!id) return;
    try {
      if (mode === "bypass" && !(snap.waiver && snap.waiver.accepted)) {
        const ok = await askWaiver({ json, h, icon, notify, info: snap.waiver });
        if (!ok) return;
        snap.waiver = { ...(snap.waiver || {}), accepted: true };
      }
      await patch(id, mode === snap.mode ? null : mode);
    } catch (e) {
      if (/waiver_required/.test(String(e.message))) { snap.waiver = { ...(snap.waiver || {}), accepted: false }; notify("Bypass needs the waiver first. Pick Bypass again to accept it."); }
      else notify(`Could not change the permissions for this chat: ${e.message}`);
    }
    render();
  }

  btn.addEventListener("click", () => toggle(!open));
  document.addEventListener("click", (e) => { if (open && !menu.contains(e.target) && !btn.contains(e.target)) toggle(false); });
  document.addEventListener("keydown", (e) => {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); toggle(false); btn.focus(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...menu.querySelectorAll(".mm-item")];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    }
  });

  async function probe() {
    try { snap = await json("/permissions"); } catch { snap = null; }
    render();
  }
  return { render, probe, refresh: probe };
}
