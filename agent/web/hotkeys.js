// Push-to-talk hotkeys + the "Keyboard shortcuts" card for Daebot (web and desktop shell).
//   Dictation = hold a modifier, speak, release: your words are typed into the message box. Nothing is sent, nothing is read aloud.
//   Voice     = hold a modifier, speak, release: your words are SENT to Daebot and the answer is read aloud.
// Defaults: Right Option (Mac) / Right Alt = Dictation; Right Command (Mac) / Right Ctrl = Voice. Every binding is rebindable
// in "Keyboard shortcuts" and saved per signed-in user (this browser/app). A trigger is a modifier held ALONE: if any other key
// goes down while it is held (Cmd+C, Alt+Tab, ...) the hold is dropped, so normal shortcuts never start the mic.
// The desktop shell also gets a global "Summon Daebot" shortcut (Electron globalShortcut, main process). Electron cannot see a
// lone modifier outside its own window without native modules, so the two hold-to-talk keys work while Daebot is focused.
// DOM is built with createElement + textContent only; no innerHTML; no network.

export const HOLD_MS = 150;                       // a modifier must be held this long, alone, before the mic opens
export const BINDABLE = ["AltRight", "AltLeft", "MetaRight", "MetaLeft", "ControlRight", "ControlLeft", "ShiftRight", "ShiftLeft"];
export const ACTIONS = ["dictate", "voice"];
export const DEFAULT_SUMMON_MAC = "CommandOrControl+Shift+Space";

export function isMac(nav = globalThis.navigator) {
  const s = `${nav?.userAgentData?.platform || ""} ${nav?.platform || ""} ${nav?.userAgent || ""}`;
  return /Mac|iPhone|iPad/i.test(s);
}

/** Factory bindings for the platform. */
export function defaultBindings(mac = isMac()) {
  return { dictate: "AltRight", voice: mac ? "MetaRight" : "ControlRight", summon: DEFAULT_SUMMON_MAC };
}

/** Human label for a key code ("Right ⌥" on a Mac, "Right Alt" elsewhere). */
export function codeLabel(code, mac = isMac()) {
  const m = /^(Alt|Meta|Control|Shift)(Left|Right)$/.exec(String(code || ""));
  if (!m) return String(code || "");
  const side = m[2];
  const name = mac ? { Alt: "⌥", Meta: "⌘", Control: "⌃", Shift: "⇧" }[m[1]] : { Alt: "Alt", Meta: "Win", Control: "Ctrl", Shift: "Shift" }[m[1]];
  return `${side} ${name}`;
}

/** An Electron accelerator shown for people: CommandOrControl+Shift+Space -> "⌘⇧Space" / "Ctrl+Shift+Space". */
export function acceleratorLabel(acc, mac = isMac()) {
  if (!acc) return "Off";
  const parts = String(acc).split("+");
  const key = parts.pop();
  const sym = { commandorcontrol: mac ? "⌘" : "Ctrl", cmdorctrl: mac ? "⌘" : "Ctrl", command: "⌘", cmd: "⌘", control: mac ? "⌃" : "Ctrl", ctrl: mac ? "⌃" : "Ctrl", alt: mac ? "⌥" : "Alt", option: mac ? "⌥" : "Alt", shift: mac ? "⇧" : "Shift", super: mac ? "⌘" : "Win", meta: mac ? "⌘" : "Win" };
  const mods = parts.map((p) => sym[p.toLowerCase()] || p);
  return mac ? mods.join("") + key : [...mods, key].join("+");
}

/** The line under the message box. */
export function hintText(b, mac = isMac()) {
  return `Hold ${codeLabel(b.dictate, mac)} to dictate · Hold ${codeLabel(b.voice, mac)} for voice`;
}

/** Keep only valid, non-clashing bindings; anything else falls back to the default. Never throws. */
export function sanitizeBindings(raw, mac = isMac()) {
  const d = defaultBindings(mac);
  const out = { ...d };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (BINDABLE.includes(raw.dictate)) out.dictate = raw.dictate;
    if (BINDABLE.includes(raw.voice)) out.voice = raw.voice;
    if (out.dictate === out.voice) { out.dictate = d.dictate; out.voice = d.voice; }
    if (typeof raw.summon === "string" && raw.summon.length <= 40) out.summon = raw.summon;
  }
  return out;
}

const keyFor = (user) => `daebot:hotkeys:${String(user || "").slice(0, 80)}`;

/** Per-user persistence in localStorage; every access is guarded (private mode, blocked storage). */
export function loadBindings(storage, user, mac = isMac()) {
  try { const raw = storage && storage.getItem(keyFor(user)); return sanitizeBindings(raw ? JSON.parse(raw) : null, mac); } catch { return sanitizeBindings(null, mac); }
}
export function saveBindings(storage, user, bindings, mac = isMac()) {
  const clean = sanitizeBindings(bindings, mac);
  try { storage.setItem(keyFor(user), JSON.stringify(clean)); } catch { /* storage unavailable: binding lasts for this page only */ }
  return clean;
}

/**
 * Solo-hold detector. Feed it keydown/keyup/blur; it calls onStart(action) once a bound modifier has been held alone for HOLD_MS,
 * onEnd(action) when that key is released, and onCancel(action) if another key joined the hold after the mic opened.
 * Pure: time comes from setTimer/clearTimer so tests drive it with a fake clock.
 */
export function createSoloHold({ getBindings, onStart, onEnd, onCancel = () => {}, holdMs = HOLD_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null;   // { code, action, timer }  modifier is down, mic not open yet
  let active = null;    // { code, action }          mic is open
  const actionOf = (code) => { const b = getBindings(); return ACTIONS.find((a) => b[a] === code) || null; };
  function drop() { if (pending) { clearTimer(pending.timer); pending = null; } }
  function cancelAll() { drop(); if (active) { const a = active; active = null; onCancel(a.action); } }
  return {
    keydown(e) {
      if (e.repeat) return;
      const action = actionOf(e.code);
      if (!action) { cancelAll(); return; }                       // any other key: this is a combo or typing, not a solo hold
      if (pending || active) { cancelAll(); return; }              // a second bound modifier joined: a chord, not a hold
      const entry = { code: e.code, action, timer: 0 };
      entry.timer = setTimer(() => { if (pending === entry) { pending = null; active = { code: entry.code, action }; onStart(action); } }, holdMs);
      pending = entry;
    },
    keyup(e) {
      if (pending && pending.code === e.code) { drop(); return; } // released before the hold time: it was a tap, nothing happens
      if (active && active.code === e.code) { const a = active; active = null; onEnd(a.action); }
    },
    /** Window lost focus / tab hidden: key-up will never arrive. */
    reset() { cancelAll(); },
    state: () => (active ? { phase: "active", action: active.action } : pending ? { phase: "pending", action: pending.action } : { phase: "idle", action: null }),
  };
}

/** Electron accelerator from a keydown (for the Summon rebind). Returns "" when the combination is not usable. */
export function acceleratorFromEvent(e) {
  const mods = [];
  if (e.metaKey || e.ctrlKey) mods.push("CommandOrControl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const c = String(e.code || "");
  let key = "";
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit[0-9]$/.test(c)) key = c.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) key = c;
  else if (c === "Space") key = "Space";
  else if (["Enter", "Tab", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete"].includes(c)) key = c;
  else if (/^Arrow(Up|Down|Left|Right)$/.test(c)) key = c.slice(5);
  if (!key || !mods.length) return "";
  return [...mods, key].join("+");
}

// ---------------------------------------------------------------- wiring + card

/**
 * opts: { voice: { holdStart(mode), holdEnd(), cancel() }, getUser(): string, storage?, h, icon, notify, desktop(): bridge|null,
 *         hintEl?: HTMLElement, buttons?: {dictate?: HTMLElement, voice?: HTMLElement}, openButton?: HTMLElement }
 * returns { bindings(), open(), setUser(name), refresh() }
 */
export function initHotkeys(o) {
  const mac = isMac();
  const storage = o.storage || (() => { try { return globalThis.localStorage; } catch { return null; } })();
  let user = o.getUser() || "";
  let bindings = loadBindings(storage, user, mac);
  let modal = null, closeFn = null, listening = null;

  function reloadIfUserChanged() {
    const u = o.getUser() || "";
    if (u !== user) { user = u; bindings = loadBindings(storage, user, mac); paintHints(); }
  }
  function paintHints() {
    if (o.hintEl) o.hintEl.textContent = hintText(bindings, mac);
    if (o.buttons?.dictate) {
      const t = `Dictate: hold ${codeLabel(bindings.dictate, mac)} (or hold this button). Your words are typed here, nothing is sent.`;
      o.buttons.dictate.title = t; o.buttons.dictate.setAttribute("aria-label", `Dictate (hold ${codeLabel(bindings.dictate, mac)})`);
    }
    if (o.buttons?.voice) {
      const t = `Voice: hold ${codeLabel(bindings.voice, mac)} (or hold this button). Release to send; Daebot answers aloud.`;
      o.buttons.voice.title = t; o.buttons.voice.setAttribute("aria-label", `Voice (hold ${codeLabel(bindings.voice, mac)})`);
    }
  }

  const solo = createSoloHold({
    getBindings: () => bindings,
    onStart: (action) => o.voice.holdStart(action === "voice" ? "voice" : "dictate"),
    onEnd: () => o.voice.holdEnd(),
    onCancel: () => o.voice.cancel(),
  });
  addEventListener("keydown", (e) => { if (listening) return; reloadIfUserChanged(); solo.keydown(e); }, true);
  addEventListener("keyup", (e) => { if (listening) return; solo.keyup(e); }, true);
  addEventListener("blur", () => solo.reset());
  addEventListener("daebot:who", () => { reloadIfUserChanged(); paintHints(); }); // the account is known after the page loads: show ITS keys
  document.addEventListener("visibilitychange", () => { if (document.hidden) solo.reset(); });

  function persist(next) {
    bindings = saveBindings(storage, user, next, mac);
    paintHints();
    const d = o.desktop && o.desktop();
    if (d && d.shortcuts && typeof d.shortcuts.set === "function") d.shortcuts.set(bindings.summon).catch?.(() => {});
    if (modal) paintCard();
  }

  function paintCard() {
    const { h, icon } = o;
    const card = modal.querySelector(".keys-panel");
    card.replaceChildren();
    const head = h("div", "apps-head");
    const t = h("div"); t.append(h("h2", "", "Keyboard shortcuts"), h("p", "", "Hold a key to talk. Pick the keys that suit you."));
    const x = h("button", "icon-btn", ""); x.type = "button"; x.setAttribute("aria-label", "Close"); x.append(icon("i-x"));
    x.addEventListener("click", () => closeFn && closeFn());
    head.append(t, x);
    card.append(head);

    const rows = [
      { id: "dictate", name: "Dictation", desc: "Hold, speak, release. Your words are typed into the message box. Nothing is sent and nothing is read aloud.", value: codeLabel(bindings.dictate, mac), kind: "mod" },
      { id: "voice", name: "Voice", desc: "Hold, speak, release. Your words are sent to Daebot and the answer is read aloud.", value: codeLabel(bindings.voice, mac), kind: "mod" },
    ];
    const d = o.desktop && o.desktop();
    if (d) rows.push({ id: "summon", name: "Summon Daebot", desc: "Works from any app: shows and focuses the Daebot window.", value: acceleratorLabel(bindings.summon, mac), kind: "combo" });
    const sec = h("section", "apps-sec");
    sec.append(h("h3", "", "Hold to talk"));
    const list = h("ul", "keys-list");
    for (const r of rows) {
      const li = h("li", "keys-row"); li.dataset.action = r.id;
      const txt = h("div", "keys-text"); txt.append(h("strong", "", r.name), h("span", "", r.desc));
      const key = h("kbd", "keys-key", listening === r.id ? (r.kind === "mod" ? "Press a modifier key…" : "Press the new shortcut…") : r.value);
      key.dataset.role = "binding";
      const bt = h("button", "btn-quiet keys-rebind", listening === r.id ? "Cancel" : "Rebind"); bt.type = "button";
      bt.addEventListener("click", () => { listening = listening === r.id ? null : r.id; paintCard(); if (listening) capture(r); });
      const reset = h("button", "btn-quiet keys-reset", "Reset"); reset.type = "button";
      reset.addEventListener("click", () => { persist({ ...bindings, [r.id]: defaultBindings(mac)[r.id] }); });
      li.append(txt, key, bt, reset);
      list.append(li);
    }
    sec.append(list);
    if (!d) sec.append(h("p", "apps-note", "Summon Daebot (a shortcut that works from any app) is in the desktop app."));
    else sec.append(h("p", "apps-note", "The two hold-to-talk keys work while Daebot is the front window. Summon works everywhere."));
    card.append(sec);
    const msg = h("p", "apps-note keys-msg", ""); msg.id = "keys-msg"; msg.setAttribute("role", "status"); card.append(msg);
  }

  function say(text) { const m = modal && modal.querySelector("#keys-msg"); if (m) m.textContent = text; }

  /** Wait for the next key and bind it. Escape cancels. */
  function capture(row) {
    const onKey = (e) => {
      if (listening !== row.id) { removeEventListener("keydown", onKey, true); return; }
      e.preventDefault(); e.stopPropagation();
      if (e.code === "Escape") { listening = null; removeEventListener("keydown", onKey, true); paintCard(); return; }
      if (row.kind === "mod") {
        if (!BINDABLE.includes(e.code)) { say("Press a modifier key: Option/Alt, Command/Win, Control or Shift."); return; }
        const other = row.id === "dictate" ? "voice" : "dictate";
        if (bindings[other] === e.code) { say(`${codeLabel(e.code, mac)} is already used for ${other === "voice" ? "Voice" : "Dictation"}. Pick another key.`); return; }
        listening = null; removeEventListener("keydown", onKey, true);
        persist({ ...bindings, [row.id]: e.code });
        say(`${row.name} is now ${codeLabel(e.code, mac)}.`);
      } else {
        if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return; // wait for the real key
        const acc = acceleratorFromEvent(e);
        if (!acc) { say("Use at least one of Command/Ctrl, Option/Alt or Shift plus a key."); return; }
        listening = null; removeEventListener("keydown", onKey, true);
        persist({ ...bindings, summon: acc });
        say(`Summon Daebot is now ${acceleratorLabel(acc, mac)}.`);
      }
    };
    addEventListener("keydown", onKey, true);
  }

  function open() {
    if (modal) return;
    const { h } = o;
    modal = h("div", "gate-token modal"); modal.id = "keys-modal";
    const card = h("div", "token-card bot-card apps-card keys-panel"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-label", "Keyboard shortcuts");
    modal.append(card);
    document.body.append(modal);
    const onEsc = (e) => { if (e.key === "Escape" && !listening) closeFn(); };
    closeFn = () => { listening = null; document.removeEventListener("keydown", onEsc); modal.remove(); modal = null; if (o.openButton) o.openButton.setAttribute("aria-expanded", "false"); };
    document.addEventListener("keydown", onEsc);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeFn(); });
    if (o.openButton) o.openButton.setAttribute("aria-expanded", "true");
    reloadIfUserChanged();
    paintCard();
    const d = o.desktop && o.desktop();
    if (d && d.shortcuts && typeof d.shortcuts.get === "function") {
      d.shortcuts.get().then((acc) => { if (acc && modal && acc !== bindings.summon) { bindings = saveBindings(storage, user, { ...bindings, summon: acc }, mac); paintCard(); } }).catch?.(() => {});
    }
  }
  if (o.openButton) o.openButton.addEventListener("click", open);
  paintHints();
  return { bindings: () => bindings, open, setUser(name) { o.getUser = () => name; reloadIfUserChanged(); }, refresh() { reloadIfUserChanged(); paintHints(); } };
}
