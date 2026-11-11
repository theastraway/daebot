// The macOS backend of the `app` tool: the Accessibility API (AXUIElement) driven through System Events from one `osascript -l JavaScript` process.
// Same promise as the Windows backend: it never moves the mouse, never posts a keystroke (no `click at`, no `keystroke`), never activates an app and
// takes no screenshot unless asked. Every control is reached by an AX action (AXPress, AXShowMenu, AXCancel, AXPick) or an AX attribute
// (AXValue, AXSelected). The interpreter below is a fixed script; the steps travel as ONE argv item (JSON data), never as code.
// Terminals are refused (by process name) in the script and again before launch. dry_run (or DAEBOT_APP_DRY_RUN=1) resolves the control and says what
// it WOULD do without doing it; list_windows, tree, find, get_text and wait only read.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAC_SHOT_MAX_WIDTH, MAC_TERMINAL_APPS, isMacTerminalApp, runMacExec } from "./computer-mac.ts";
import type { MacExec } from "./computer-mac.ts";

export interface MacAppStep {
  action: string;
  window?: string;
  name?: string; type?: string; id?: string; exact?: boolean; index?: number;
  value?: string; max?: number; depth?: number; all?: boolean;
  state?: "on" | "off"; add?: boolean;
  app?: string; args?: string; timeout_s?: number;
}

/** Actions that change an app; with dry run these resolve the control and report, and do not act. */
export const MAC_WRITE_ACTIONS = ["invoke", "set_value", "select", "toggle", "expand", "collapse", "launch", "close"];

/** Windows UI Automation control names map to AX roles; an AX role (AXButton) is also accepted as is. */
export const AX_ROLES: Record<string, string[]> = {
  button: ["AXButton"], edit: ["AXTextField", "AXTextArea", "AXSecureTextField", "AXSearchField"], menuitem: ["AXMenuItem", "AXMenuBarItem"],
  menu: ["AXMenu", "AXMenuBar"], checkbox: ["AXCheckBox"], radiobutton: ["AXRadioButton"], combobox: ["AXComboBox", "AXPopUpButton"],
  listitem: ["AXRow", "AXCell"], list: ["AXList", "AXTable", "AXOutline"], tabitem: ["AXTab", "AXRadioButton"], tab: ["AXTabGroup"],
  document: ["AXTextArea", "AXWebArea", "AXScrollArea"], hyperlink: ["AXLink"], text: ["AXStaticText"], image: ["AXImage"],
  slider: ["AXSlider"], window: ["AXWindow"], group: ["AXGroup"], toolbar: ["AXToolbar"], treeitem: ["AXRow"], progressbar: ["AXProgressIndicator"],
};

// The interpreter (JXA). `run(argv)`: argv[0] is the job JSON {steps, shot, shotWindow, stopOnError, dry, terminals}.
export const MAC_APP_JXA = String.raw`
ObjC.import('Foundation');
ObjC.import('CoreGraphics');
var SE = Application('System Events');
var ROLES = %ROLES%;
var NOTE = '';
function short(s, n) { if (s === null || s === undefined) return ''; var t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '...' : t; }
function tryv(f, d) { try { var v = f(); return (v === undefined || v === null) ? d : v; } catch (e) { return d; } }
function axErr(e) {
  var m = String(e && e.message ? e.message : e);
  if (/assistive|-25211|-25204|not allowed|-1719/i.test(m)) return 'Accessibility is off for Daebot. Turn it on in System Settings, Privacy & Security, Accessibility.';
  return m;
}
function isTerm(proc) { return JOB.terminals.indexOf(String(proc).trim().toLowerCase()) >= 0; }
function blocked(proc, title) { console.log('DAEBOT_BLOCKED ' + proc + ' | ' + title); throw {blocked: true}; }
function procs() { return SE.processes.whose({backgroundOnly: false})(); }
function listWins() {
  var out = [];
  procs().forEach(function (p) {
    var name = tryv(function () { return p.name(); }, '');
    var pid = tryv(function () { return p.unixId(); }, 0);
    var titles = tryv(function () { return p.windows.name(); }, []);
    titles.forEach(function (t, i) { out.push({p: p, proc: name, pid: pid, title: t === null ? '' : String(t), i: i}); });
  });
  return out;
}
function findWin(spec) {
  if (!spec) throw new Error('window is required (part of the title, the app name, or pid:123)');
  spec = String(spec);
  var wins = listWins(), m = [], mt = spec.match(/^pid:(\d+)$/);
  if (mt) { m = wins.filter(function (w) { return w.pid === Number(mt[1]); }); }
  else {
    var q = spec.toLowerCase();
    m = wins.filter(function (w) { return w.title.toLowerCase().indexOf(q) >= 0 || w.proc.toLowerCase() === q; });
    var ex = m.filter(function (w) { return w.title === spec; });
    if (ex.length) m = ex;
  }
  if (!m.length) throw new Error("no window matches '" + spec + "'. Use list_windows to see the open windows.");
  var w = m[0];
  if (isTerm(w.proc)) blocked(w.proc, w.title);
  if (m.length > 1) NOTE = ' (' + m.length + ' windows match; used "' + short(w.title, 40) + '", pass pid:N to pick another)';
  w.el = w.p.windows[w.i];
  return w;
}
function roleSet(t) {
  if (!t) return null;
  var k = String(t).toLowerCase();
  if (ROLES[k]) return ROLES[k];
  if (/^AX[A-Za-z]+$/.test(t)) return [t];
  throw new Error("unknown control type '" + t + "' (use Button, Edit, MenuItem, CheckBox, RadioButton, ComboBox, ListItem, TabItem, Document, Hyperlink, Text or an AX role like AXButton)");
}
function label(el) {
  var s = tryv(function () { return el.title(); }, '');
  if (!s) s = tryv(function () { return el.name(); }, '');
  if (!s) s = tryv(function () { return el.description(); }, '');
  if (!s) { var v = tryv(function () { return el.value(); }, ''); if (typeof v === 'string') s = v; }
  return s ? String(s) : '';
}
function axid(el) { return String(tryv(function () { return el.attributes.byName('AXIdentifier').value(); }, '') || ''); }
function flags(role) {
  var f = '';
  if (/Button|MenuItem|MenuBarItem|CheckBox|RadioButton|Link|Tab|PopUp|Disclosure/.test(role)) f += 'i';
  if (/TextField|TextArea|ComboBox|SearchField|Slider/.test(role)) f += 'v';
  if (/CheckBox|RadioButton|Switch/.test(role)) f += 't';
  if (/Row|Cell|Tab|RadioButton/.test(role)) f += 's';
  if (/PopUp|ComboBox|Disclosure|Menu$/.test(role)) f += 'e';
  if (/TextArea|WebArea|StaticText/.test(role)) f += 'x';
  return f;
}
function fmt(el, depth) {
  var role = tryv(function () { return el.role(); }, '?');
  var nm = label(el), id = axid(el), f = flags(role);
  return (depth ? new Array(depth + 1).join('  ') : '') + '[' + role + '] ' + (nm ? '"' + short(nm, 60) + '"' : '') + (id ? ' id=' + id : '') + (f ? ' {' + f + '}' : '');
}
function kids(el) { return tryv(function () { return el.uiElements(); }, []); }
// Breadth-first walk of the controls under root. visit(el, depth) returns true to stop. Capped by count and time.
function walk(root, maxDepth, visit) {
  var q = [[root, 0]], seen = 0, t0 = Date.now();
  while (q.length) {
    var cur = q.shift(), el = cur[0], d = cur[1];
    if (d > 0) { seen++; if (visit(el, d)) return; if (seen > 2500 || Date.now() - t0 > 25000) return; }
    if (d < maxDepth) kids(el).forEach(function (k) { q.push([k, d + 1]); });
  }
}
function matches(el, st, roles) {
  if (roles) { var r = tryv(function () { return el.role(); }, ''); if (roles.indexOf(r) < 0) return false; }
  if (st.id && axid(el) !== String(st.id)) return false;
  if (st.name) {
    var l = label(el).toLowerCase(), n = String(st.name).toLowerCase();
    if (st.exact === true ? l !== n : l.indexOf(n) < 0) return false;
  }
  return true;
}
function findEls(win, st, max) {
  var roles = roleSet(st.type), res = [];
  walk(win.el, 8, function (el) { if (matches(el, st, roles)) { res.push(el); if (res.length >= max) return true; } return false; });
  return res;
}
function desc(st) { return [st.type, st.name ? '"' + st.name + '"' : '', st.id ? 'id=' + st.id : ''].filter(Boolean).join(' '); }
function pick(win, st) {
  var idx = st.index === undefined ? 0 : Number(st.index);
  var els = findEls(win, st, idx + 1);
  if (els.length <= idx) throw new Error('no control matches ' + desc(st) + '. Use tree or find to see the controls.');
  return els[idx];
}
function act(el, name) { el.actions.byName(name).perform(); }
function has(el, name) { return tryv(function () { return el.actions.name().indexOf(name) >= 0; }, false); }
function sleep(ms) { delay(ms / 1000); }

function runStep(st) {
  var dry = JOB.dry === true;
  switch (st.action) {
    case 'list_windows': {
      var ws = listWins();
      if (!ws.length) return ['(no windows. If Accessibility is off for Daebot, window names are hidden: System Settings, Privacy & Security, Accessibility.)'];
      return ws.filter(function (w) { return !isTerm(w.proc); }).map(function (w) { return w.proc + ' "' + short(w.title, 70) + '" pid:' + w.pid; });
    }
    case 'tree': {
      var w = findWin(st.window), out = [fmt(w.el, 0) + ' (window)'], d = st.depth === undefined ? 3 : Number(st.depth), cap = 400;
      walk(w.el, d, function (el, depth) { out.push(fmt(el, depth)); return out.length >= cap; });
      if (out.length >= cap) out.push('...[cut at ' + cap + ' controls; use find or a smaller depth]');
      return out;
    }
    case 'find': {
      var w2 = findWin(st.window), mx = st.max === undefined ? 20 : Math.min(Number(st.max), 100);
      var els = findEls(w2, st, mx);
      if (!els.length) throw new Error('no control matches ' + desc(st));
      return els.map(function (e, i) { return i + ': ' + fmt(e, 0); });
    }
    case 'get_text': {
      var w3 = findWin(st.window), el3 = pick(w3, st), mx3 = st.max === undefined ? 4000 : Number(st.max);
      var v = tryv(function () { return el3.value(); }, null);
      var text = (typeof v === 'string' && v) ? v : label(el3);
      if (text.length > mx3) text = text.slice(0, mx3) + ' ...[cut]';
      return ['text of ' + fmt(el3, 0) + NOTE + ':', text];
    }
    case 'wait': {
      var w4 = findWin(st.window), to = st.timeout_s === undefined ? 5 : Number(st.timeout_s), until = Date.now() + to * 1000, f = [];
      do { f = findEls(w4, st, 1); if (!f.length) sleep(250); } while (!f.length && Date.now() < until);
      if (!f.length) throw new Error('timed out after ' + to + 's waiting for ' + desc(st));
      return ['found ' + fmt(f[0], 0)];
    }
    case 'invoke': {
      var w5 = findWin(st.window), el5 = pick(w5, st);
      if (!has(el5, 'AXPress')) throw new Error(fmt(el5, 0) + ' has no press action (AXPress). Try select, toggle or expand.');
      if (dry) return ['DRY RUN: would press ' + fmt(el5, 0) + NOTE];
      act(el5, 'AXPress');
      return ['pressed ' + fmt(el5, 0) + NOTE];
    }
    case 'set_value': {
      var w6 = findWin(st.window), el6 = pick(w6, st);
      if (dry) return ['DRY RUN: would set ' + fmt(el6, 0) + ' to ' + String(st.value).length + ' characters' + NOTE];
      el6.value = String(st.value);
      return ['set ' + fmt(el6, 0) + ' to ' + String(st.value).length + ' characters' + NOTE];
    }
    case 'select': {
      var w7 = findWin(st.window), el7 = pick(w7, st);
      if (dry) return ['DRY RUN: would select ' + fmt(el7, 0) + NOTE];
      if (has(el7, 'AXPick')) act(el7, 'AXPick');
      else if (!st.add && has(el7, 'AXPress') && /Tab|RadioButton/.test(tryv(function () { return el7.role(); }, ''))) act(el7, 'AXPress');
      else el7.selected = true;
      return ['selected ' + fmt(el7, 0) + NOTE];
    }
    case 'toggle': {
      var w8 = findWin(st.window), el8 = pick(w8, st);
      var cur = tryv(function () { return Number(el8.value()); }, null);
      var want = st.state ? (st.state === 'on' ? 1 : 0) : null;
      if (cur === null) throw new Error(fmt(el8, 0) + ' has no on/off value');
      if (dry) return ['DRY RUN: would toggle ' + fmt(el8, 0) + ' (now ' + (cur ? 'On' : 'Off') + (want === null ? '' : ', want ' + st.state) + ')' + NOTE];
      if (want === null || cur !== want) act(el8, 'AXPress');
      var now = tryv(function () { return Number(el8.value()); }, cur);
      return ['toggle ' + fmt(el8, 0) + ' is now ' + (now ? 'On' : 'Off') + NOTE];
    }
    case 'expand':
    case 'collapse': {
      var w9 = findWin(st.window), el9 = pick(w9, st), ex = st.action === 'expand';
      if (dry) return ['DRY RUN: would ' + st.action + ' ' + fmt(el9, 0) + NOTE];
      var role9 = tryv(function () { return el9.role(); }, '');
      if (/Disclosure/.test(role9)) {
        var open = Number(tryv(function () { return el9.value(); }, 0)) === 1;
        if (open !== ex) act(el9, 'AXPress');
      } else if (ex) { act(el9, has(el9, 'AXShowMenu') ? 'AXShowMenu' : 'AXPress'); }
      else if (has(el9, 'AXCancel')) act(el9, 'AXCancel');
      else throw new Error(fmt(el9, 0) + ' cannot be collapsed');
      return [(ex ? 'expanded ' : 'collapsed ') + fmt(el9, 0) + NOTE];
    }
    case 'close': {
      var w10 = findWin(st.window), title = short(w10.title, 50);
      if (dry) return ['DRY RUN: would close window "' + title + '"' + NOTE];
      var cb = w10.el.buttons.whose({subrole: 'AXCloseButton'})();
      if (!cb.length) throw new Error('window "' + title + '" has no close button');
      act(cb[0], 'AXPress');
      return ['closed window "' + title + '"' + NOTE];
    }
    case 'launch': {
      var appName = String(st.app);
      if (isTerm(appName.replace(/\.app$/i, '').split('/').pop())) throw new Error('refused: ' + appName + ' is a terminal. Use bash.');
      if (st.args) throw new Error('launch args are not supported on a Mac; open a file with bash (open -g file) if needed');
      if (dry) return ['DRY RUN: would launch ' + appName + ' in the background'];
      var a = Application(appName.charAt(0) === '/' ? appName : appName);
      a.launch();
      var tl = st.timeout_s === undefined ? 10 : Number(st.timeout_s), unt = Date.now() + tl * 1000, found = null;
      do {
        sleep(300);
        var base = appName.replace(/\.app$/i, '').split('/').pop().toLowerCase();
        found = listWins().filter(function (x) { return x.proc.toLowerCase() === base; })[0] || null;
      } while (!found && Date.now() < unt);
      if (found) { if (isTerm(found.proc)) blocked(found.proc, found.title); return ['launched ' + appName + ': window "' + short(found.title, 60) + '" ' + found.proc + ' pid:' + found.pid]; }
      return ['launched ' + appName + ', no window after ' + tl + 's. Use wait or list_windows.'];
    }
    default: throw new Error('unknown action ' + String(st.action));
  }
}

var JOB = null;
function run(argv) {
  JOB = JSON.parse(argv[0]);
  var all = JOB.steps, i = 0, stopped = false;
  try {
    for (var s = 0; s < all.length; s++) {
      var st = all[s]; i++; NOTE = '';
      try {
        var lines = runStep(st), head = i + '. ' + st.action + ' ok';
        if (lines.length === 1) console.log(head + ': ' + lines[0]);
        else { console.log(head); lines.forEach(function (l) { console.log('   ' + l); }); }
      } catch (e) {
        if (e && e.blocked) throw e;
        console.log(i + '. ' + st.action + ' FAILED: ' + short(axErr(e), 400));
        if (JOB.stopOnError) { stopped = true; break; }
      }
    }
    if (stopped && i < all.length) console.log('steps ' + (i + 1) + '-' + all.length + ' skipped');
    if (JOB.shot && JOB.shotWindow) {
      try {
        var w = findWin(JOB.shotWindow), wl = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID))), id = 0;
        wl.forEach(function (x) { if (!id && x.kCGWindowOwnerPID === w.pid && x.kCGWindowLayer === 0 && (x.kCGWindowName === w.title || !x.kCGWindowName)) id = x.kCGWindowNumber; });
        if (id) console.log('DAEBOT_WINID ' + id); else console.log('screenshot failed: no on-screen window id for "' + short(w.title, 40) + '"');
      } catch (e) { if (e && e.blocked) throw e; console.log('screenshot failed: ' + short(axErr(e), 200)); }
    }
  } catch (e) { if (e && e.blocked) { console.log('DAEBOT_DONE'); return ''; } throw e; }
  console.log('DAEBOT_DONE');
  return '';
}
`;

/** The script with the role table filled in. The terminals list is data in the job, never spliced into code. */
export function buildMacAppScript(): string {
  return MAC_APP_JXA.replace("%ROLES%", JSON.stringify(AX_ROLES));
}

/** osascript argv for a list of steps: the interpreter, then the job as a single argv item. */
export function macAppArgs(steps: MacAppStep[], opts: { shot?: boolean; shotWindow?: string; stopOnError?: boolean; dry?: boolean } = {}): string[] {
  const job = JSON.stringify({ steps, shot: opts.shot === true, shotWindow: opts.shotWindow ?? null, stopOnError: opts.stopOnError !== false, dry: opts.dry === true, terminals: MAC_TERMINAL_APPS });
  return ["-l", "JavaScript", "-e", buildMacAppScript(), "--", job];
}

export interface MacAppOutput { text: string; blocked?: string; done: boolean; windowId?: number }
export function parseMacAppOutput(stdout: string, stderr = ""): MacAppOutput {
  const keep: string[] = [];
  let blocked: string | undefined, done = false, windowId: number | undefined;
  // osascript prints console.log to stderr; accept both streams.
  for (const l of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const b = /^DAEBOT_BLOCKED (.*)$/.exec(l);
    if (b) { blocked = b[1].trim(); continue; }
    const w = /^DAEBOT_WINID (\d+)\s*$/.exec(l);
    if (w) { windowId = Number(w[1]); continue; }
    if (l.trim() === "DAEBOT_DONE") { done = true; continue; }
    keep.push(l);
  }
  return { text: keep.join("\n").trim(), blocked, done, windowId };
}

/** A shot of one window by CoreGraphics window id (screencapture -l), shrunk to MAC_SHOT_MAX_WIDTH and encoded as JPEG. */
export async function macWindowShot(exec: MacExec, windowId: number, signal?: AbortSignal): Promise<{ ok: true; width: number; height: number; jpegBase64: string } | { ok: false; error: string }> {
  const dir = await mkdtemp(join(tmpdir(), "daebot-appshot-"));
  try {
    const png = join(dir, "w.png"), jpg = join(dir, "w.jpg");
    const cap = await exec("screencapture", ["-x", "-o", "-l", String(windowId), "-t", "png", png], { signal });
    if (cap.code !== 0) return { ok: false, error: `screencapture failed (${(cap.stderr || `exit ${cap.code}`).replace(/\s+/g, " ").trim().slice(0, 160)}); Daebot needs Screen Recording permission` };
    const dims = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", png], { signal });
    const nw = Number(/pixelWidth:\s*(\d+)/.exec(dims.stdout)?.[1]), nh = Number(/pixelHeight:\s*(\d+)/.exec(dims.stdout)?.[1]);
    if (!(nw > 0) || !(nh > 0)) return { ok: false, error: "screencapture produced no readable image" };
    const w = Math.min(MAC_SHOT_MAX_WIDTH, nw), h = Math.round((nh * w) / nw);
    const conv = await exec("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "--resampleWidth", String(w), png, "--out", jpg], { signal });
    if (conv.code !== 0) return { ok: false, error: "could not encode the window screenshot" };
    const jpeg = await readFile(jpg);
    return jpeg.length ? { ok: true, width: w, height: h, jpegBase64: jpeg.toString("base64") } : { ok: false, error: "the window screenshot was empty" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface MacAppResult { text: string; failed: boolean; blocked?: string; error?: string; image?: string; steps: number; dry: boolean }

/** Runs the steps in one osascript process; then, when asked, shoots the last step's window. */
export async function runMacApp(steps: MacAppStep[], o: { exec?: MacExec; signal?: AbortSignal; dry?: boolean; shot?: boolean; shotWindow?: string; stopOnError?: boolean }): Promise<MacAppResult> {
  const exec = o.exec ?? runMacExec;
  const dry = o.dry === true;
  const r = await exec("osascript", macAppArgs(steps, { shot: o.shot, shotWindow: o.shotWindow, stopOnError: o.stopOnError, dry }), { signal: o.signal, timeoutMs: Math.min(180_000, 60_000 + steps.length * 3000) });
  const p = parseMacAppOutput(r.stdout, r.stderr);
  if (p.blocked) return { text: p.text, failed: true, blocked: p.blocked, steps: steps.length, dry };
  if (r.code !== 0 && !p.done) {
    const why = (r.stderr || p.text).replace(/\s+/g, " ").trim().slice(0, 500) || `exit code ${r.code}`;
    const hint = /assistive|-25211|not allowed/i.test(why) ? " Turn on Accessibility for Daebot: System Settings, Privacy & Security, Accessibility." : "";
    return { text: "", failed: true, error: `${why}${hint}`, steps: steps.length, dry };
  }
  let image: string | undefined;
  let text = p.text;
  if (o.shot && p.windowId) {
    const s = await macWindowShot(exec, p.windowId, o.signal);
    if (s.ok) image = `data:image/jpeg;base64,${s.jpegBase64}`; else text += `\nscreenshot failed: ${s.error}`;
  }
  return { text: text || "(no output)", failed: /^\d+\. \w+ FAILED:/m.test(text), image, steps: steps.length, dry };
}

export { isMacTerminalApp };
