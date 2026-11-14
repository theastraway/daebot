import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_PARTITION, clampPaneWidth, defaultPaneWidth, downloadPath, navigationAllowed, pageWebPreferences, shouldTakeOver } from "../src/lib/browser-policy.mjs";
import { createBrowserPane } from "../src/lib/browser-pane.mjs";
import { startBrowserChannel } from "../src/lib/browser-channel.mjs";

function fakeWc() {
  const listeners = {};
  return {
    url: "",
    title: "",
    loaded: [],
    on(ev, fn) { (listeners[ev] ||= []).push(fn); },
    emit(ev, ...args) { for (const fn of listeners[ev] || []) fn(...args); },
    loadURL(url) { this.loaded.push(url); this.url = url; return Promise.resolve(); },
    getURL() { return this.url; },
    getTitle() { return this.title; },
    setWindowOpenHandler(fn) { this.openHandler = fn; },
    debugger: {
      attached: false,
      version: "",
      last: null,
      attach(v) { this.version = v; this.attached = true; return Promise.resolve(); },
      sendCommand(method, params) { this.last = { method, params }; return Promise.resolve({ ok: true }); },
    },
    destroy() { this.destroyed = true; },
    capturePage() { return { empty: false }; },
  };
}

function harness() {
  const ses = {
    partition: "",
    req: null,
    check: null,
    downloadFn: null,
    flushed: 0,
    setPermissionRequestHandler(fn) { this.req = fn; },
    setPermissionCheckHandler(fn) { this.check = fn; },
    on(ev, fn) { if (ev === "will-download") this.downloadFn = fn; },
    cookies: { flushStore: async () => { ses.flushed += 1; } },
  };
  const views = [];
  class WebContentsView {
    constructor(opts) {
      this.webPreferences = opts.webPreferences;
      this.webContents = fakeWc();
      this.bounds = null;
      views.push(this);
    }
    setBounds(b) { this.bounds = { ...b }; }
  }
  const contentView = {
    children: [],
    addChildView(v) { if (!this.children.includes(v)) this.children.push(v); },
    removeChildView(v) { this.children = this.children.filter((x) => x !== v); },
  };
  const userData = mkdtempSync(join(tmpdir(), "mc-browser-desk-"));
  return { ses, views, contentView, userData, session: { fromPartition(name) { ses.partition = name; return ses; } }, WebContentsView };
}

test("page preferences use the browser partition and refuse a preload", () => {
  const prefs = pageWebPreferences();
  assert.equal(prefs.partition, "persist:daebot-browser");
  assert.equal(BROWSER_PARTITION, "persist:daebot-browser");
  assert.notEqual(prefs.partition, "mindclaw");
  assert.equal("preload" in prefs, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(navigationAllowed("file:///tmp/x").ok, false);
  assert.equal(navigationAllowed("javascript:alert(1)").ok, false);
  assert.equal(navigationAllowed("http://127.0.0.1:1/x", "http://127.0.0.1:1").ok, false);
  assert.equal(navigationAllowed("http://127.0.0.1:9/").ok, true);
  const dir = join("/tmp/daebot-ud", "daebot-browser-downloads");
  assert.equal(downloadPath("/tmp/daebot-ud", "../../etc/passwd"), join(dir, "passwd"));
  assert.equal(downloadPath("/tmp/daebot-ud", ""), join(dir, "download"));
  assert.equal(shouldTakeOver("mouse", { type: "mouseDown" }, 500, 100), false);
  assert.equal(shouldTakeOver("mouse", { type: "mouseDown" }, 500, 500), true);
  assert.equal(shouldTakeOver("mouse", { type: "mouseMove" }, 0, 10), false);
  assert.equal(shouldTakeOver("key", { type: "keyDown" }, 0, 10), true);
  assert.equal(defaultPaneWidth(1440), 648);
  assert.equal(clampPaneWidth(100), 420);
  assert.equal(clampPaneWidth(900), 760);
  assert.equal(clampPaneWidth(0), 0);
});

test("pane: one attached tab, scheme refusal, window.open, permissions, downloads, takeover", async () => {
  const h = harness();
  let clock = 1_000;
  const pane = createBrowserPane({
    WebContentsView: h.WebContentsView,
    session: h.session,
    userData: h.userData,
    contentView: h.contentView,
    getContentBounds: () => ({ width: 1440, height: 900 }),
    getGatewayOrigin: () => "http://127.0.0.1:1",
    now: () => clock,
  });
  assert.equal(h.ses.partition, "persist:daebot-browser");
  assert.equal(h.views[0], undefined);
  let denied = null;
  h.ses.req({}, "media", (allow) => { denied = allow; });
  assert.equal(denied, false);
  assert.equal(h.ses.check(), false);

  await assert.rejects(() => pane.handle("open", { url: "file:///etc/passwd" }), /file:/);
  await assert.rejects(() => pane.handle("open", { url: "http://127.0.0.1:1/devices" }), /gateway/);
  assert.equal(h.views.length, 0);

  const opened = await pane.handle("open", { url: "http://127.0.0.1:9/shop" });
  assert.equal(opened.tabId.startsWith("t"), true);
  assert.equal(h.views[0].bounds.width, defaultPaneWidth(1440));
  assert.equal(pane.snapshot().pane.width, 0, "the CSS default is not stored until the user resizes");
  assert.equal(h.views.length, 1);
  assert.equal(h.views[0].webPreferences.partition, "persist:daebot-browser");
  assert.equal("preload" in h.views[0].webPreferences, false);
  assert.equal(h.contentView.children.length, 1);
  assert.deepEqual(h.views[0].webContents.loaded, ["http://127.0.0.1:9/shop"]);

  const second = await pane.handle("open", { url: "https://example.com/a" });
  assert.notEqual(second.tabId, opened.tabId);
  assert.equal(h.contentView.children.length, 1);
  assert.equal(h.contentView.children[0], h.views[1]);

  const blocked = { prevented: false, preventDefault() { this.prevented = true; } };
  h.views[1].webContents.emit("will-navigate", blocked, "javascript:alert(1)");
  assert.equal(blocked.prevented, true);

  const popup = h.views[1].webContents.openHandler({ url: "https://example.com/b" });
  assert.deepEqual(popup, { action: "deny" });
  assert.equal(h.views.length, 3);
  const refused = h.views[1].webContents.openHandler({ url: "chrome://settings" });
  assert.deepEqual(refused, { action: "deny" });
  assert.equal(h.views.length, 3);

  let saved = "";
  const item = { getFilename: () => "../secret.txt", setSavePath(p) { saved = p; }, cancel() { saved = "cancelled"; } };
  h.ses.downloadFn({}, item);
  assert.match(saved, /daebot-browser-downloads\/secret\.txt$/);
  assert.doesNotMatch(saved, /\.\./);

  const tabId = pane.snapshot().tabs.find((t) => t.active).id;
  const wc = pane.activeWebContents();
  await pane.handle("cdp", { tabId, method: "Input.dispatchMouseEvent", params: { type: "mousePressed" } });
  assert.equal(wc.debugger.version, "1.3");
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  assert.equal(pane.snapshot().tabs.find((t) => t.id === tabId).control, "agent");
  clock += 500;
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  assert.equal(pane.snapshot().tabs.find((t) => t.id === tabId).control, "user");
  await assert.rejects(() => pane.handle("cdp", { tabId, method: "Input.insertText", params: { text: "nope" } }), /user has control/);
  wc.emit("before-input-event", {}, { type: "keyDown" });
  assert.equal(pane.snapshot().tabs.find((t) => t.id === tabId).control, "user");

  const widths = [];
  pane.destroy();
  const sized = createBrowserPane({
    WebContentsView: h.WebContentsView,
    session: h.session,
    userData: h.userData,
    contentView: h.contentView,
    getContentBounds: () => ({ width: 1440, height: 900 }),
    initialWidth: 700,
    onWidth: (w) => widths.push(w),
  });
  assert.equal(sized.snapshot().pane.width, 700);
  await sized.handle("open", { url: "http://127.0.0.1:9/wide" });
  assert.equal(h.views.at(-1).bounds.width, 700);
  sized.setViewport({ x: 700, y: 80, width: 500, height: 600 });
  assert.equal(h.views.at(-1).bounds.width, 500);
  assert.equal(sized.snapshot().pane.width, 700, "a viewport report does not count as a resized pane");
  await sized.handle("pane", { open: true, width: 900 });
  assert.deepEqual(widths, [760]);
  assert.equal(sized.snapshot().pane.width, 760);
  assert.equal(h.views.at(-1).bounds.width, 760);

  await pane.flush();
  assert.equal(h.ses.flushed, 1);
  sized.destroy();
  assert.equal(h.contentView.children.length, 0);
});

test("browser channel sends the bearer token and posts the command result", async () => {
  const calls = [];
  const logs = [];
  const pane = {
    async handle(op, args) { return { handled: op, args }; },
    snapshot: () => ({ partition: "persist:daebot-browser", pane: { open: false, width: 440 }, tabs: [] }),
    subscribe() { return () => {}; },
  };
  let polls = 0;
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).includes("/browser/poll")) {
      polls += 1;
      if (polls === 1) return { ok: true, json: async () => ({ commands: [{ id: "c1", op: "open", args: { url: "http://127.0.0.1:9/" } }] }) };
      return { ok: true, json: async () => ({ commands: [] }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const channel = startBrowserChannel({
    fetch, origin: "http://127.0.0.1:4", token: "sekret-token", pane, waitMs: 0, retryMs: 5,
    sleep: () => new Promise((r) => setTimeout(r, 5)),
    log: (...a) => logs.push(a.join(" ")),
  });
  for (let i = 0; i < 40 && !calls.some((c) => c.url.endsWith("/browser/result")); i++) await new Promise((r) => setTimeout(r, 15));
  channel.stop();
  assert.ok(calls.length > 0);
  for (const c of calls) assert.equal(c.opts.headers.authorization, "Bearer sekret-token");
  const result = calls.find((c) => c.url.endsWith("/browser/result"));
  assert.ok(result);
  assert.deepEqual(JSON.parse(result.opts.body), { id: "c1", ok: true, result: { handled: "open", args: { url: "http://127.0.0.1:9/" } } });
  const state = calls.find((c) => c.url.endsWith("/browser/state"));
  assert.match(state.opts.body, /persist:daebot-browser/);
  assert.doesNotMatch(state.opts.body, /cookie/i);
  assert.equal(logs.some((l) => l.includes("sekret-token")), false);
});
