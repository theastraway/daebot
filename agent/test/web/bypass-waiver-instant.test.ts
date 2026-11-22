// Picking Bypass opens the waiver at once, even while the chat is still opening (Nov 22 2026: opening a chat can wait on MIND, which held the waiver up to 30 s).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { initChatMode } from "../../web/permissions.js";

class El {
  tagName: string; id = ""; type = ""; className = ""; textContent = ""; hidden = false; disabled = false; checked = false;
  children: El[] = []; parent: El | null = null; attrs: Record<string, string> = {}; dataset: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  classList = { toggle: (_c: string, _on?: boolean) => {} };
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  append(...xs: (El | string)[]) { for (const x of xs) { if (typeof x === "string") { this.textContent += x; continue; } x.parent = this; this.children.push(x); } }
  replaceChildren() { this.children = []; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(t: string, f: (e: unknown) => void) { (this.listeners[t] ||= []).push(f); }
  dispatch(t: string) { for (const f of this.listeners[t] || []) f({ target: this, preventDefault() {} }); }
  click() { this.dispatch("click"); }
  focus() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  contains(x: El): boolean { return x === this || this.children.some((c) => c.contains(x)); }
  get lastChild() { return this.children[this.children.length - 1] ?? null; }
  get firstChild() { return this.children[0] ?? null; }
  all(): El[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel: string) { const cls = sel.startsWith(".") ? sel.slice(1) : ""; return this.all().filter((e) => e !== this && cls && e.className.split(" ").includes(cls)); }
}

function setup(waiver: Record<string, unknown>) {
  const btn = new El("button"), label = new El("span"), menu = new El("div"), body = new El("body");
  const byId: Record<string, El> = { "cm-btn": btn, "cm-label": label, "cm-menu": menu };
  const docListeners: Record<string, ((e: unknown) => void)[]> = {};
  (globalThis as any).document = {
    body, activeElement: null,
    getElementById: (id: string) => byId[id] ?? body.all().find((e) => e.id === id) ?? null,
    createElement: (t: string) => new El(t),
    addEventListener: (t: string, f: (e: unknown) => void) => { (docListeners[t] ||= []).push(f); },
    removeEventListener: () => {},
  };
  const h = (tag: string, cls = "", text = "") => { const e = new El(tag); e.className = cls; e.textContent = text; return e; };
  const calls: string[] = [];
  let releaseSession: (id: string) => void = () => {};
  const json = async (path: string, opts: { method?: string } = {}) => {
    calls.push(`${opts.method || "GET"} ${path}`);
    if (path === "/permissions") return { mode: "risky", waiver };
    return { ok: true };
  };
  const cm = initChatMode({
    json, h, icon: () => new El("svg"), notify: (t: string) => calls.push(`notify ${t}`),
    ids: { btn: "cm-btn", label: "cm-label", menu: "cm-menu" },
    ensureSession: () => { calls.push("ensureSession"); return new Promise<string>((r) => { releaseSession = r; }); }, // a chat that is slow to open
    getSessionId: () => null, getRow: () => null, onRowMode: () => {},
  });
  return { cm, btn, menu, body, calls, release: (id: string) => releaseSession(id) };
}

const tick = () => new Promise((r) => setImmediate(r));

test("Bypass: the waiver opens before the chat finishes opening; the mode is set once the chat is ready", async () => {
  const t = setup({ accepted: true, dontShowAgain: false, version: 1, text: "waiver text" });
  await t.cm.probe();
  t.btn.click();
  const bypass = t.menu.children.find((c) => c.className.includes("bypass"));
  assert.ok(bypass, "Bypass is in the menu");
  bypass!.click();
  await tick();
  const modal = t.body.all().find((e) => e.id === "waiver-modal");
  assert.ok(modal, "the waiver is on screen while the chat is still opening");
  assert.ok(!t.calls.includes("ensureSession"), "the chat is not opened before the waiver is answered");
  const go = t.body.all().find((e) => e.id === "waiver-accept")!;
  assert.equal(go.disabled, false, "accepted before: one click to confirm");
  go.click();
  await tick();
  assert.ok(t.calls.includes("POST /permissions/waiver"));
  assert.ok(t.calls.includes("ensureSession"), "after the waiver, the chat is opened");
  assert.ok(!t.calls.some((c) => c.startsWith("PATCH")), "the mode waits for the chat");
  t.release("s1");
  await tick();
  assert.ok(t.calls.includes("PATCH /sessions/s1"), "then Bypass is set on the chat");
});

test("Bypass: cancelling the waiver opens no chat and sets nothing", async () => {
  const t = setup({ accepted: false, version: 1 });
  await t.cm.probe();
  t.btn.click();
  t.menu.children.find((c) => c.className.includes("bypass"))!.click();
  await tick();
  const modal = t.body.all().find((e) => e.id === "waiver-modal")!;
  assert.ok(modal);
  modal.all().find((e) => e.textContent === "Cancel")!.click();
  await tick();
  assert.ok(!t.calls.includes("ensureSession"));
  assert.ok(!t.calls.some((c) => c.startsWith("PATCH") || c.startsWith("POST")));
});

test("Bypass after Don't show this again: no waiver, straight to the chat", async () => {
  const t = setup({ accepted: true, dontShowAgain: true, version: 1 });
  await t.cm.probe();
  t.btn.click();
  t.menu.children.find((c) => c.className.includes("bypass"))!.click();
  await tick();
  assert.ok(!t.body.all().some((e) => e.id === "waiver-modal"));
  assert.ok(t.calls.includes("ensureSession"));
});
