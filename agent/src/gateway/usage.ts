// The user menu's usage line and the one-click "Additional usage" switch.
// Both are MIND's: GET /developer/v1/usage reads the plan, the percent left, the reset date and the switch state;
// PUT /developer/v1/usage/additional flips it (MINDapp backend/routes/developer_routes.py dev_get_usage / dev_set_additional_usage;
// the switch is subscriptions.payg_overage_enabled, read at middleware/usage_tracker.py payg_extra_usage_active).
// Every call carries the signed-in user's own MIND key. Usage language only: the billing unit (credits) is never shown.
import { tierDisplayName } from "../provider/mind.ts";

export interface AdditionalUsage {
  /** The switch can be offered and turned on right now (paid plan, live subscription, platform feature on). */
  available: boolean;
  enabled: boolean;
  /** Going past the limit is billed right now (enabled and eligible). */
  active: boolean;
  /** The platform feature is not switched on and this plan keeps going past its limit on its own; there is no switch. */
  automatic: boolean;
  /** MIND's own price line (cost basis), shown as given; null when MIND sends none. Never invented here. */
  rateNote: string | null;
  overflowUsd: number;
}

export type UsageState = "normal" | "low" | "empty" | "unlimited";

export type UsageView =
  | { source: "mind"; plan: string; planName: string; percentLeft: number | null; percentUsed: number | null; resetAt: string | null; state: UsageState; additional: AdditionalUsage; manageUrl: string }
  | { source: "own-key" }
  | { source: "owner" }
  | { source: "mind"; error: "unavailable" };

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp = (v: number): number => Math.max(0, Math.min(100, v));

/** What the menu shows from MIND's /usage body. Tolerates a missing or partial body (older MIND): the line just has less in it. */
export function usageFromMind(j: any, manageUrl = "https://m-i-n-d.ai"): Extract<UsageView, { plan: string }> {
  const plan = typeof j?.plan === "string" && j.plan.trim() ? j.plan.trim() : "free";
  const unlimited = j?.unlimited === true;
  const used = n(j?.percent_used);
  const leftRaw = n(j?.percent_left) ?? (used === null ? null : 100 - used);
  const percentLeft = unlimited || leftRaw === null ? null : Math.round(clamp(leftRaw));
  const a = j?.additional_usage ?? {};
  const additional: AdditionalUsage = {
    available: a.available === true,
    enabled: a.enabled === true,
    active: a.active === true,
    automatic: a.automatic === true,
    rateNote: typeof a.rate_note === "string" && a.rate_note.trim() ? a.rate_note.trim().slice(0, 200) : null,
    overflowUsd: n(a.overflow_usd) ?? 0,
  };
  const state: UsageState = unlimited ? "unlimited" : percentLeft === null ? "normal" : percentLeft <= 0 ? "empty" : percentLeft <= 20 ? "low" : "normal";
  let resetAt: string | null = null;
  if (typeof j?.reset_at === "string" && !Number.isNaN(Date.parse(j.reset_at))) resetAt = new Date(j.reset_at).toISOString();
  return {
    source: "mind", plan, planName: tierDisplayName(plan, j?.tier_name), percentLeft,
    percentUsed: unlimited ? null : percentLeft === null ? null : 100 - percentLeft, resetAt, state, additional, manageUrl,
  };
}

export class UsageError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

const trim = (s: string): string => s.replace(/\/+$/, "");
const originOf = (base: string): string => { try { return new URL(base).origin; } catch { return "https://m-i-n-d.ai"; } };

export async function fetchUsage(base: string, key: string, fetchImpl: typeof fetch = fetch): Promise<UsageView> {
  let res: Response;
  try { res = await fetchImpl(`${trim(base)}/usage`, { headers: { "X-API-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }); }
  catch { return { source: "mind", error: "unavailable" }; }
  if (!res.ok) return { source: "mind", error: "unavailable" };
  return usageFromMind(await res.json().catch(() => ({})), originOf(base));
}

/** Flips Additional usage and returns the fresh view. MIND's refusals (not available yet, not a paid plan) become UsageError with a plain sentence. */
export async function setAdditional(base: string, key: string, enabled: boolean, fetchImpl: typeof fetch = fetch): Promise<UsageView> {
  let res: Response;
  try {
    res = await fetchImpl(`${trim(base)}/usage/additional`, {
      method: "PUT", headers: { "X-API-Key": key, Accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ enabled }), signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new UsageError("Could not reach MIND. Try again in a moment.", 502); }
  if (res.status === 404) throw new UsageError("Additional usage is not available yet.", 409);
  if (res.status === 403) throw new UsageError("Additional usage needs a paid plan with an active subscription.", 409);
  if (res.status === 401) throw new UsageError("MIND did not accept your sign-in. Sign in again.", 401);
  if (!res.ok) throw new UsageError("MIND could not change Additional usage right now.", 502);
  return usageFromMind(await res.json().catch(() => ({})), originOf(base));
}
