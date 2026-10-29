// Delete and update controls shared by the session list and the bot list: a confirm dialog built in the page (never
// window.confirm), a trash button that sits on every row, and long-press / right-click on a row for the same action.
// DOM is built with createElement + textContent only (no innerHTML). Pure text helpers are exported and unit tested.

export function sessionDeleteText(title) {
  const t = String(title || "").trim() || "Untitled";
  return { title: `Delete "${clip(t, 60)}"?`, body: "This session and all its messages are deleted from your account. This cannot be undone.", yes: "Delete session" };
}

export function botDeleteText(name, threadCount) {
  const n = String(name || "").trim() || "this bot";
  const c = Number.isFinite(threadCount) && threadCount > 0 ? `${threadCount} ${threadCount === 1 ? "thread" : "threads"}` : "its threads";
  return {
    title: `Delete ${clip(n, 40)}?`,
    body: `This deletes the bot, its instructions (DAEBOT.md), ${c}, and everything in the bot's own MIND: its memory, documents and entries. Your main MIND is not touched. This cannot be undone.`,
    yes: "Delete bot",
  };
}

export function updateText(version, latest) {
  return { available: `Update available: v${latest}`, current: `Version ${version}`, upToDate: `Version ${version}, up to date`, done: `Updated to v${latest}` };
}

function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

let open = null;

/** Resolves true when the user confirms, false on cancel / Escape / backdrop. One dialog at a time. */
export function confirmDialog({ title, body, yes = "Delete", no = "Keep it", danger = true }) {
  if (open) open(false);
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "gate-token modal";
    back.id = "confirm-modal";
    const card = document.createElement("div");
    card.className = "token-card bot-card";
    card.setAttribute("role", "alertdialog"); card.setAttribute("aria-modal", "true");
    const h2 = document.createElement("h2"); h2.id = "confirm-title"; h2.textContent = title;
    const p = document.createElement("p"); p.id = "confirm-body"; p.textContent = body;
    card.setAttribute("aria-labelledby", "confirm-title"); card.setAttribute("aria-describedby", "confirm-body");
    const row = document.createElement("div"); row.className = "row";
    const ok = document.createElement("button"); ok.type = "button"; ok.id = "confirm-yes"; ok.className = danger ? "btn-danger solid" : "btn-primary"; ok.textContent = yes;
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.id = "confirm-no"; cancel.className = "btn-quiet"; cancel.textContent = no;
    row.append(ok, cancel);
    card.append(h2, p, row);
    back.append(card);
    const prev = document.activeElement;
    const done = (v) => {
      open = null;
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      try { prev && prev.focus && prev.focus(); } catch { /* gone */ }
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === "Tab") { const f = [ok, cancel]; const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + 2) % 2].focus(); }
    };
    ok.addEventListener("click", () => done(true));
    cancel.addEventListener("click", () => done(false));
    back.addEventListener("click", (e) => { if (e.target === back) done(false); });
    document.addEventListener("keydown", onKey, true);
    open = done;
    document.body.append(back);
    cancel.focus();
  });
}

/**
 * Adds the delete affordances to a row: returns the trash button (append it to the row). `onDelete` is called when the user
 * taps the trash, right-clicks the row, or long-presses it (touch). The caller shows the confirm dialog.
 */
export function deleteControl(row, icon, label, onDelete) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "row-del"; b.setAttribute("aria-label", label); b.title = label;
  b.append(icon("i-trash"));
  b.addEventListener("click", (e) => { e.stopPropagation(); onDelete(); });
  row.addEventListener("contextmenu", (e) => { e.preventDefault(); onDelete(); });
  let t = 0, sx = 0, sy = 0;
  const clear = () => { clearTimeout(t); t = 0; };
  row.addEventListener("touchstart", (e) => {
    const p = e.touches[0]; sx = p.clientX; sy = p.clientY; clear();
    t = setTimeout(() => { t = 0; row.dataset.longpress = "1"; setTimeout(() => delete row.dataset.longpress, 600); onDelete(); }, 550);
  }, { passive: true });
  row.addEventListener("touchmove", (e) => { const p = e.touches[0]; if (Math.abs(p.clientX - sx) + Math.abs(p.clientY - sy) > 10) clear(); }, { passive: true });
  row.addEventListener("touchend", clear); row.addEventListener("touchcancel", clear);
  // a long-press must not also open the row
  row.addEventListener("click", (e) => { if (row.dataset.longpress) { e.stopPropagation(); e.preventDefault(); } }, true);
  return b;
}

/** The pencil on a thread row (same hover / phone visibility as the trash). `onRename` starts the inline edit. */
export function renameControl(row, icon, label, onRename) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "row-del row-ren"; b.setAttribute("aria-label", label); b.title = label;
  b.append(icon("i-pencil"));
  b.addEventListener("click", (e) => { e.stopPropagation(); onRename(); });
  row.classList.add("has-ren");
  return b;
}

/** What an inline rename should do with what was typed: save a changed non-empty title, otherwise revert. Pure, unit tested. */
export function renameDecision(current, typed) {
  const t = String(typed ?? "").replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const cur = String(current ?? "").trim();
  if (!t || t === cur) return { save: false, title: cur };
  return { save: true, title: t };
}

let editing = null;
/** True while a title is being edited: lists skip re-rendering so the field is not thrown away under the cursor. */
export function isRenaming() { return !!editing; }

/**
 * Inline edit of a title. `host` (the row's button, or the header title) is hidden and an input sits in its place; the input is never
 * inside a button. Enter saves, Escape cancels, blur saves, empty reverts. `onSave(title)` is awaited; `onEnd()` runs once the field is gone.
 */
export function editInline({ host, current, onSave, onEnd, className = "" }) {
  if (!host.isConnected || !host.parentNode) return;
  if (editing) editing.finish(false);
  const input = document.createElement("input");
  input.type = "text"; input.className = `title-edit ${className}`.trim(); input.value = current; input.maxLength = 80;
  input.setAttribute("aria-label", "Thread name"); input.autocomplete = "off"; input.spellcheck = false;
  let ended = false;
  const finish = (save) => {
    if (ended) return;
    ended = true; editing = null;
    const d = renameDecision(current, input.value);
    input.remove(); host.hidden = false;
    if (save && d.save) Promise.resolve(onSave(d.title)).catch(() => {}).finally(() => onEnd && onEnd());
    else if (onEnd) onEnd();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
  input.addEventListener("blur", () => finish(true));
  editing = { finish };
  host.hidden = true;
  host.parentNode.insertBefore(input, host);
  input.focus(); input.select();
}
