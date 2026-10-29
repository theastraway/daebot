// Apps for Daebot: the signed-in user's MIND integrations (Google, Microsoft 365, Dropbox, GitHub, ...).
//   GET  /apps/integrations                         every provider + this user's connected state
//   POST /apps/integrations/:provider/connect       { authUrl } to open in a new tab (MIND's own OAuth flow)
//   POST /apps/integrations/:provider/disconnect    drop the connection at MIND
//   GET  /apps/referral                             this user's MIND referral link + the real offer terms (the gift modal)
// Every call goes to MIND's /developer/v1/integrations with the SIGNED-IN USER'S OWN MIND key as X-API-Key. The key never
// reaches the browser and is never logged or echoed. The owner access-code login has no MIND user, so it gets a plain
// "sign in with MIND" answer instead of the server key's integrations.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../auth/users.ts";
import { normalizeProviders } from "../mind/integrations.ts";
import type { AppRow } from "../mind/integrations.ts";

// The provider list is read in ../mind/integrations.ts (shared with the system prompt's "Connected apps" section); re-exported here.
export { normalizeProviders };
export type { AppRow };

const UPSTREAM_TIMEOUT_MS = 20_000;
const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SIGN_IN_MESSAGE = "Sign in with MIND to connect apps.";

export interface AppsOptions {
  /** MIND API base, e.g. https://m-i-n-d.ai/developer/v1 */
  baseUrl: string;
  /** The signed-in user's own MIND key; undefined for the owner access-code login. */
  keyFor(p: Principal): string | undefined;
  /** Where MIND bounces the browser after a provider approves, e.g. https://daebot.live/ . Optional. */
  returnTo?: string;
  fetchImpl?: typeof fetch;
  /** Called after this user's apps were read, connected or disconnected, so what Daebot knows about them is read again on the next turn. */
  onChanged?(p: Principal): void;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(data)), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(data);
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** MIND's /developer/v1/referral answer, trimmed: an https link on MIND's own host plus the two credit amounts (pure). */
export function normalizeReferral(j: any): { url: string; code: string; referrerCredits: number; refereeCredits: number } | null {
  let url = "";
  try { const u = new URL(str(j?.url, 300)); if (u.protocol === "https:" && /^(www\.)?m-i-n-d\.ai$/.test(u.hostname)) url = u.href; } catch { /* no usable link */ }
  const n = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1_000_000 ? v : 0);
  const referrerCredits = n(j?.referrer_credits), refereeCredits = n(j?.referee_credits);
  const code = str(j?.code, 32);
  return url && code && referrerCredits && refereeCredits ? { url, code, referrerCredits, refereeCredits } : null;
}

function mapError(status: number): { status: number; body: Record<string, unknown> } {
  if (status === 401 || status === 403) return { status: 401, body: { error: "mind_key_rejected", message: "MIND did not accept your key for apps. Sign in again." } };
  if (status === 404) return { status: 503, body: { error: "apps_unavailable", message: "Apps are not switched on at MIND yet." } };
  if (status === 409 || status === 400) return { status: 400, body: { error: "apps_refused", message: "MIND could not do that for this app." } };
  if (status === 503) return { status: 503, body: { error: "apps_unavailable", message: "That app is not set up at MIND yet." } };
  return { status: 502, body: { error: "apps_failed", message: "MIND could not finish that request. Try again in a moment." } };
}

async function readJsonSmall(req: IncomingMessage): Promise<void> {
  // The connect/disconnect calls take no browser input; drain whatever was sent.
  await new Promise<void>((resolve) => { let n = 0; req.on("data", (c: Buffer) => { n += c.length; if (n > 16 * 1024) req.destroy(); }); req.on("end", () => resolve()); req.on("error", () => resolve()); req.on("close", () => resolve()); });
}

export function createAppsHandler(o: AppsOptions): (req: IncomingMessage, res: ServerResponse, path: string, p: Principal) => Promise<void> {
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.baseUrl.replace(/\/+$/, "");
  const returnTo = (() => { try { const u = new URL(o.returnTo ?? ""); return u.protocol === "https:" ? u.origin + "/" : undefined; } catch { return undefined; } })();

  return async (req, res, path, p) => {
    const method = req.method ?? "GET";
    const key = o.keyFor(p);
    const needsSignIn = !key; // keyFor already returns nothing for the hosted access-code owner
    if (path === "/apps/referral") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (needsSignIn) return json(res, 200, { signedIn: false });
      try {
        const r = await f(`${base}/referral`, { headers: { "X-API-Key": key!, Accept: "application/json" }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
        if (!r.ok) { const m = mapError(r.status); return json(res, m.status, m.body); }
        const ref = normalizeReferral(await r.json().catch(() => ({})));
        if (!ref) return json(res, 502, { error: "referral_failed", message: "MIND did not return a referral link." });
        return json(res, 200, { signedIn: true, ...ref });
      } catch { return json(res, 502, { error: "referral_failed", message: "MIND could not be reached. Try again in a moment." }); }
    }
    if (path === "/apps/integrations") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (needsSignIn) return json(res, 200, { signedIn: false, message: SIGN_IN_MESSAGE, enabled: true, providers: [] });
      try {
        const r = await f(`${base}/integrations`, { headers: { "X-API-Key": key!, Accept: "application/json" }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
        if (!r.ok) { const m = mapError(r.status); return json(res, m.status, m.body); }
        const j = await r.json().catch(() => ({}));
        try { o.onChanged?.(p); } catch { /* best effort */ }
        return json(res, 200, { signedIn: true, ...normalizeProviders(j) });
      } catch { return json(res, 502, { error: "apps_failed", message: "MIND could not be reached. Try again in a moment." }); }
    }
    const m = /^\/apps\/integrations\/([^/]+)\/(connect|disconnect)$/.exec(path);
    if (!m) return json(res, 404, { error: "not found" });
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    await readJsonSmall(req);
    let provider = "";
    try { provider = decodeURIComponent(m[1]); } catch { /* falls through to the check */ }
    if (!PROVIDER_RE.test(provider)) return json(res, 400, { error: "bad_provider", message: "Unknown app." });
    if (needsSignIn) return json(res, 403, { error: "sign_in_with_mind", message: SIGN_IN_MESSAGE });
    const action = m[2];
    try {
      const r = await f(`${base}/integrations/${encodeURIComponent(provider)}/${action}`, {
        method: "POST",
        headers: { "X-API-Key": key!, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(action === "connect" && returnTo ? { return_to: returnTo } : {}),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!r.ok) { const e = mapError(r.status); return json(res, e.status, e.body); }
      const j: any = await r.json().catch(() => ({}));
      try { o.onChanged?.(p); } catch { /* best effort */ }
      if (action === "disconnect") return json(res, 200, { ok: true, status: str(j?.status, 40) || "disconnected" });
      if (j?.auth_type === "credentials") return json(res, 200, { authType: "credentials", setupUrl: "https://www.m-i-n-d.ai/#/integrations" });
      let url = "";
      try { const u = new URL(str(j?.auth_url, 4000)); if (u.protocol === "https:") url = u.href; } catch { /* no usable URL */ }
      if (!url) return json(res, 502, { error: "apps_failed", message: "MIND did not return a sign-in link for that app." });
      return json(res, 200, { authType: "oauth", authUrl: url });
    } catch { return json(res, 502, { error: "apps_failed", message: "MIND could not be reached. Try again in a moment." }); }
  };
}
