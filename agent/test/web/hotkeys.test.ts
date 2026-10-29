import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const web = (f: string) => readFileSync(join(import.meta.dirname, "..", "..", "web", f), "utf8");
const hk: any = await import(new URL("../../web/hotkeys.js", import.meta.url).href);
const voice: any = await import(new URL("../../web/voice.js", import.meta.url).href);

// A fake clock so a 150 ms hold is exact and nothing sleeps.
function clock() {
  let t = 0, id = 0; const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => { const i = ++id; timers.set(i, { at: t + ms, fn }); return i; },
    clearTimer: (i: number) => { timers.delete(i); },
    advance(ms: number) { t += ms; for (const [i, v] of [...timers]) if (v.at <= t) { timers.delete(i); v.fn(); } },
  };
}
function rig(bindings = { dictate: "AltRight", voice: "MetaRight", summon: "CommandOrControl+Shift+Space" }) {
  const c = clock(); const log: string[] = [];
  const s = hk.createSoloHold({ getBindings: () => bindings, setTimer: c.setTimer, clearTimer: c.clearTimer,
    onStart: (a: string) => log.push(`start:${a}`), onEnd: (a: string) => log.push(`end:${a}`), onCancel: (a: string) => log.push(`cancel:${a}`) });
  return { c, s, log };
}
const down = (code: string, repeat = false) => ({ code, repeat });
const up = (code: string) => ({ code });

test("solo hold: holding Right Option past 150 ms starts dictation, release ends it", () => {
  const { c, s, log } = rig();
  s.keydown(down("AltRight")); c.advance(149); assert.deepEqual(log, []);
  c.advance(1); assert.deepEqual(log, ["start:dictate"]);
  s.keyup(up("AltRight")); assert.deepEqual(log, ["start:dictate", "end:dictate"]);
});

test("solo hold: Right Command starts VOICE, not dictation", () => {
  const { c, s, log } = rig();
  s.keydown(down("MetaRight")); c.advance(200); s.keyup(up("MetaRight"));
  assert.deepEqual(log, ["start:voice", "end:voice"]);
});

test("a tap shorter than the hold time does nothing", () => {
  const { c, s, log } = rig();
  s.keydown(down("MetaRight")); c.advance(100); s.keyup(up("MetaRight")); c.advance(500);
  assert.deepEqual(log, []);
  assert.equal(s.state().phase, "idle");
});

test("combo rejection: Right Command + C (Copy) never opens the mic", () => {
  const { c, s, log } = rig();
  s.keydown(down("MetaRight")); c.advance(40); s.keydown(down("KeyC")); c.advance(500); s.keyup(up("KeyC")); s.keyup(up("MetaRight"));
  assert.deepEqual(log, []);
});

test("combo rejection: Right Option + Tab, and the left-hand modifiers, never open the mic", () => {
  const { c, s, log } = rig();
  s.keydown(down("AltRight")); s.keydown(down("Tab")); c.advance(500); s.keyup(up("AltRight"));
  s.keydown(down("MetaLeft")); c.advance(500); s.keyup(up("MetaLeft"));      // not bound: ignored
  s.keydown(down("AltLeft")); c.advance(500); s.keyup(up("AltLeft"));
  assert.deepEqual(log, []);
});

test("a key typed BEFORE the modifier goes down (Shift-less typing, then Right Cmd) still needs a clean hold", () => {
  const { c, s, log } = rig();
  s.keydown(down("KeyA")); s.keyup(up("KeyA"));
  s.keydown(down("MetaRight")); c.advance(150); assert.deepEqual(log, ["start:voice"]);
});

test("a key pressed after the mic opened cancels the hold (the take is discarded)", () => {
  const { c, s, log } = rig();
  s.keydown(down("AltRight")); c.advance(200); s.keydown(down("KeyX"));
  assert.deepEqual(log, ["start:dictate", "cancel:dictate"]);
  s.keyup(up("AltRight")); assert.deepEqual(log, ["start:dictate", "cancel:dictate"], "no second end after a cancel");
});

test("both bound modifiers together is a chord, not a hold", () => {
  const { c, s, log } = rig();
  s.keydown(down("AltRight")); c.advance(50); s.keydown(down("MetaRight")); c.advance(500);
  assert.deepEqual(log, []);
});

test("key auto-repeat does not restart or double-fire", () => {
  const { c, s, log } = rig();
  s.keydown(down("AltRight")); c.advance(150); s.keydown(down("AltRight", true)); s.keydown(down("AltRight", true)); c.advance(900);
  assert.deepEqual(log, ["start:dictate"]);
});

test("losing focus while held drops the hold (the key-up will never arrive)", () => {
  const { c, s, log } = rig();
  s.keydown(down("MetaRight")); c.advance(300); s.reset();
  assert.deepEqual(log, ["start:voice", "cancel:voice"]);
  s.keydown(down("MetaRight")); c.advance(50); s.reset(); c.advance(500);
  assert.deepEqual(log, ["start:voice", "cancel:voice"], "a pending (not yet open) hold just disappears");
});

test("rebinding: the new key triggers, the old one stops", () => {
  const b = { dictate: "ControlRight", voice: "AltRight", summon: "CommandOrControl+Shift+Space" };
  const { c, s, log } = rig(b);
  s.keydown(down("AltRight")); c.advance(200); s.keyup(up("AltRight"));
  s.keydown(down("ControlRight")); c.advance(200); s.keyup(up("ControlRight"));
  s.keydown(down("MetaRight")); c.advance(200); s.keyup(up("MetaRight"));
  assert.deepEqual(log, ["start:voice", "end:voice", "start:dictate", "end:dictate"]);
});

test("defaults: Right Option dictates, Right Command is voice on a Mac; Right Alt / Right Ctrl elsewhere", () => {
  assert.deepEqual(hk.defaultBindings(true), { dictate: "AltRight", voice: "MetaRight", summon: "CommandOrControl+Shift+Space" });
  assert.deepEqual(hk.defaultBindings(false), { dictate: "AltRight", voice: "ControlRight", summon: "CommandOrControl+Shift+Space" });
  assert.equal(hk.hintText(hk.defaultBindings(true), true), "Hold Right ⌥ to dictate · Hold Right ⌘ for voice");
  assert.equal(hk.hintText(hk.defaultBindings(false), false), "Hold Right Alt to dictate · Hold Right Ctrl for voice");
  assert.equal(hk.acceleratorLabel("CommandOrControl+Shift+Space", true), "⌘⇧Space");
  assert.equal(hk.acceleratorLabel("CommandOrControl+Shift+Space", false), "Ctrl+Shift+Space");
});

test("rebind persistence: saved per user, reloaded, other users unaffected, junk falls back to defaults", () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null), setItem: (k: string, v: string) => void mem.set(k, v) };
  hk.saveBindings(storage, "alice", { dictate: "ControlRight", voice: "AltRight", summon: "CommandOrControl+Shift+K" }, true);
  assert.deepEqual(hk.loadBindings(storage, "alice", true), { dictate: "ControlRight", voice: "AltRight", summon: "CommandOrControl+Shift+K" });
  assert.deepEqual(hk.loadBindings(storage, "bob", true), hk.defaultBindings(true));
  mem.set("daebot:hotkeys:eve", "{not json");
  assert.deepEqual(hk.loadBindings(storage, "eve", true), hk.defaultBindings(true));
  // the same key for both actions, or a non-modifier, is refused
  assert.deepEqual(hk.sanitizeBindings({ dictate: "AltRight", voice: "AltRight" }, true), hk.defaultBindings(true));
  assert.equal(hk.sanitizeBindings({ dictate: "KeyA" }, true).dictate, "AltRight");
  // a storage that throws never breaks the page
  const bad = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(hk.loadBindings(bad, "x", true), hk.defaultBindings(true));
  assert.deepEqual(hk.saveBindings(bad, "x", { dictate: "ControlRight", voice: "AltRight" }, true).dictate, "ControlRight");
});

test("summon rebind: a key event becomes an Electron accelerator; bare keys are refused", () => {
  assert.equal(hk.acceleratorFromEvent({ metaKey: true, shiftKey: true, code: "Space" }), "CommandOrControl+Shift+Space");
  assert.equal(hk.acceleratorFromEvent({ ctrlKey: true, altKey: true, code: "KeyK" }), "CommandOrControl+Alt+K");
  assert.equal(hk.acceleratorFromEvent({ code: "KeyK" }), "");
  assert.equal(hk.acceleratorFromEvent({ metaKey: true, code: "MetaLeft" }), "");
});

// ---------------------------------------------------------------- mode separation

test("DICTATION never sends: the transcript is inserted, send() is not called", () => {
  const calls: string[] = [];
  const out = voice.deliverTranscript("dictate", "hello there", { insert: (t: string) => calls.push(`insert:${t}`), send: (t: string) => calls.push(`send:${t}`) });
  assert.equal(out, "inserted");
  assert.deepEqual(calls, ["insert:hello there"]);
});

test("VOICE sends: the transcript goes to send(), nothing is inserted", () => {
  const calls: string[] = [];
  const out = voice.deliverTranscript("voice", "what is on my calendar", { insert: (t: string) => calls.push(`insert:${t}`), send: (t: string) => calls.push(`send:${t}`) });
  assert.equal(out, "sent");
  assert.deepEqual(calls, ["send:what is on my calendar"]);
});

test("an unknown mode falls to the safe side (dictation: words in the box, nothing leaves)", () => {
  const calls: string[] = [];
  voice.deliverTranscript(undefined, "x", { insert: () => calls.push("insert"), send: () => calls.push("send") });
  assert.deepEqual(calls, ["insert"]);
});

test("insertAt types at the cursor, replaces a selection, and spaces only where needed", () => {
  assert.deepEqual(voice.insertAt("", 0, 0, "hello"), { value: "hello", caret: 5 });
  assert.deepEqual(voice.insertAt("hello", 5, 5, "world"), { value: "hello world", caret: 11 });
  assert.deepEqual(voice.insertAt("hello world", 5, 5, "big"), { value: "hello big world", caret: 9 });
  assert.deepEqual(voice.insertAt("say THIS now", 4, 8, "that"), { value: "say that now", caret: 8 });
  assert.deepEqual(voice.insertAt("abc", 1, 1, "   "), { value: "abc", caret: 1 });
});

test("source: the mic path in voice.js routes through deliverTranscript, and submit is the only thing that sends", () => {
  const v = web("voice.js").replace(/^\s*\/\/.*$/gm, "");
  assert.match(v, /deliverTranscript\(r\.mode, text, \{ insert: dictateInto, send: submit \}\)/);
  assert.equal((v.match(/requestSubmit\(\)/g) || []).length, 1, "exactly one place can send");
  const dictate = v.slice(v.indexOf("function dictateInto"), v.indexOf("function submit"));
  assert.doesNotMatch(dictate, /requestSubmit|pendingTurn|voiceTurn|speak\(/, "dictation never sends, queues a spoken turn or speaks");
  assert.match(v, /wirePress\(els\.mic, "dictate"\)/);
  assert.match(v, /wirePress\(els\.voiceBtn, "voice"\)/);
});

test("web wiring: both buttons, the pill, the hint, the shortcuts card, and no innerHTML", () => {
  const html = web("index.html");
  for (const id of ["btn-mic", "btn-voice", "voice-pill", "hotkey-hint", "am-keys", "i-voice"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /Hold Right ⌥ to dictate · Hold Right ⌘ for voice/);
  const app = web("app.js");
  assert.match(app, /from "\/hotkeys\.js"/);
  assert.match(app, /voiceBtn: \$\("btn-voice"\)/);
  assert.equal((app.match(/dispatchEvent\(new Event\("daebot:who"\)\)/g) || []).length, 2, "both sign-in paths announce the account");
  assert.match(web("hotkeys.js"), /addEventListener\("daebot:who"/);
  assert.doesNotMatch(web("hotkeys.js").replace(/^\s*\/\/.*$/gm, ""), /innerHTML|insertAdjacentHTML|eval\(|new Function|document\.write|fetch\(/);
});

test("desktop bridge: the preload exposes shortcuts.get/set and main registers both channels", () => {
  const d = (f: string) => readFileSync(join(import.meta.dirname, "..", "..", "desktop", "src", f), "utf8");
  assert.match(d("preload.cjs"), /desktop:shortcut-get/);
  assert.match(d("preload.cjs"), /desktop:shortcut-set/);
  assert.match(d("main.mjs"), /ipcMain\.handle\("desktop:shortcut-set"/);
  assert.match(d("main.mjs"), /fromOurUi\(e\) && \(acc === null/);
});
