// CDP 1.3 actions on one tab. The model never supplies JavaScript: every Runtime.evaluate expression is a
// constant in this file, with a JSON argument. Refs (e1, e2, ...) are assigned here and resolved here.

import type { BrowserHost } from "./host.ts";
import type { LiveElement } from "./live.ts";
import { isSecretField, stripSecrets, stripSecretText } from "./policy.ts";

const TEXT_CAP = 12_000;
const MAX_ELEMENTS = 200;

interface CdpResult { result?: { value?: unknown }; data?: string; exceptionDetails?: unknown }

function mark(kind: string, arg: unknown, js: string): string {
  const tag = Buffer.from(JSON.stringify(arg), "utf8").toString("base64url");
  return `/*DAEBOT:${kind}:${tag}*/\n${js}`;
}

/** Pull the marker a test fake (or a log) can read without running the page's JavaScript. */
export function parseMark(expression: string): { kind: string; arg: unknown } | null {
  const m = /^\/\*DAEBOT:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)\*\//.exec(expression);
  if (!m) return null;
  try { return { kind: m[1], arg: JSON.parse(Buffer.from(m[2], "base64url").toString("utf8")) }; } catch { return null; }
}

async function cdp(host: BrowserHost, tabId: string, method: string, params: Record<string, unknown>): Promise<CdpResult> {
  const raw = await host.call("cdp", { tabId, method, params });
  return (raw && typeof raw === "object" ? raw : {}) as CdpResult;
}

async function evaluate(host: BrowserHost, tabId: string, expression: string): Promise<unknown> {
  const out = await cdp(host, tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error("the page could not be read");
  return stripSecrets(out.result?.value ?? null);
}

const TEXT_JS = `(() => String(document.body ? document.body.innerText : "").slice(0, 40000))()`;

const READ_JS = `(() => {
  const nodes = [];
  const sel = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[contenteditable="true"]';
  for (const el of document.querySelectorAll(sel)) {
    if (nodes.length >= ${MAX_ELEMENTS}) break;
    const tag = el.tagName.toLowerCase();
    let type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "button" && !type) type = "submit";
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
    const secret = type === "password" || autocomplete === "current-password" || autocomplete === "new-password" || autocomplete.indexOf("cc-") === 0 || autocomplete === "one-time-code";
    const r = el.getBoundingClientRect();
    let label = "";
    try { if (el.labels && el.labels[0]) label = el.labels[0].innerText || ""; } catch (e) { label = ""; }
    const visible = (tag === "input" && (type === "submit" || type === "button"))
      ? (el.value || el.getAttribute("aria-label") || label || "")
      : (el.getAttribute("aria-label") || label || (el.innerText || "") || el.getAttribute("placeholder") || "");
    const row = {
      tag, type, role: (el.getAttribute("role") || tag),
      name: String(visible).slice(0, 120),
      id: String(el.id || "").slice(0, 80),
      autocomplete,
      placeholder: String(el.getAttribute("placeholder") || "").slice(0, 80),
      aria: String(el.getAttribute("aria-label") || "").slice(0, 120),
      label: String(label).slice(0, 120),
      text: String(el.innerText || visible || "").slice(0, 160),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      secret
    };
    if (!secret && tag === "input" && type !== "password" && type !== "hidden" && "value" in el) row.value = String(el.value || "").slice(0, 80);
    nodes.push(row);
  }
  return nodes;
})()`;

function queryJs(sel: string): string {
  return `((sel) => { if (typeof sel !== "string" || sel.length > 300) return false; try { return !!document.querySelector(sel); } catch (e) { return false; } })(${JSON.stringify(sel)})`;
}

function hasTextJs(text: string): string {
  return `((needle) => String(document.body ? document.body.innerText : "").includes(String(needle)))(${JSON.stringify(text)})`;
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function asElement(raw: unknown, ref: string): LiveElement | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const el: LiveElement = {
    ref,
    tag: String(o.tag ?? "").slice(0, 40),
    type: String(o.type ?? "").slice(0, 40),
    role: String(o.role ?? "").slice(0, 40),
    name: stripSecretText(String(o.name ?? "")).slice(0, 120),
    id: String(o.id ?? "").slice(0, 80),
    autocomplete: String(o.autocomplete ?? "").slice(0, 80),
    aria: stripSecretText(String(o.aria ?? "")).slice(0, 120),
    placeholder: stripSecretText(String(o.placeholder ?? "")).slice(0, 80),
    text: stripSecretText(String(o.text ?? "")).slice(0, 160),
    label: stripSecretText(String(o.label ?? "")).slice(0, 120),
    x: num(o.x), y: num(o.y), w: Math.max(0, num(o.w)), h: Math.max(0, num(o.h)),
    secret: o.secret === true || isSecretField({
      type: String(o.type ?? ""), autocomplete: String(o.autocomplete ?? ""),
      name: String(o.name ?? ""), id: String(o.id ?? ""), aria: String(o.aria ?? ""),
      placeholder: String(o.placeholder ?? ""), label: String(o.label ?? ""),
    }),
  };
  if (!el.secret && typeof o.value === "string") el.value = stripSecretText(o.value).slice(0, 80);
  return el;
}

export interface ReadResult { text: string; elements: LiveElement[] }

/** Page text plus one ref per interactive element. Refs are e1.. in document order and stay until the next read. */
export async function readPage(host: BrowserHost, tabId: string): Promise<ReadResult> {
  const textRaw = await evaluate(host, tabId, mark("TEXT", null, TEXT_JS));
  const nodesRaw = await evaluate(host, tabId, mark("READ", null, READ_JS));
  const text = stripSecretText(typeof textRaw === "string" ? textRaw : "").slice(0, TEXT_CAP);
  const nodes = Array.isArray(nodesRaw) ? nodesRaw.slice(0, MAX_ELEMENTS) : [];
  const elements: LiveElement[] = [];
  let n = 0;
  for (const node of nodes) {
    const el = asElement(node, `e${++n}`);
    if (el) elements.push(el);
  }
  return { text, elements };
}

export function centerOf(el: LiveElement): { x: number; y: number } | undefined {
  if (el.w <= 0 || el.h <= 0) return undefined;
  return { x: Math.round(el.x + el.w / 2), y: Math.round(el.y + el.h / 2) };
}

async function mouseClick(host: BrowserHost, tabId: string, x: number, y: number): Promise<void> {
  await cdp(host, tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp(host, tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function clickAt(host: BrowserHost, tabId: string, x: number, y: number): Promise<void> {
  await mouseClick(host, tabId, x, y);
}

const KEYS: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
};

export async function pressKey(host: BrowserHost, tabId: string, key: string): Promise<void> {
  const named = KEYS[key] ?? (key.length === 1 ? { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), text: key } : undefined);
  if (!named) throw new Error(`browser: unknown key ${JSON.stringify(key).slice(0, 40)}`);
  await cdp(host, tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...named });
  await cdp(host, tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: named.key, code: named.code, windowsVirtualKeyCode: named.windowsVirtualKeyCode });
}

/** Insert text into the focused field. The caller has already refused password and payment fields. */
export async function insertText(host: BrowserHost, tabId: string, text: string): Promise<void> {
  await cdp(host, tabId, "Input.insertText", { text });
}

export async function focusClick(host: BrowserHost, tabId: string, el: LiveElement): Promise<void> {
  const c = centerOf(el);
  if (!c) throw new Error("browser: that element is not visible, so it cannot be typed into");
  await mouseClick(host, tabId, c.x, c.y);
}

const SCROLL_MAX = 2000;

export async function scrollBy(host: BrowserHost, tabId: string, x: number, y: number, direction: string, amount: number): Promise<void> {
  const px = Math.min(SCROLL_MAX, Math.max(1, Math.floor(amount) || 480));
  let deltaX = 0, deltaY = 0;
  if (direction === "up") deltaY = -px;
  else if (direction === "left") deltaX = -px;
  else if (direction === "right") deltaX = px;
  else deltaY = px;
  await cdp(host, tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
}

export async function pageHasText(host: BrowserHost, tabId: string, text: string): Promise<boolean> {
  const v = await evaluate(host, tabId, mark("HAS_TEXT", text, hasTextJs(text)));
  return v === true;
}

export async function pageHasSelector(host: BrowserHost, tabId: string, selector: string): Promise<boolean> {
  const v = await evaluate(host, tabId, mark("QUERY", selector, queryJs(selector)));
  return v === true;
}

/** JPEG base64 from Page.captureScreenshot. The caller checks the magic bytes. */
export async function captureJpeg(host: BrowserHost, tabId: string): Promise<string> {
  await cdp(host, tabId, "Page.enable", {}).catch(() => undefined);
  const out = await cdp(host, tabId, "Page.captureScreenshot", { format: "jpeg", quality: 60 });
  const data = typeof out.data === "string" ? out.data : "";
  if (!data) throw new Error("browser: the page did not return a screenshot");
  return data;
}
