// Spend caps: one for the whole MIND account and one per bot. The caps, the spend and the refusals all live in MIND
// (MINDapp backend/services/spend_caps.py, enforced in the LLM proxy before any call is made, from llm_call_ledger), so
// they bind every Daebot device and bot of the account, hosted or desktop. This file only reads and writes them with the
// signed-in user's own MIND key: GET/PUT {mind}/llm/spend-caps. USD and daily/weekly/monthly (America/New_York) only.

export type CapPeriod = "daily" | "weekly" | "monthly";
export interface CapSpec { usd: number; period: CapPeriod; alertPct: number | null }
export interface CapView {
  cap: CapSpec | null;
  period: CapPeriod;
  spentUsd: number;
  remainingUsd: number | null;
  pct: number | null;
  reached: boolean;
  alert: boolean;
  periodStart: string | null;
  resetsAt: string | null;
}
export interface SpendCaps {
  account: CapView;
  bots: Record<string, CapView>;
  effective?: { scope: "account" | "bot" | null; remainingUsd: number | null; reached: boolean };
  alert: boolean;
  reached: boolean;
}
export type SpendCapsResult = { source: "mind"; caps: SpendCaps } | { source: "own-key" } | { source: "owner" } | { source: "mind"; error: "unavailable" };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const PERIODS = ["daily", "weekly", "monthly"] as const;
const iso = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const BOT_ID = /^[a-z0-9-]{1,32}$/; // a bot slug
export const validBotId = (s: unknown): s is string => typeof s === "string" && BOT_ID.test(s);

export function capFromMind(j: any): CapSpec | null {
  if (!j || typeof j !== "object") return null;
  const usd = num(j.usd);
  const period = PERIODS.find((p) => p === j.period);
  if (usd === null || !(usd > 0) || !period) return null;
  return { usd, period, alertPct: num(j.alert_pct) };
}

export function viewFromMind(j: any): CapView {
  const period = PERIODS.find((p) => p === j?.period) ?? "monthly";
  return {
    cap: capFromMind(j?.cap), period, spentUsd: num(j?.spent_usd) ?? 0, remainingUsd: num(j?.remaining_usd), pct: num(j?.pct),
    reached: j?.reached === true, alert: j?.alert === true, periodStart: iso(j?.period_start), resetsAt: iso(j?.resets_at),
  };
}

export function capsFromMind(j: any): SpendCaps {
  const bots: Record<string, CapView> = {};
  for (const [id, v] of Object.entries(j?.bots ?? {})) if (validBotId(id)) bots[id] = viewFromMind(v);
  const e = j?.effective;
  return {
    account: viewFromMind(j?.account), bots, alert: j?.alert === true, reached: j?.reached === true,
    ...(e && typeof e === "object" ? { effective: { scope: e.scope === "account" || e.scope === "bot" ? e.scope : null, remainingUsd: num(e.remaining_usd), reached: e.reached === true } } : {}),
  };
}

export class SpendCapsError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

const trim = (s: string): string => s.replace(/\/+$/, "");

export async function fetchSpendCaps(base: string, key: string, bot: string | undefined, fetchImpl: typeof fetch = fetch): Promise<SpendCapsResult> {
  let res: Response;
  const q = bot ? `?bot=${encodeURIComponent(bot)}` : "";
  try { res = await fetchImpl(`${trim(base)}/llm/spend-caps${q}`, { headers: { "X-API-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }); }
  catch { return { source: "mind", error: "unavailable" }; }
  if (!res.ok) return { source: "mind", error: "unavailable" };
  return { source: "mind", caps: capsFromMind(await res.json().catch(() => ({}))) };
}

/** What the browser may send: {account?: cap|null, bots?: {id: cap|null}} with cap = {usd, period, alertPct}. Anything else is a 400. */
export function toMindBody(b: any): Record<string, unknown> {
  const cap = (c: any): Record<string, unknown> | null => {
    if (c === null) return null;
    if (!c || typeof c !== "object") throw new SpendCapsError("A cap is an amount, a period and an optional alert percent.", 400);
    const usd = num(c.usd);
    if (usd === null || !(usd > 0) || usd > 100000) throw new SpendCapsError("The cap must be an amount above $0.", 400);
    if (!PERIODS.includes(c.period)) throw new SpendCapsError("Pick daily, weekly or monthly.", 400);
    const a = c.alertPct === null || c.alertPct === undefined || c.alertPct === "" ? null : num(c.alertPct);
    if (a !== null && !(a >= 1 && a <= 100)) throw new SpendCapsError("The alert percent must be between 1 and 100.", 400);
    return { usd, period: c.period, alert_pct: a === null ? null : Math.round(a) };
  };
  const out: Record<string, unknown> = {};
  if (b && "account" in b) out.account = cap(b.account);
  if (b?.bots !== undefined) {
    if (!b.bots || typeof b.bots !== "object" || Array.isArray(b.bots)) throw new SpendCapsError("bots must map a bot id to a cap or null.", 400);
    const bots: Record<string, unknown> = {};
    for (const [id, c] of Object.entries(b.bots)) { if (!validBotId(id)) throw new SpendCapsError("Unknown bot.", 400); bots[id] = cap(c); }
    out.bots = bots;
  }
  if (!("account" in out) && !("bots" in out)) throw new SpendCapsError("Nothing to change.", 400);
  return out;
}

export async function putSpendCaps(base: string, key: string, body: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<SpendCaps> {
  let res: Response;
  try {
    res = await fetchImpl(`${trim(base)}/llm/spend-caps`, { method: "PUT", headers: { "X-API-Key": key, Accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  } catch { throw new SpendCapsError("Could not reach MIND. Try again in a moment.", 502); }
  if (res.status === 404) throw new SpendCapsError("Spend caps are not available yet.", 409);
  if (res.status === 401 || res.status === 403) throw new SpendCapsError("MIND did not accept your sign-in. Sign in again.", 401);
  if (res.status === 400) { const j: any = await res.json().catch(() => ({})); throw new SpendCapsError(typeof j?.detail === "string" ? j.detail.slice(0, 200) : "That cap is not valid.", 400); }
  if (!res.ok) throw new SpendCapsError("MIND could not change the cap right now.", 502);
  return capsFromMind(await res.json().catch(() => ({})));
}
