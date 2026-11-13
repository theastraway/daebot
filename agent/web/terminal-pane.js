// Daebot's terminal. A desktop PTY is drawn with xterm and the person's keystrokes go to that PTY.
// A pipe session stays read-only: output is assigned with textContent, so a shell that prints markup is shown as text.
// xterm is imported only when a PTY session is opened, so this file still loads under node:test.

export const PANE_LABEL = "Daebot's terminal";
export const PIPE_NOTE = "Read-only. This session is a pipe, not a PTY, so the pane cannot send keystrokes.";
export const EMPTY_TEXT = "No output yet.";
export const POLL_MS = 2000;

/** A session the person can type into. Pipe sessions are not. */
export function sessionTypeable(info) {
  return !!(info && info.typeable === true && info.backend === "pty");
}

/** Raw PTY bytes when the event carries them. Otherwise the stripped text. */
export function outputPiece(data) {
  if (data && typeof data.screen === "string") return data.screen;
  return data && typeof data.text === "string" ? data.text : "";
}

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
 * Restart the stream only while the pane is open, nothing is already streaming or mounting, and the shell has not settled.
 * A dropped connection comes back on the next poll. An exited shell does not reconnect every poll.
 * `following` is the gap before the stream controller exists, while the PTY is still being measured and fitted.
 */
export function shouldFollow(paneOpen, streamOpen, settled, following = false) {
  return !!paneOpen && !streamOpen && !settled && !following;
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
 *   emptyEl?: HTMLElement, closeBtn?: HTMLElement, onOpen?: (open: boolean) => void, screenEl?: HTMLElement, noteEl?: HTMLElement,
 *   loadXterm?: () => Promise<{ Terminal: new (opts: object) => object, FitAddon: new () => object }> }} opts
 */
export function initTerminalPane(opts) {
  const nop = { noteTool() {}, sync() {}, close() {} };
  if (!opts || !opts.chip || !opts.pane || !opts.list || !opts.out) return nop;
  const { chip, pane, list, out } = opts;
  const exitEl = opts.exitEl;
  const emptyEl = opts.emptyEl;
  const screenEl = opts.screenEl;
  const noteEl = opts.noteEl;
  const heading = pane.querySelector("h2");
  if (heading) heading.textContent = PANE_LABEL;
  if (pane.getAttribute("aria-label")) pane.setAttribute("aria-label", PANE_LABEL);

  let poll = null;
  let gen = 0;
  let chat = null;
  let selected = null;
  let rows = [];
  let pinned = true;
  let streamCtl = null;
  let followGen = 0;
  let following = false;
  let writeChain = Promise.resolve();
  let settled = false;
  let shown = "";
  let painting = false;
  let term = null;
  let fitAddon = null;
  let resizeObs = null;
  let usingPty = false;
  let xtermMods = null;

  function stopStream() {
    if (streamCtl) { streamCtl.abort(); streamCtl = null; }
  }
  function ensurePoll(on) {
    if (on && !poll) poll = setInterval(() => { void refresh(); }, POLL_MS);
    if (!on && poll) { clearInterval(poll); poll = null; }
  }
  function setOpen(open) {
    const was = !pane.hidden;
    pane.hidden = !open;
    chip.setAttribute("aria-expanded", String(open));
    document.documentElement.classList.toggle("term-open", open);
    if (!open) {
      // Drop a mount that has not subscribed yet, or it will open a terminal into the closed pane.
      followGen++;
      following = false;
      stopStream();
    } else void followSelected();
    if (open !== was && opts.onOpen) opts.onOpen(open);
  }
  function releaseFollow(ticket) {
    if (ticket === followGen) following = false;
  }
  function stillFollowing(ticket, id, tid) {
    return ticket === followGen && opts.currentId() === id && selected === tid && !pane.hidden;
  }
  function showExit(info) {
    if (!exitEl) return;
    const label = exitLabel(info);
    exitEl.textContent = label;
    exitEl.hidden = !label;
  }
  function syncEmpty() {
    if (!emptyEl) return;
    const blank = !usingPty && shown.length === 0;
    emptyEl.hidden = !blank;
    if (blank) emptyEl.textContent = EMPTY_TEXT;
  }
  function syncNote(info) {
    if (!noteEl) return;
    const pipe = !!info && !sessionTypeable(info);
    noteEl.hidden = !pipe;
    noteEl.textContent = pipe ? PIPE_NOTE : "";
  }
  function destroyTerm() {
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    dropXtermStyles(screenEl);
    if (term) { term.dispose(); term = null; fitAddon = null; }
    if (screenEl) screenEl.replaceChildren();
  }
  // The page CSP is style-src 'self', so the <style> tags xterm appends for its theme never apply
  // and the rows inherit the page ink, which is invisible on the plate. A constructed stylesheet
  // is applied by script, which that policy allows. Inline element.style from xterm (row size) already works.
  function adoptXtermStyles(root) {
    if (!root || typeof CSSStyleSheet !== "function") return;
    const next = [];
    for (const style of root.querySelectorAll("style")) {
      const text = style.textContent || "";
      if (!text.trim()) continue;
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(text);
        if (sheet.cssRules.length) next.push(sheet);
      } catch { /* a style xterm also sets through element.style */ }
    }
    const prev = root.__daebotXtermSheets || [];
    const kept = (document.adoptedStyleSheets || []).filter((s) => prev.indexOf(s) < 0);
    document.adoptedStyleSheets = kept.concat(next);
    root.__daebotXtermSheets = next;
    const rows = root.querySelector(".xterm-rows");
    if (rows) {
      rows.style.color = "#f6ead8";
      rows.style.fontSize = "13px";
      rows.style.fontFamily = "monospace";
    }
  }
  function dropXtermStyles(root) {
    if (!root || !root.__daebotXtermSheets) return;
    const prev = root.__daebotXtermSheets;
    document.adoptedStyleSheets = (document.adoptedStyleSheets || []).filter((s) => prev.indexOf(s) < 0);
    root.__daebotXtermSheets = [];
  }
  function usePty(on) {
    usingPty = !!on;
    out.hidden = !!on;
    if (screenEl) screenEl.hidden = !on;
    if (!on) destroyTerm();
  }
  async function loadXterm() {
    if (typeof opts.loadXterm === "function") return opts.loadXterm();
    if (!xtermMods) {
      const xt = await import("/vendor/xterm/xterm.mjs");
      const fitMod = await import("/vendor/xterm/addon-fit.mjs");
      xtermMods = { Terminal: xt.Terminal, FitAddon: fitMod.FitAddon };
    }
    return xtermMods;
  }
  // Dispose this mount's terminal only. A newer follow may already own `term`; wiping the element then
  // would delete the terminal the probe is reading.
  function abandon(t, obs) {
    if (obs) {
      obs.disconnect();
      if (resizeObs === obs) resizeObs = null;
    }
    if (!t) return;
    try { t.dispose(); } catch { /* already disposed */ }
    if (term !== t) return;
    term = null;
    fitAddon = null;
    dropXtermStyles(screenEl);
    if (screenEl) screenEl.replaceChildren();
  }
  async function mountTerm(id, tid, ticket) {
    if (!screenEl || !stillFollowing(ticket, id, tid)) return null;
    destroyTerm();
    const { Terminal, FitAddon } = await loadXterm();
    if (!stillFollowing(ticket, id, tid)) return null;
    const t = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      // A single family. xterm measures with OffscreenCanvas, whose font shorthand drops a
      // fallback list and then reports a 0 cell, so the rows stay 0px tall and paint nothing.
      fontFamily: "monospace",
      theme: { background: "#0c0b0a", foreground: "#f6ead8", cursor: "#f6ead8", selectionBackground: "#3a342c" },
      scrollback: 2000,
    });
    const addon = new FitAddon();
    t.loadAddon(addon);
    // The pane has just been unhidden. Measuring the font in that same turn sees a 0-size box,
    // and xterm then paints nothing (a black viewport) until something remeasures. Wait for layout.
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    await new Promise((resolve) => raf(() => raf(resolve)));
    if (!stillFollowing(ticket, id, tid)) { abandon(t, null); return null; }
    t.open(screenEl);
    term = t;
    fitAddon = addon;
    adoptXtermStyles(screenEl);
    // Keystrokes must reach the pty in order. Each one is its own POST, and a fast typist
    // (or the shot harness) must not let a later key overtake an earlier one.
    let inputChain = Promise.resolve();
    t.onData((data) => {
      if (!data || !stillFollowing(ticket, id, tid)) return;
      inputChain = inputChain.then(() => fetch(`/sessions/${encodeURIComponent(id)}/terminals/${encodeURIComponent(tid)}/input`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...opts.authHeaders() },
        body: JSON.stringify({ data }),
      })).catch(() => { /* the stream shows a dead session */ });
    });
    let lastCols = 0;
    let lastRows = 0;
    let obs = null;
    const fitNow = () => {
      if (term !== t || pane.hidden || screenEl.hidden) return;
      try {
        const chars = t._core && t._core._charSizeService;
        if (chars && chars.hasValidSize === false) chars.measure();
      } catch { /* fit still runs on the size xterm already has */ }
      try { addon.fit(); } catch { return; }
      if (t.cols === lastCols && t.rows === lastRows) return;
      lastCols = t.cols;
      lastRows = t.rows;
      void fetch(`/sessions/${encodeURIComponent(id)}/terminals/${encodeURIComponent(tid)}/resize`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...opts.authHeaders() },
        body: JSON.stringify({ cols: t.cols, rows: t.rows }),
      }).catch(() => { /* a closed session ignores resize */ });
    };
    if (typeof ResizeObserver === "function") {
      obs = new ResizeObserver(() => fitNow());
      obs.observe(screenEl);
      resizeObs = obs;
    }
    const paintFit = () => {
      try {
        const chars = t._core && t._core._charSizeService;
        if (chars && chars.hasValidSize === false) chars.measure();
      } catch { /* fit still runs on the size xterm already has */ }
      fitNow();
      // fit rewrites xterm's dimension <style>. Adopt again so span sizing survives the CSP.
      adoptXtermStyles(screenEl);
    };
    // Wait until this frame has a real box, then fit before the caller subscribes to the stream.
    // A write that lands first paints into a 0-height row and the shot captures a black pane.
    await new Promise((resolve) => raf(() => raf(resolve)));
    if (!stillFollowing(ticket, id, tid)) { abandon(t, obs); return null; }
    paintFit();
    t.focus();
    return t;
  }
  function writeScreen(target, kind, data) {
    if (!target) return;
    const piece = outputPiece(data);
    const replace = kind === "snapshot" || !!(data && data.screenGap);
    // reset() is synchronous and write() parses later. Chain them so a second snapshot cannot
    // reset the buffer while the first snapshot's bytes are still queued.
    writeChain = writeChain.then(() => new Promise((resolve) => {
      if (target !== term) { resolve(); return; }
      const finish = () => {
        if (emptyEl) {
          emptyEl.hidden = shown.length > 0;
          if (!emptyEl.hidden) emptyEl.textContent = EMPTY_TEXT;
        }
        resolve();
      };
      if (replace) {
        shown = "";
        try { target.reset(); } catch { /* a disposed terminal */ }
      }
      if (!piece) { finish(); return; }
      let settledWrite = false;
      const after = () => {
        if (settledWrite) return;
        settledWrite = true;
        if (target === term) shown += piece;
        finish();
      };
      try { target.write(piece, after); }
      catch { after(); }
    })).catch(() => { /* the next snapshot still has to land */ });
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
    const ticket = ++followGen;
    following = true;
    stopStream();
    settled = false;
    const id = opts.currentId();
    const tid = selected;
    if (!id || !tid || pane.hidden) { releaseFollow(ticket); return; }
    const info = rows.find((r) => r.id === tid);
    const pty = sessionTypeable(info);
    usePty(pty);
    syncNote(info || null);
    let mounted = null;
    if (pty) {
      try { mounted = await mountTerm(id, tid, ticket); }
      catch { mounted = null; }
      if (ticket !== followGen) return;
      if (!mounted) usePty(false);
    }
    if (!stillFollowing(ticket, id, tid)) { releaseFollow(ticket); return; }
    const ctl = new AbortController();
    streamCtl = ctl;
    following = false;
    pinned = true;
    paint("", false);
    if (usingPty && emptyEl) { emptyEl.hidden = false; emptyEl.textContent = EMPTY_TEXT; }
    showExit(info);
    let res;
    try {
      res = await fetch(`/sessions/${encodeURIComponent(id)}/terminals/${encodeURIComponent(tid)}/stream`, {
        headers: { accept: "text/event-stream", ...opts.authHeaders() },
        credentials: "same-origin",
        signal: ctl.signal,
      });
    } catch { if (streamCtl === ctl) streamCtl = null; releaseFollow(ticket); return; }
    if (ticket !== followGen || ctl.signal.aborted || streamCtl !== ctl) return;
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
      releaseFollow(ticket);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const mine = mounted;
    const take = (block) => {
      if (ticket !== followGen || ctl.signal.aborted || opts.currentId() !== id || selected !== tid) return;
      const msg = parseSseBlock(block);
      if (!msg) return;
      if (msg.event === "snapshot" || msg.event === "data") {
        if (usingPty && mine) writeScreen(mine, msg.event, msg.data);
        else if (!usingPty) paint(applyOutput(shown, msg.event, msg.data), true);
        if (msg.event === "snapshot") showExit(msg.data.info);
        const rowInfo = msg.data.info || msg.data;
        if (rowInfo && rowInfo.backend) syncNote(rowInfo);
        if (rowInfo && rowInfo.status && rowInfo.status !== "running") settled = true;
      } else if (msg.event === "status") {
        const rowInfo = msg.data.info || msg.data;
        showExit(rowInfo);
        if (rowInfo && rowInfo.status && rowInfo.status !== "running") settled = true;
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
    finally { if (streamCtl === ctl) streamCtl = null; releaseFollow(ticket); }
  }
  async function refresh() {
    const ticket = ++gen;
    const id = opts.currentId();
    if (id !== chat) {
      followGen++;
      following = false;
      chat = id;
      selected = null;
      rows = [];
      settled = false;
      stopStream();
      usePty(false);
      syncNote(null);
      paint("", false);
      showExit(null);
    }
    if (!id) {
      chip.hidden = true;
      setOpen(false);
      ensurePoll(false);
      usePty(false);
      syncNote(null);
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
    if (shouldFollow(!pane.hidden, !!streamCtl, settled, following)) void followSelected();
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
    close() { setOpen(false); },
  };
}
