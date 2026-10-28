// How Daebot feels on a phone: the iPhone app (WKWebView on daebot.live) and mobile Safari.
// Static checks of the shipped files plus a stubbed-DOM run of /shell.js, so an edit cannot quietly bring back
// the zoom-on-focus, the sideways slide, the keyboard shoving the page, or a login page that loses its guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { startGateway } from "../../src/gateway/index.ts";
import { fakeRuntime, http, tmpStatic } from "../gateway/helpers.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const read = (f: string) => readFileSync(join(web, f), "utf8");

test("index.html, login.html and the login template load /shell.js right after the viewport meta and /touch.css last", () => {
  for (const f of ["index.html", "login.html", "brand/login-src/login.html.tpl"]) {
    const html = read(f);
    assert.match(html, /<meta name="viewport"[^>]*>\s*<script src="\/shell\.js"><\/script>/, `${f}: shell.js must follow the viewport meta (it edits it before first paint)`);
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    assert.equal(sheets.at(-1), "/touch.css", `${f}: touch.css loads after every other stylesheet so it can override them (${sheets.join(", ")})`);
  }
});

test("the hosted login page can fetch /shell.js and /touch.css before anyone is signed in", async () => {
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"], ["shell.js", "/* shell */"], ["touch.css", "html{}"]]) writeFileSync(join(st.dir, f), c);
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: { token: "t".repeat(32), allowedHosts: ["daebot.live", "localhost"] } });
  try {
    const H = { host: "daebot.live", "x-forwarded-proto": "https" };
    assert.equal((await http(gw.url, "GET", "/shell.js", { headers: H })).status, 200);
    assert.equal((await http(gw.url, "GET", "/touch.css", { headers: H })).status, 200);
    assert.equal((await http(gw.url, "GET", "/app.js", { headers: H })).status, 401, "the app itself stays behind the login");
  } finally { await gw.close(); }
});

// ---------- touch.css ----------
const touch = read("touch.css");
/** The body of the first @media block whose query contains `q` (brace matched). */
function mediaBlock(css: string, q: string): string {
  const at = css.indexOf(q);
  assert.ok(at >= 0, `no ${q} block`);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced braces");
}

test("touch.css: every text field is 16px on a touch device, in every file that sizes one (iOS zooms the page on focus below 16px)", () => {
  const coarse = mediaBlock(touch, "@media (pointer: coarse), (hover: none)");
  const rule = coarse.match(/(input:not\([^{]+),\s*\n?\s*(textarea[^{]*),\s*(select[^{]*)\{\s*font-size:\s*16px;?\s*\}/);
  assert.ok(rule, "one rule sets font-size: 16px on input, textarea and select");
  // the Apps card form (.app-field input), the login keys, the confirm reply box and the connector search are all plain inputs: nothing excludes them
  for (const type of ["text", "password", "search", "email", "url"]) assert.ok(!rule![1].includes(`[type="${type}"]`), `type=${type} must not be excluded`);
  assert.match(rule![1], /:not\(\[type="checkbox"\]\)/);
  assert.match(rule![1], /:not\(\[type="radio"\]\)/);
  // a textarea rule must out-rank `.caelum .fld-area` (0,2,0): three :not() on top of the element
  assert.ok((rule![2].match(/:not\(/g) ?? []).length >= 3, "textarea selector is specific enough to beat the class rules that set 13px and 14px");
  // and no field-sizing rule written AFTER touch.css could slip under it: it is the last stylesheet (see the HTML test)
  const smaller = [...read("style.css").matchAll(/(\.app-field input|\.fld|\.fld-area|\.token-card input|\.confirm input)[^{]*\{[^}]*font(?:-size)?:\s*(?:\d+(?:\.\d+)?px )?(\d+(?:\.\d+)?)px/g)];
  assert.ok(smaller.length > 0, "the 13px and 14px field rules still exist, which is why the override above is needed");
});

test("touch.css: pull-to-bounce is off on the chat shell only, scrollers keep their own bounce, taps are not delayed or flashed", () => {
  assert.match(touch, /html\s*\{[^}]*-webkit-tap-highlight-color:\s*transparent/);
  assert.match(touch, /html\s*\{[^}]*touch-action:\s*manipulation/);
  assert.match(touch, /html\s*\{[^}]*-webkit-text-size-adjust:\s*100%/);
  assert.match(touch, /html:not\(:has\(> body\.login-body\)\), body:not\(\.login-body\)\s*\{\s*overscroll-behavior:\s*none/);
  assert.match(touch, /\.scroll[^{]*\{\s*overscroll-behavior:\s*contain/);
});

test("touch.css: the page is pinned to the visible area when the keyboard is up, and the composer drops its home-indicator gutter", () => {
  assert.match(touch, /html\.vv \.app\s*\{[^}]*position:\s*fixed;[^}]*top:\s*var\(--vvt[^}]*height:\s*var\(--vvh/);
  assert.match(touch, /html\.vv \.gate-token[^{]*\{[^}]*top:\s*var\(--vvt[^}]*height:\s*var\(--vvh/);
  assert.match(touch, /html\.kb \.composer-wrap\s*\{\s*padding-bottom:\s*8px/);
});

test("touch.css: nothing can make the message list wider than the screen (long tool names shrink, machine strings wrap)", () => {
  assert.match(touch, /\.scroll\s*\{\s*overflow-x:\s*hidden/);
  assert.match(touch, /\.tool-name\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/);
  assert.match(touch, /\.confirm \.act-tool[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
});

test("touch.css: small controls get a 44pt hit area without changing how they look, stacked rows get real height", () => {
  const coarse = mediaBlock(touch, "@media (pointer: coarse), (hover: none)");
  for (const sel of [".icon-btn", ".send", ".mic", ".attach", ".model-badge", ".mode-btn", ".acct-btn", ".seg-btn", ".copy"]) {
    assert.ok(new RegExp(`${sel.replace(".", "\\.")}::before`).test(coarse), `${sel} has an invisible ::before hit area`);
  }
  assert.ok(!/\.row-del[^{]*\{[^}]*position:\s*relative/.test(coarse), ".row-del is absolutely positioned by style.css and must stay so");
  assert.match(coarse, /\.am-item, \.am-acct\s*\{\s*min-height:\s*44px/);
  assert.match(coarse, /\.btn-new, \.btn-primary, \.btn-quiet, \.btn-danger, \.login-btn, \.app-btn\s*\{\s*min-height:\s*44px/);
});

// ---------- shell.js, run against a stub DOM ----------
const shellSrc = read("shell.js");

type Listener = (e?: any) => void;
function boot(o: { ua: string; platform?: string; touch?: number; capacitor?: any; handlers?: any; vv?: { height: number; offsetTop?: number; scale?: number } | null }) {
  const classes = new Set<string>();
  const props = new Map<string, string>();
  const winL = new Map<string, Listener[]>(), docL = new Map<string, Listener[]>(), vvL = new Map<string, Listener[]>();
  const add = (m: Map<string, Listener[]>) => (t: string, f: Listener) => { m.set(t, [...(m.get(t) ?? []), f]); };
  const meta = { content: "width=device-width, initial-scale=1, viewport-fit=cover", setAttribute(k: string, v: string) { if (k === "content") this.content = v; } };
  const events: string[] = [];
  const doc: any = {
    activeElement: null,
    documentElement: {
      classList: { add: (...c: string[]) => c.forEach((x) => classes.add(x)), remove: (...c: string[]) => c.forEach((x) => classes.delete(x)), toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
      style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
    },
    querySelector: (s: string) => (s === 'meta[name="viewport"]' ? meta : null),
    addEventListener: add(docL),
  };
  const vv: any = o.vv === null ? undefined : { height: o.vv?.height ?? 800, offsetTop: o.vv?.offsetTop ?? 0, scale: o.vv?.scale ?? 1, addEventListener: add(vvL) };
  const win: any = {
    Capacitor: o.capacitor, webkit: o.handlers ? { messageHandlers: o.handlers } : undefined, visualViewport: vv,
    scrollX: 0, scrollY: 0, scrollToCalls: [] as number[][], scrollTo(x: number, y: number) { this.scrollToCalls.push([x, y]); },
    addEventListener: add(winL), dispatchEvent: (e: any) => { events.push(e.type + ":" + JSON.stringify(e.detail)); return true; },
  };
  const ctx: any = { window: win, document: doc, navigator: { userAgent: o.ua, platform: o.platform ?? "iPhone", maxTouchPoints: o.touch ?? 5 }, CustomEvent: class { type: string; detail: any; constructor(t: string, i: any) { this.type = t; this.detail = i?.detail; } }, setTimeout: (f: () => void) => { f(); return 0; } };
  vm.runInNewContext(shellSrc, ctx, { filename: "shell.js" });
  return { classes, props, meta, win, doc, vv, events, fire: (t: Map<string, Listener[]>, type: string, e: any = {}) => (t.get(type) ?? []).forEach((f) => f(e)), winL, docL, vvL };
}
const IOS_APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 DaebotApp/ios 1.0.0 (5)";
const IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Safari/605.1.15";

test("shell.js: inside the iPhone app the viewport is locked to scale 1 (no pinch, no zoom-on-focus drift), by user agent or by the native bridge", () => {
  for (const cfg of [{ ua: IOS_APP }, { ua: IOS_SAFARI, handlers: { daebotAuth: {} } }, { ua: IOS_SAFARI, capacitor: { getPlatform: () => "ios" } }]) {
    const r = boot(cfg);
    assert.match(r.meta.content, /maximum-scale=1/);
    assert.match(r.meta.content, /user-scalable=no/);
    assert.match(r.meta.content, /viewport-fit=cover/, "the notch handling is kept");
    assert.ok(r.classes.has("in-app") && r.classes.has("ios-app"));
    assert.ok((r.docL.get("gesturestart") ?? []).length > 0, "pinch gesture events are cancelled");
    let prevented = false;
    r.fire(r.docL, "gesturestart", { preventDefault: () => { prevented = true; } });
    assert.ok(prevented);
  }
});

test("shell.js: mobile Safari keeps pinch zoom (it ignores the lock on purpose, and people rely on it); desktop and Android are untouched", () => {
  const safari = boot({ ua: IOS_SAFARI });
  assert.ok(!/maximum-scale|user-scalable/.test(safari.meta.content), safari.meta.content);
  assert.ok(!safari.classes.has("in-app") && !safari.classes.has("ios-app"));
  const desktop = boot({ ua: DESKTOP, platform: "MacIntel", touch: 0 });
  assert.equal(desktop.meta.content, "width=device-width, initial-scale=1, viewport-fit=cover");
  assert.equal(desktop.classes.size, 0);
  assert.equal(desktop.props.size, 0);
  const android = boot({ ua: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36", platform: "Linux armv8l", handlers: undefined });
  assert.equal(android.classes.size, 0);
  assert.equal(android.props.size, 0);
});

test("shell.js: sideways scroll is undone in the app (zoom is locked, so the page never has a reason to pan)", () => {
  const r = boot({ ua: IOS_APP });
  r.win.scrollX = 13; r.win.scrollY = 5;
  r.fire(r.winL, "scroll");
  assert.deepEqual(r.win.scrollToCalls.at(-1), [0, 5]);
  r.win.scrollX = 0; r.win.scrollToCalls.length = 0;
  r.fire(r.winL, "scroll");
  assert.equal(r.win.scrollToCalls.length, 0, "a vertical scroll is left alone");
});

test("shell.js: the keyboard pins the layout to the visible area, tells the message list, and gives the gutter back when it goes", () => {
  const r = boot({ ua: IOS_APP, vv: { height: 874 } });
  assert.equal(r.props.get("--vvh"), "874px");
  assert.equal(r.props.get("--vvt"), "0px");
  assert.ok(r.classes.has("vv") && !r.classes.has("kb"));
  // the user taps the composer: a textarea has focus and the visible height drops to 471 while the page is panned 403
  r.doc.activeElement = { tagName: "TEXTAREA", type: "textarea" };
  r.vv.height = 471; r.vv.offsetTop = 403;
  r.fire(r.vvL, "resize");
  assert.equal(r.props.get("--vvh"), "471px");
  assert.equal(r.props.get("--vvt"), "403px");
  assert.ok(r.classes.has("kb"));
  assert.ok(r.events.some((e) => e === 'daebot:viewport:{"keyboard":true}'), r.events.join(" | "));
  // dismissed
  r.doc.activeElement = null;
  r.vv.height = 874; r.vv.offsetTop = 0;
  r.fire(r.vvL, "resize");
  assert.equal(r.props.get("--vvh"), "874px");
  assert.ok(!r.classes.has("kb"));
  assert.ok(r.events.at(-1)?.endsWith('{"keyboard":false}'));
});

test("shell.js: a pinch-zoomed browser tab keeps its own layout, and a short visible area with no field focused is not a keyboard", () => {
  const r = boot({ ua: IOS_SAFARI, vv: { height: 800 } });
  assert.ok(r.classes.has("vv"));
  r.vv.scale = 2; r.vv.height = 400;
  r.fire(r.vvL, "resize");
  assert.ok(!r.classes.has("vv") && !r.props.has("--vvh"), "zoomed in: back to 100dvh");
  const s = boot({ ua: IOS_SAFARI, vv: { height: 800 } });
  s.vv.height = 650; // Safari's toolbar came back, nothing focused
  s.fire(s.vvL, "resize");
  assert.ok(!s.classes.has("kb"));
  assert.equal(s.props.get("--vvh"), "650px");
});

test("shell.js: no visualViewport (old WebView) means no keyboard handling and no crash; the file parses as a classic script", () => {
  const r = boot({ ua: IOS_APP, vv: null });
  assert.ok(r.classes.has("ios-app"));
  assert.equal(r.props.size, 0);
  assert.doesNotThrow(() => new vm.Script(shellSrc));
  assert.ok(!/^\s*(import|export)\s/m.test(shellSrc), "a classic script: no module syntax");
});

test("app.js re-pins a reader to the bottom when the keyboard comes or goes", () => {
  assert.match(read("app.js"), /window\.addEventListener\("daebot:viewport", \(\) => toBottom\(\)\)/);
});
