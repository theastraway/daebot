// What the browser may open, what a click means, and what a page is never allowed to hand back.
// The desktop pane enforces the same URL rules again (desktop/src/lib/browser-policy.mjs). Keep the two copies in step.

import type { ToolClass } from "../types.ts";

export const BROWSER_PARTITION = "persist:daebot-browser";

/** Side-by-side pane. About 45% of the window, never a sliver and never most of the chat. */
export const PANE_MIN_W = 420;
export const PANE_MAX_W = 760;

/** 0 means the width has not been chosen, so the window uses the CSS default. */
export function clampPaneWidth(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.min(PANE_MAX_W, Math.max(PANE_MIN_W, Math.round(x)));
}

/** Default width for a content area of `windowWidth` pixels: 45%, clamped. */
export function defaultPaneWidth(windowWidth: number): number {
  const w = Number.isFinite(windowWidth) && windowWidth > 0 ? windowWidth : 1200;
  return clampPaneWidth(w * 0.45);
}

/** Schemes a browsed page must never navigate to. data: is refused at the top level (this check runs on top-level navigations). */
const REFUSED_PROTOCOL = new Set(["file:", "chrome:", "chrome-extension:", "devtools:", "view-source:", "javascript:", "data:"]);

export interface NavDecision { ok: boolean; reason?: string }

/** Top-level navigation policy. about:blank is allowed so a new tab can exist before it loads. */
export function navigationAllowed(url: unknown, gatewayOrigin?: string): NavDecision {
  let u: URL;
  try { u = new URL(String(url ?? "")); } catch { return { ok: false, reason: "That URL is not valid." }; }
  if (u.protocol === "about:" && u.href.split("#")[0] === "about:blank") return { ok: true };
  if (REFUSED_PROTOCOL.has(u.protocol)) return { ok: false, reason: `Navigation to ${u.protocol} URLs is refused.` };
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: `Navigation to ${u.protocol} URLs is refused.` };
  if (gatewayOrigin) {
    try {
      if (u.origin === new URL(gatewayOrigin).origin) return { ok: false, reason: "Navigation to the gateway's own origin is refused." };
    } catch { /* a bad origin string does not widen what is allowed */ }
  }
  return { ok: true };
}

export interface FieldInfo {
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  aria?: string;
  placeholder?: string;
  label?: string;
  text?: string;
}

const PASSWORD_AUTO = new Set(["current-password", "new-password"]);

/** Password inputs, and fields the page itself marks as a password. */
export function isPasswordField(el: FieldInfo | undefined): boolean {
  if (!el) return false;
  const type = (el.type ?? "").toLowerCase();
  if (type === "password") return true;
  const ac = (el.autocomplete ?? "").toLowerCase();
  return PASSWORD_AUTO.has(ac);
}

const PAYMENT_AUTO = /^(cc-|one-time-code$)/i;
const PAYMENT_NAME = /(card[\s_-]*number|cardnumber|cc-number|cc-num|\bcvc\b|\bcvv\b|security[\s_-]*code|expir|exp[\s_-]*date|cc-csc|cc-exp)/i;

/** Payment fields: autocomplete cc-* / one-time-code, or a name, id, or aria label that is a card number, cvc, or expiry. */
export function isPaymentField(el: FieldInfo | undefined): boolean {
  if (!el) return false;
  const ac = (el.autocomplete ?? "").toLowerCase();
  if (PAYMENT_AUTO.test(ac)) return true;
  const blob = `${el.name ?? ""} ${el.id ?? ""} ${el.aria ?? ""} ${el.placeholder ?? ""} ${el.label ?? ""}`;
  return PAYMENT_NAME.test(blob);
}

export function isSecretField(el: FieldInfo | undefined): boolean {
  return isPasswordField(el) || isPaymentField(el);
}

export type ClickKind = "plain" | "submit" | "purchase" | "send" | "delete";

const PURCHASE = /\b(purchase|checkout|check out|pay|place order|place your order|buy now|confirm purchase|complete order|complete purchase)\b/i;
const DELETE = /\b(delete|remove)\b/i;
const SEND = /\b(send|post|publish)\b/i;

export interface ClickTarget {
  type?: string;
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
}

/**
 * What a click does, from the element's own label and type (the last read), never from JavaScript the model wrote.
 * Purchase and delete are irreversible. Sending, posting, publishing, and submitting a form are outward.
 */
export function classifyClick(el: ClickTarget | undefined): ClickKind {
  if (!el) return "plain";
  const label = `${el.name ?? ""} ${el.text ?? ""}`.replace(/\s+/g, " ").trim();
  if (PURCHASE.test(label)) return "purchase";
  if (DELETE.test(label)) return "delete";
  if (SEND.test(label)) return "send";
  const type = (el.type ?? "").toLowerCase();
  const tag = (el.tag ?? "").toLowerCase();
  const submitType = type === "submit" || (tag === "button" && type !== "button" && type !== "reset");
  if (submitType || /\bsubmit\b/i.test(label)) return "submit";
  return "plain";
}

export function classForClickKind(kind: ClickKind): ToolClass {
  if (kind === "purchase" || kind === "delete") return "irreversible";
  if (kind === "send" || kind === "submit") return "outward";
  return "write";
}

const SECRET_HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\n]*/gi;
const BEARER = /\b(bearer)\s+[a-z0-9._~+/-]{6,}/gi;
const STORAGE_LINE = /^[^\n]*\b(localStorage|sessionStorage|indexedDB)\b[^\n]*$/gim;

/** Redact header secrets and storage dumps from a string a page (or a CDP result) produced. */
export function stripSecretText(s: string): string {
  return String(s ?? "")
    .replace(SECRET_HEADER, "$1: [redacted]")
    .replace(BEARER, "$1 [redacted]")
    .replace(STORAGE_LINE, "[redacted storage]");
}

const DROP_KEY = /^(cookie|cookies|set-cookie|authorization|proxy-authorization|localstorage|sessionstorage|indexeddb|password|passwordvalue)$/i;

/**
 * Drop cookies, storage, and auth headers from a JSON-like CDP result.
 * Password and payment values are removed; the field's type and autocomplete stay so the tool can refuse to type.
 */
export function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return stripSecretText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((x) => stripSecrets(x, depth + 1));
  if (typeof value !== "object") return null;
  const src = value as Record<string, unknown>;
  const secret = src.secret === true || isSecretField(src as FieldInfo);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (DROP_KEY.test(k)) continue;
    if (k === "value") {
      if (secret) continue;
      out.value = typeof v === "string" ? stripSecretText(v).slice(0, 80) : null;
      continue;
    }
    if (k === "href" && typeof v === "string") {
      out.href = stripHref(v);
      continue;
    }
    out[k] = stripSecrets(v, depth + 1);
  }
  return out;
}

/** A link the model sees has no query string: tokens often live there. */
function stripHref(href: string): string {
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch { return ""; }
}
