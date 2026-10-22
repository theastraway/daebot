// Native-app sign-in handoff. The iOS app runs the MIND OAuth round trip inside ASWebAuthenticationSession (a system auth sheet that
// shares nothing with the WebView), and the sheet must END by navigating to the app's custom scheme. So the server finishes OAuth by
// redirecting to the ONE fixed callback below with a short-lived single-use code; the app then exchanges that code over HTTPS inside
// its WebView, and the response sets the session cookie there. No session, key or token ever appears in a URL.
//
// Hardening, because a custom scheme can be claimed by any app on the phone:
//   * the callback URL is a server constant, never read from the request (no open redirect, nothing to allow-list wrongly);
//   * the app sends a PKCE-style challenge when it starts the flow and the verifier at exchange, so a hijacked code is useless;
//   * codes live 60 seconds, work once, and the map is capped.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const APP_CALLBACK = "daebot://auth/callback";
export const APP_SCHEME = "daebot";
const FLOW_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 500;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9_-]{43,128}$/;

export const isValidChallenge = (v: unknown): v is string => typeof v === "string" && CHALLENGE_RE.test(v);
export const challengeOf = (verifier: string): string => createHash("sha256").update(verifier, "ascii").digest("base64url");

/** Exact match against the single registered callback; anything else (query-less prefix tricks included) is refused. */
export const isAppCallback = (url: string | null | undefined): boolean => url === APP_CALLBACK;

/** Builds the redirect target. Params are appended to the constant, so the origin and path cannot be influenced. */
export function appRedirect(params: { code?: string; error?: string }): string {
  const q = new URLSearchParams();
  if (params.code) q.set("code", params.code);
  if (params.error) q.set("error", params.error);
  return `${APP_CALLBACK}?${q.toString()}`;
}

export class AppHandoff {
  private flows = new Map<string, { cc: string; expires: number }>();
  private codes = new Map<string, { uid: string; cc: string; expires: number }>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  private sweep(): void {
    const t = this.now();
    for (const m of [this.flows, this.codes] as Map<string, { expires: number }>[]) {
      for (const [k, v] of m) if (v.expires <= t) m.delete(k);
      while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value as string);
    }
  }

  /** Remember that the OAuth `state` was started by the app, with the app's challenge. */
  beginFlow(state: string, cc: string): void {
    this.sweep();
    this.flows.set(state, { cc, expires: this.now() + FLOW_TTL_MS });
  }

  /** Single use: returns the challenge when this state belongs to an app flow. */
  takeFlow(state: string): string | undefined {
    this.sweep();
    const f = this.flows.get(state);
    this.flows.delete(state);
    return f && f.expires > this.now() ? f.cc : undefined;
  }

  mintCode(uid: string, cc: string): string {
    this.sweep();
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, { uid, cc, expires: this.now() + CODE_TTL_MS });
    return code;
  }

  /** Single use, success or fail. Returns the user id when code and verifier match. */
  redeem(code: unknown, verifier: unknown): string | undefined {
    this.sweep();
    if (typeof code !== "string" || code.length > 200) return undefined;
    const c = this.codes.get(code);
    this.codes.delete(code);
    if (!c || c.expires <= this.now()) return undefined;
    if (typeof verifier !== "string" || !VERIFIER_RE.test(verifier)) return undefined;
    const a = Buffer.from(challengeOf(verifier));
    const b = Buffer.from(c.cc);
    return a.length === b.length && timingSafeEqual(a, b) ? c.uid : undefined;
  }
}
