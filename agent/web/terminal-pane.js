// Daebot's terminal, read-only. The pane lists shell sessions the agent opened in this chat and streams
// what they print. It never sends keystrokes. Output is assigned with textContent only, so a shell that
// prints markup is shown as text.

export const PANE_LABEL = "Daebot's terminal — read-only";
export const EMPTY_TEXT = "No output yet.";
export const POLL_MS = 2000;

/** Keep following new output only when the reader is already at the bottom. */
export function nearBottom(scrollTop, scrollHeight, clientHeight, slack = 48) {
  return scrollHeight - scrollTop - clientHeight <= slack;
}

/** Empty while the shell is still running. */
export function exitLabel(info) {
  if (!info || info.status === "running") return "";
  if (info.status === "closed") return "Closed";
  const code = info.exitCode === null || info.exitCode === undefined ? "?" : String(info.exitCode);
  return `Exited (status ${code})`;
}

/** Poll only while this chat actually has a shell. No timers when the list is empty. */
export function shouldPoll(count) {
  return count > 0;
}

/**
 * Restart the stream only while the pane is open, nothing is already streaming, and the shell has not settled.
 * A dropped connection comes back on the next poll. An exited shell does not reconnect every poll.
 */
export function shouldFollow(paneOpen, streamOpen, settled) {
  return !!paneOpen && !streamOpen && !settled;
}

/** One line the pane inserts when the ring or the read cap skipped bytes. Plain text, never markup. */
export function droppedNote(n) {
  const k = Number(n);
  if (!Number.isFinite(k) || k <= 0) return "";
  const count = Math.floor(k);
  return `[${count} earlier ${count === 1 ? "character" : "characters"} not shown]\n`;
}

/**
 * The string the pane will assign to textContent. `snapshot` replaces the view. `data` appends.
 * The characters of `text` are kept as-is, including `<` and `&`.
 */
export function applyOutput(shown, kind, data) {
  const text = data && typeof data.text === "string" ? data.text : "";
  const note = droppedNote(data && data.dropped);
  if (kind === "snapshot") return note + text;
  if (kind === "data") return (shown || "") + note + text;
  return shown || "";
}

function sessionRow(info) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "term-sess";
  b.dataset.tid = info.id;
  const id = document.createElement("span");
  id.className = "term-id";
  id.textContent = info.id;
  const meta = document.createElement("span");
  meta.className = "term-meta";
  meta.textContent = `${info.shell} · ${info.status}`;
  const cwd = document.createElement("span");
  cwd.className = "term-cwd";
  cwd.textContent = info.cwd || "";
  b.title = `${info.id} ${info.shell} ${info.status} ${info.cwd || ""}`;
  b.append(id, meta, cwd);
  return b;
}

function parseSseBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      let v = line.slice(5);
      if (v.startsWith(" ")) v = v.slice(1);
      data.push(v);
    }
  }
  if (!data.length) return null;
  try { return { event, data: JSON.parse(data.join("\n")) }; } catch { return null; }
}

/**
 * @param {{ json: Function, authHeaders: () => Record<string, string>, currentId: () => string | null,
 *   chip: HTMLElement, pane: HTMLElement, list: HTMLElement, out: HTMLElement, exitEl?: HTMLElement,
 *   emptyEl?: HTMLElement, closeBtn?: HTMLElement }} opts
 */
export function initTerminalPane(opts) {
  const nop = { noteTool() {}, sync() {} };
  if (!opts || !opts.chip || !opts.pane || !opts.list || !opts.out) return nop;
  const { chip, pane, list, out } = opts;
  const exitEl = opts.exitEl;
  const emptyEl = opts.emptyEl;
  const heading = pane.querySelector("h2");
  if (heading) heading.textContent = PANE_LABEL;

  let poll = null;
  let gen = 0;
  let chat = null;
  let selected = null;
  let rows = [];
  let pinned = true;
  let streamCtl = null;
  let settled = false;
  let shown = "";
  let painting = false;

  function stopStream() {
    if (streamCtl) { streamCtl.abort(); streamCtl = null; }
  }
  function ensurePoll(on) {
    if (on && !poll) poll = setInterval(() => { void refresh(); }, POLL_MS);
    if (!on && poll) { clearInterval(poll); poll = null; }
  }
  function setOpen(open) {
    pane.hidden = !open;
    chip.setAttribute("aria-expanded", String(open));
    document.documentElement.classList.toggle("term-open", open);
    if (!open) stopStream();
    else void followSelected();
  }
  function showExit(info) {
    if (!exitEl) return;
    const label = exitLabel(info);
    exitEl.textContent = label;
    exitEl.hidden = !label;
  }
  function syncEmpty() {
    if (!emptyEl) return;
    const blank = shown.length === 0;
    emptyEl.hidden = !blank;
    if (blank) emptyEl.textContent = EMPTY_TEXT;
  }
  function paint(text, stick) {
    const follow = !!(stick && pinned);
    shown = text;
    // Ignore the scroll event this write causes, or growing the text would unpin a reader who was at the bottom.
    painting = true;
    try {
      out.textContent = shown;
      if (follow) out.scrollTop = out.scrollHeight;
    } finally { painting = false; }
    syncEmpty();
  }
  function renderList() {
    list.replaceChildren();
    for (const info of rows) {
      const b = sessionRow(info);
      if (info.id === selected) b.setAttribute("aria-selected", "true");
      b.addEventListener("click", () => { selected = info.id; settled = false; renderList(); void followSelected(); });
      list.append(b);
    }
  }
  async function followSelected() {
    stopStream();
    settled = false;
    const id = opts.currentId();
    const tid = selected;
    if (!id || !tid || pane.hidden) return;
    const ctl = streamCtl = new AbortController();
    pinned = true;
    paint("", false);
    showExit(rows.find((r) => r.id === tid));
    let res;
    try {
      res = await fetch(`/sessions/${encodeURIComponent(id)}/terminals/${encodeURIComponent(tid)}/stream`, {
        headers: { accept: "text/event-stream", ...opts.authHeaders() },
        credentials: "same-origin",
        signal: ctl.signal,
      });
    } catch { if (streamCtl === ctl) streamCtl = null; return; }
    if (ctl.signal.aborted || streamCtl !== ctl) return;
    if (!res.ok || !res.body) {
      paint("", false);
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.textContent = res.status === 403
          ? "Terminal output is only visible to the owner of this chat."
          : "This terminal is not available.";
      }
      showExit(null);
      settled = true;
      if (streamCtl === ctl) streamCtl = null;
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const take = (block) => {
      if (ctl.signal.aborted || opts.currentId() !== id || selected !== tid) return;
      const msg = parseSseBlock(block);
      if (!msg) return;
      if (msg.event === "snapshot" || msg.event === "data") {
        paint(applyOutput(shown, msg.event, msg.data), true);
        if (msg.event === "snapshot") showExit(msg.data.info);
        const info = msg.data.info || msg.data;
        if (info && info.status && info.status !== "running") settled = true;
      } else if (msg.event === "status") {
        const info = msg.data.info || msg.data;
        showExit(info);
        if (info && info.status && info.status !== "running") settled = true;
      }
    };
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done || ctl.signal.aborted) break;
        buf += dec.decode(step.value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          take(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
        }
      }
    } catch { /* aborted, or the shell exited and the server closed the stream */ }
    finally { if (streamCtl === ctl) streamCtl = null; }
  }
  async function refresh() {
    const ticket = ++gen;
    const id = opts.currentId();
    if (id !== chat) {
      chat = id;
      selected = null;
      rows = [];
      settled = false;
      stopStream();
      paint("", false);
      showExit(null);
    }
    if (!id) {
      chip.hidden = true;
      setOpen(false);
      ensurePoll(false);
      list.replaceChildren();
      return;
    }
    let body;
    try { body = await opts.json(`/sessions/${encodeURIComponent(id)}/terminals`); }
    catch { if (ticket !== gen) return; chip.hidden = true; setOpen(false); ensurePoll(false); list.replaceChildren(); return; }
    if (ticket !== gen || opts.currentId() !== id) return;
    rows = Array.isArray(body.terminals) ? body.terminals : [];
    if (!shouldPoll(rows.length)) {
      chip.hidden = true;
      setOpen(false);
      ensurePoll(false);
      list.replaceChildren();
      return;
    }
    chip.hidden = false;
    if (!selected || !rows.some((r) => r.id === selected)) { selected = rows[0].id; settled = false; }
    renderList();
    const cur = rows.find((r) => r.id === selected);
    if (cur && cur.status !== "running") showExit(cur);
    ensurePoll(true);
    if (shouldFollow(!pane.hidden, !!streamCtl, settled)) void followSelected();
  }

  out.addEventListener("scroll", () => {
    if (painting) return;
    pinned = nearBottom(out.scrollTop, out.scrollHeight, out.clientHeight);
  });
  chip.addEventListener("click", () => { setOpen(pane.hidden); if (!pane.hidden) void refresh(); });
  opts.closeBtn?.addEventListener("click", () => setOpen(false));

  return {
    noteTool() { void refresh(); },
    sync() { void refresh(); },
  };
}
