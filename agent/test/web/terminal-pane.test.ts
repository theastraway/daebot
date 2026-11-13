import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain browser module, no types
import { PANE_LABEL, PIPE_NOTE, EMPTY_TEXT, POLL_MS, nearBottom, exitLabel, shouldPoll, shouldFollow, droppedNote, applyOutput, sessionTypeable, outputPiece, initTerminalPane } from "../../web/terminal-pane.js";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");

test("terminal pane helpers: follow the bottom, label an exit, poll only while a shell exists", () => {
  assert.equal(PANE_LABEL, "Daebot's terminal");
  assert.match(PIPE_NOTE, /pipe, not a PTY/);
  assert.equal(sessionTypeable({ backend: "pty", typeable: true }), true);
  assert.equal(sessionTypeable({ backend: "pipe", typeable: false }), false);
  assert.equal(sessionTypeable({ backend: "pty", typeable: false }), false);
  assert.equal(outputPiece({ screen: "\x1b[32mgreen\x1b[0m", text: "green" }), "\x1b[32mgreen\x1b[0m");
  assert.equal(outputPiece({ text: "green" }), "green");
  assert.equal(POLL_MS, 2000);
  assert.equal(nearBottom(100, 200, 80), true);
  assert.equal(nearBottom(0, 500, 40), false);
  assert.equal(nearBottom(0, 100, 60, 10), false);
  assert.equal(exitLabel(null), "");
  assert.equal(exitLabel({ status: "running", exitCode: null }), "");
  assert.equal(exitLabel({ status: "closed" }), "Closed");
  assert.equal(exitLabel({ status: "exited", exitCode: 7 }), "Exited (status 7)");
  assert.equal(exitLabel({ status: "exited", exitCode: null }), "Exited (status ?)");
  assert.equal(shouldPoll(0), false);
  assert.equal(shouldPoll(2), true);
  assert.equal(shouldFollow(true, false, false), true);
  assert.equal(shouldFollow(true, true, false), false, "an open stream is not opened twice");
  assert.equal(shouldFollow(true, false, false, true), false, "a mount that has not subscribed yet is not opened twice");
  assert.equal(shouldFollow(true, false, true), false, "an exited shell does not reconnect every poll");
  assert.equal(shouldFollow(false, false, false), false);
  assert.equal(droppedNote(0), "");
  assert.equal(droppedNote(1), "[1 earlier character not shown]\n");
  assert.equal(droppedNote(2400), "[2400 earlier characters not shown]\n");
  assert.equal(EMPTY_TEXT, "No output yet.");
});

test("terminal output stays text: markup is kept as characters, and a gap is marked in front of it", () => {
  const hostile = "<script>alert(1)</script><img src=x onerror=alert(1)>";
  assert.equal(applyOutput("", "snapshot", { text: hostile, dropped: 12 }), `[12 earlier characters not shown]\n${hostile}`);
  assert.equal(applyOutput("hello\n", "data", { text: hostile, dropped: 0 }), `hello\n${hostile}`);
  assert.equal(applyOutput("hello\n", "data", { text: "more", dropped: 4 }), "hello\n[4 earlier characters not shown]\nmore");
  assert.equal(applyOutput("keep", "status", { status: "exited" }), "keep", "a status event does not rewrite the scrollback");
  assert.equal(applyOutput("x", "snapshot", { text: 12, dropped: "nope" }), "", "a non-string payload becomes empty text, not HTML");
  assert.equal(applyOutput("", "snapshot", { text: 12 }), "");
});

test("terminal pane is built with textContent, and the page wires the chip, the stream, and the phone sheet", () => {
  const js = read("terminal-pane.js");
  assert.match(js, /textContent/);
  assert.match(js, /out\.textContent = shown/);
  assert.match(js, /if \(painting\) return/);
  assert.match(js, /shouldFollow/);
  assert.match(js, /applyOutput/);
  assert.match(js, /classList\.toggle\("term-open"/);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(js, /info\.id/);
  assert.match(js, /info\.shell/);
  assert.match(js, /info\.cwd/);
  assert.match(js, /info\.status/);
  assert.match(js, /\/stream/);
  assert.match(js, /\/input/);
  assert.match(js, /\/resize/);
  assert.match(js, /vendor\/xterm\/xterm\.mjs/);
  assert.match(js, /CSSStyleSheet/);
  assert.match(js, /addon-fit\.mjs/);
  assert.match(js, /onData/);
  assert.match(js, /shouldPoll/);
  assert.match(js, /sessionTypeable/);
  const html = read("index.html");
  assert.match(html, /id="btn-terminal"/);
  assert.match(html, /id="term-pane"/);
  assert.match(html, /id="term-out"/);
  assert.match(html, /id="term-empty"/);
  assert.match(html, /Daebot's terminal/);
  assert.match(html, /id="term-screen"/);
  assert.match(html, /id="term-note"/);
  assert.match(html, /vendor\/xterm\/xterm\.css/);
  const app = read("app.js");
  assert.match(app, /initTerminalPane/);
  assert.match(app, /from "\/terminal-pane\.js"/);
  assert.match(app, /ev\.tool === "terminal"/);
  assert.match(app, /termPane\.sync\(\)/);
  assert.match(app, /emptyEl: \$\("term-empty"\)/);
  assert.match(app, /screenEl: \$\("term-screen"\)/);
  assert.match(app, /noteEl: \$\("term-note"\)/);
  const css = read("style.css");
  assert.match(css, /\.term-pane \{/);
  assert.match(css, /\.term-pane \{[^}]*top: calc\(56px \+ env\(safe-area-inset-top\)\)/);
  assert.match(css, /\.term-out \{[^}]*var\(--mono\)/);
  assert.match(css, /html\.term-open \.scroll, html\.term-open \.composer-wrap \{ margin-right: min\(440px, 42vw\); \}/);
  assert.match(css, /html\.pty-shot \.term-pane \{ width: min\(720px, 50vw\); \}/);
  assert.match(css, /\.term-screen \{[^}]*var\(--plate\)/);
  assert.match(css, /\.term-screen \.xterm-rows \{ color: var\(--term-fg\); \}/);
  assert.match(css, /\.term-note \{/);
  assert.match(css, /\.term-pane \{ top: auto; left: 0; width: auto; height: min\(52dvh, 440px\)/);
  assert.match(css, /html\.term-open \.scroll, html\.term-open \.composer-wrap \{ margin-right: 0; \}/);
  assert.match(css, /\.win-overlay \.term-pane, \.mac-inset \.term-pane \{ -webkit-app-region: no-drag; \}/);
});

test("a second follow while the PTY is mounting does not leave an empty terminal in the pane", async () => {
  const g = globalThis as any;
  const prevDocument = g.document;
  const prevRaf = g.requestAnimationFrame;
  const prevFetch = g.fetch;
  const prevSetInterval = globalThis.setInterval;
  const prevClearInterval = globalThis.clearInterval;
  const rafs: Array<() => void> = [];
  const timers = new Set<ReturnType<typeof setInterval>>();
  g.requestAnimationFrame = (fn: () => void) => { rafs.push(fn); return rafs.length; };
  g.setInterval = (fn: () => void, ms?: number) => { const id = prevSetInterval(fn, ms); timers.add(id); return id; };
  g.clearInterval = (id: ReturnType<typeof setInterval>) => { timers.delete(id); prevClearInterval(id); };

  function el(): any {
    const listeners: Record<string, Array<(...args: any[]) => void>> = {};
    const node: any = {
      hidden: false,
      className: "",
      textContent: "",
      title: "",
      type: "",
      style: {},
      dataset: {},
      attrs: {},
      children: [],
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute(k: string, v: string) { node.attrs[k] = v; },
      getAttribute(k: string) { return node.attrs[k]; },
      removeAttribute(k: string) { delete node.attrs[k]; },
      addEventListener(type: string, fn: (...args: any[]) => void) { (listeners[type] ||= []).push(fn); },
      click() { for (const fn of listeners.click || []) fn(); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      replaceChildren(...nodes: any[]) { node.children = [...nodes]; },
      append(...nodes: any[]) { node.children.push(...nodes); },
      focus() {},
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
    };
    return node;
  }

  const terms: FakeTerm[] = [];
  class FakeTerm {
    cols = 80;
    rows = 24;
    writes: string[] = [];
    opened = false;
    disposed = false;
    target: unknown = null;
    _core = { _charSizeService: { hasValidSize: true, measure() {} } };
    constructor() { terms.push(this); }
    loadAddon(): void {}
    open(target: unknown): void { this.opened = true; this.target = target; }
    dispose(): void { this.disposed = true; }
    onData(): void {}
    reset(): void { this.writes.push("reset"); }
    write(data: string, cb?: () => void): void { this.writes.push(data); if (cb) cb(); }
    focus(): void {}
  }
  class FakeFit { fit() {} }

  const heading = el();
  const chip = el();
  const pane = el();
  pane.hidden = true;
  pane.querySelector = () => heading;
  const list = el();
  const out = el();
  const screenEl = el();
  const emptyEl = el();
  const exitEl = el();
  const noteEl = el();
  g.document = { createElement: () => el(), documentElement: el(), adoptedStyleSheets: [] };

  let current: string | null = "s1";
  let releaseList = () => {};
  let listGate = Promise.resolve();
  const armList = () => { listGate = new Promise((resolve) => { releaseList = resolve; }); };
  const session = { id: "t1", shell: "bash", cwd: "/tmp/pty-color", status: "running", backend: "pty", typeable: true };
  const marker = "daebot-pty-color";
  async function fetchImpl(url: string): Promise<any> {
    const path = String(url);
    if (path.endsWith("/terminals")) {
      await listGate;
      return { ok: true, json: async () => ({ terminals: [session] }) };
    }
    if (path.endsWith("/stream")) {
      const chunk = `event: snapshot\ndata: ${JSON.stringify({ screen: `hello ${marker}\r\n`, text: `hello ${marker}\n`, info: session })}\n\n`;
      const value = new TextEncoder().encode(chunk);
      let sent = false;
      return {
        ok: true,
        status: 200,
        body: { getReader: () => ({ async read() { if (sent) return { done: true, value: undefined }; sent = true; return { done: false, value }; } }) },
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  const micro = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const pump = async () => {
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
      const batch = rafs.splice(0, rafs.length);
      for (const fn of batch) fn();
    }
  };

  g.fetch = fetchImpl;
  const api = initTerminalPane({
    json: async (path: string) => (await fetchImpl(path)).json(),
    authHeaders: () => ({}),
    currentId: () => current,
    chip, pane, list, out, screenEl, emptyEl, exitEl, noteEl,
    loadXterm: async () => ({ Terminal: FakeTerm, FitAddon: FakeFit }),
  });

  try {
    api.sync();
    await micro();
    assert.equal(terms.length, 0, "a hidden pane does not mount a terminal");
    assert.equal(list.children.length, 1);

    armList();
    chip.click();
    await micro();
    assert.equal(terms.length, 1, "opening the pane constructs one terminal and then waits for layout");
    assert.equal(terms[0].opened, false);
    releaseList();
    await micro();
    assert.equal(terms.length, 1, "refresh during that wait must not start a second mount");

    list.children[0].click();
    await micro();
    assert.equal(terms.length, 2, "a new selection starts a new mount");
    await pump();

    const live = terms.filter((t) => t.opened && !t.disposed);
    assert.equal(live.length, 1, "only the latest terminal stays open in the pane");
    assert.equal(terms[0].disposed, true);
    assert.equal(terms[0].opened, false, "the stale mount does not open into the same element");
    assert.equal(live[0].writes.some((w) => w.includes(marker)), true);
    assert.equal(terms[0].writes.some((w) => w.includes(marker)), false);
  } finally {
    current = null;
    releaseList();
    api.sync();
    await micro();
    for (const id of timers) prevClearInterval(id);
    g.setInterval = prevSetInterval;
    g.clearInterval = prevClearInterval;
    g.requestAnimationFrame = prevRaf;
    g.fetch = prevFetch;
    g.document = prevDocument;
  }
});
