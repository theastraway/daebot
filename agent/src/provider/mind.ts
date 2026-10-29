// MIND-billed provider (DAEBOT_BILLING=mind). Same OpenRouter-style SSE stream and the same pre-output model fallback as
// openrouter.ts (it IS that provider, parameterised), but the call goes to MIND's LLM endpoint with the USER's own MIND key,
// so MIND plan tier and credits are the only cap. A 402 from MIND is a billing refusal, not an upstream hiccup: it never
// falls through to another model, it surfaces as MindBillingError with a user-facing message that links the upgrade page.
import { createHash } from "node:crypto";
import type { Config, Provider, StreamEvent } from "../types.ts";
import { createOpenRouterProvider, ProviderHttpError } from "./openrouter.ts";

export const FREE_TIER = "free";
export const DEFAULT_FREE_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
export const CREDITS_TTL_MS = 5 * 60 * 1000;

// model_not_available: MIND answered 400, the model is not in its list. endpoint_disabled: MIND answered 404, the LLM proxy flag is off.
export type BillingCode = "insufficient_credits" | "model_not_in_plan" | "model_not_available" | "endpoint_disabled";

export interface MindBilling {
  tier: string;              // MIND plan id ("free", "starter", ...)
  tierName: string;          // display name ("Explorer", "Starter", ...)
  creditsRemaining: number | null;
  /** The plan's allowance for the period (credits_limit); null/0 = no fixed allowance (pay as you go). */
  creditsLimit: number | null;
  upgradeUrl: string;
  /** Which key serves Daebot's calls for this MIND account: "byo" = the account's own provider key (no MIND credits used). */
  keySource?: "byo" | "platform";
  /** The own-key provider name (e.g. "openrouter"), never the key. */
  provider?: string | null;
  /** The model chosen in the MIND account (its chat model picker), null when never chosen. */
  accountModel?: string | null;
}

/** True when the account's own key serves the call: plan tier and credits do not limit it, so the free-plan model swap must not apply. */
export const usesOwnKey = (b: Pick<MindBilling, "keySource"> | undefined): boolean => b?.keySource === "byo";

/** Percent of the plan's usage still left (0-100), or null when there is no fixed allowance to measure against. */
export function usageLeftPct(b: Pick<MindBilling, "creditsRemaining" | "creditsLimit">): number | null {
  const { creditsRemaining: left, creditsLimit: lim } = b;
  if (left === null || lim === null || !(lim > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((left / lim) * 100)));
}

/** "free" is shown as Explorer; any other tier id is capitalised unless MIND sent a display name. */
export function tierDisplayName(tier: string, sent?: unknown): string {
  if (typeof sent === "string" && sent.trim()) return sent.trim();
  const t = tier.trim();
  if (!t || t.toLowerCase() === FREE_TIER) return "Explorer";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export class MindBillingError extends ProviderHttpError {
  code: BillingCode;
  tier: string;
  creditsRemaining: number | null;
  upgradeUrl: string;
  /** The line the gateway shows the user (the loop prefers it over the raw error text). */
  userNotice: string;
  constructor(code: BillingCode, b: { tier: string; creditsRemaining: number | null; upgradeUrl: string }, status = 402) {
    const plan = tierDisplayName(b.tier);
    const text = code === "model_not_in_plan" ? `This model needs a paid MIND plan (you are on ${plan}). Upgrade: ${b.upgradeUrl}`
      : code === "model_not_available" ? `This model is not available on MIND (${plan} plan). See plans: ${b.upgradeUrl}`
      : code === "endpoint_disabled" ? "Daebot can't reach the AI on your MIND account right now. Please try again in a few minutes."
      : `You've used this month's plan usage (${plan} plan). Upgrade: ${b.upgradeUrl}`;
    super(status, text);
    this.name = "MindBillingError";
    this.fatal = true;
    this.code = code;
    this.tier = b.tier;
    this.creditsRemaining = b.creditsRemaining;
    this.upgradeUrl = b.upgradeUrl;
    this.userNotice = text;
  }
}

export const mindLlmUrl = (cfg: Config): string => `${cfg.mindBaseUrl.replace(/\/+$/, "")}/llm/chat/completions`;

const keyId = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 24);
const num = (v: unknown): number | null => (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

interface Entry { b: MindBilling; at: number }

/**
 * Per-user tier + credits, cached ~5 minutes. One instance is shared by the providers (which feed it the
 * X-MIND-* response headers after every call) and the gateway (which reads it for /auth/me).
 */
export class MindCredits {
  private base: string;
  private origin: string;
  private doFetch: typeof fetch;
  private ttl: number;
  private now: () => number;
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<MindBilling | undefined>>();
  constructor(o: { mindBaseUrl: string; fetchImpl?: typeof fetch; ttlMs?: number; now?: () => number }) {
    this.base = o.mindBaseUrl.replace(/\/+$/, "");
    this.origin = (() => { try { return new URL(this.base).origin; } catch { return this.base; } })();
    this.doFetch = o.fetchImpl ?? ((...a) => fetch(...a));
    this.ttl = o.ttlMs ?? CREDITS_TTL_MS;
    this.now = o.now ?? Date.now;
  }

  /** Where "manage your plan" points when MIND did not send an upgrade_url. */
  get defaultUpgradeUrl(): string { return this.origin; }

  /**
   * Cached billing state, fetched from GET /credits when missing, older than `maxAgeMs` (default the 5 minute TTL) or `force`d.
   * Undefined when MIND is unreachable and nothing is cached.
   */
  async get(key: string, force = false, maxAgeMs = this.ttl): Promise<MindBilling | undefined> {
    if (!key) return undefined;
    const id = keyId(key);
    const hit = this.cache.get(id);
    if (hit && !force && this.now() - hit.at < Math.min(maxAgeMs, this.ttl)) return hit.b;
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.fetchOne(key, id, hit?.b).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /** Last known state without any network call. */
  peek(key: string): MindBilling | undefined { return this.cache.get(keyId(key))?.b; }

  /** Fold in fresher numbers (X-MIND-* headers, or a 402 body). Needs a known tier from the cache or the update itself. */
  note(key: string, u: { tier?: string | null; creditsRemaining?: number | null; upgradeUrl?: string | null; keySource?: string | null }): void {
    if (!key) return;
    const id = keyId(key);
    const cur = this.cache.get(id)?.b;
    const tier = (u.tier ?? "").trim() || cur?.tier;
    if (!tier) return; // no tier yet: the next get() fetches it
    const changed = cur && cur.tier !== tier;
    this.cache.set(id, {
      at: this.now(),
      b: {
        tier,
        tierName: !changed && cur ? cur.tierName : tierDisplayName(tier),
        creditsRemaining: u.creditsRemaining !== undefined && u.creditsRemaining !== null ? u.creditsRemaining : cur?.creditsRemaining ?? null,
        creditsLimit: cur?.creditsLimit ?? null, // the allowance only changes with the plan; /credits refreshes it
        upgradeUrl: u.upgradeUrl || cur?.upgradeUrl || this.origin,
        keySource: u.keySource === "byo" || u.keySource === "platform" ? u.keySource : cur?.keySource,
        provider: cur?.provider, accountModel: cur?.accountModel,
      },
    });
  }

  private async fetchOne(key: string, id: string, stale?: MindBilling): Promise<MindBilling | undefined> {
    try {
      const headers = { "X-API-Key": key, Accept: "application/json" };
      // The account's key source and chosen model ride along (best effort: an older MIND answers 404 and the plain plan is used).
      const routingP = this.doFetch(`${this.base}/llm/account`, { headers, signal: AbortSignal.timeout(10_000) })
        .then(async (r) => (r.ok ? ((await r.json()) as Record<string, unknown>) : undefined)).catch(() => undefined);
      const res = await this.doFetch(`${this.base}/credits`, { headers, signal: AbortSignal.timeout(10_000) });
      const routing = await routingP;
      if (!res.ok) return stale;
      const j = (await res.json()) as Record<string, unknown>;
      const tier = typeof j.tier === "string" && j.tier.trim() ? j.tier.trim() : stale?.tier;
      if (!tier) return stale;
      const ks = routing?.key_source === "byo" || routing?.key_source === "platform" ? routing.key_source : stale?.keySource;
      const b: MindBilling = {
        tier,
        tierName: tierDisplayName(tier, j.tier_name ?? j.tierName),
        creditsRemaining: num(j.credits_balance ?? j.credits_remaining),
        creditsLimit: num(j.credits_limit),
        upgradeUrl: typeof j.upgrade_url === "string" && j.upgrade_url ? j.upgrade_url : stale?.upgradeUrl ?? this.origin,
        keySource: ks,
        provider: routing ? (typeof routing.provider === "string" ? routing.provider : null) : stale?.provider,
        accountModel: routing ? (typeof routing.model === "string" && routing.model ? routing.model : null) : stale?.accountModel,
      };
      this.cache.set(id, { b, at: this.now() });
      return b;
    } catch {
      return stale; // keep serving the last known state through a blip
    }
  }
}

export interface MindProviderOptions {
  /** The user's current MIND key (live, so a rotated OAuth key is picked up). Never the server's key for a user runtime. */
  getKey: () => string;
  credits: MindCredits;
  fetchImpl?: typeof fetch;
  backoffMs?: number;
}

export function createMindProvider(cfg: Config, o: MindProviderOptions): Provider {
  const freeModel = cfg.freeModel || DEFAULT_FREE_MODEL;
  const url = mindLlmUrl(cfg);
  const f = o.fetchImpl ?? fetch;

  const shared = {
    url, name: "mind", backoffMs: o.backoffMs,
    headers: () => ({ "Content-Type": "application/json", "X-API-Key": o.getKey() }),
    onResponse: (res: Response) => {
      const tier = res.headers.get("x-mind-tier");
      const left = res.headers.get("x-mind-credits-remaining");
      const keySource = res.headers.get("x-mind-key-source");
      if (tier || left || keySource) o.credits.note(o.getKey(), { tier, creditsRemaining: num(left), keySource });
    },
    errorFor: (status: number, body: string): ProviderHttpError | undefined => {
      const known = o.credits.peek(o.getKey());
      // A 404 is "MIND's LLM route is off" only when it is MIND's own Not Found. An OpenRouter 404 relayed by the proxy
      // ({"error":{"message":"No endpoints found for <model>"...}}) is one model being unavailable: take the normal error
      // path so the fallback models get a turn and the real reason is shown.
      if (status === 404) {
        let upstream = false;
        try { const j = JSON.parse(body); upstream = !!j && typeof j.error === "object" && j.error !== null && typeof j.error.message === "string"; } catch { /* plain text: MIND's own 404 */ }
        if (upstream) return undefined;
        return new MindBillingError("endpoint_disabled", { tier: known?.tier ?? "", creditsRemaining: null, upgradeUrl: o.credits.defaultUpgradeUrl }, 404);
      }
      if (status !== 402 && status !== 400) return undefined;
      let j: any;
      try { j = JSON.parse(body); } catch { return undefined; }
      const code = j?.error;
      if (status === 402 ? code !== "insufficient_credits" && code !== "model_not_in_plan" : code !== "model_not_available") return undefined;
      const tier = typeof j.tier === "string" && j.tier ? j.tier : known?.tier ?? "";
      const upgradeUrl = typeof j.upgrade_url === "string" && j.upgrade_url ? j.upgrade_url : known?.upgradeUrl ?? o.credits.defaultUpgradeUrl;
      const creditsRemaining = num(j.credits_balance ?? j.credits_remaining);
      if (tier) o.credits.note(o.getKey(), { tier, creditsRemaining, upgradeUrl });
      return new MindBillingError(code, { tier, creditsRemaining, upgradeUrl }, status);
    },
  };
  // Paid plans: the normal default model with cfg.models.fallback. Free plan: only the free model (a paid fallback would 402).
  const paid = createOpenRouterProvider(cfg, f, shared);
  const free = createOpenRouterProvider({ ...cfg, models: { ...cfg.models, fallback: [] } }, f, shared);

  return {
    name: "mind",
    async *stream(req) {
      // pinModel (view_photo): the caller picked the exact model for the job and already knows the plan. No free/paid swap and no
      // fallback list (`free` has none); a billing refusal still surfaces as MindBillingError for the caller to word.
      if (req.pinModel) { yield* free.stream(req); return; }
      const b = await o.credits.get(o.getKey());
      const onFree = b?.tier === FREE_TIER && !usesOwnKey(b); // an own key is not limited by the MIND plan
      let emitted = false;
      try {
        for await (const ev of (onFree ? free : paid).stream({ ...req, model: onFree ? freeModel : req.model }) as AsyncIterable<StreamEvent>) { emitted = true; yield onFree && ev.type === "done" ? { ...ev, model: freeModel } : ev; }
        return;
      } catch (e) {
        // The plan lookup was wrong or stale (e.g. just downgraded), or the model is not in MIND's list: one retry on the free model, only if nothing reached the user.
        if (!(e instanceof MindBillingError) || (e.code !== "model_not_in_plan" && e.code !== "model_not_available") || onFree || emitted || req.model === freeModel) throw e;
      }
      // The user asked for a paid model and got the free one: say so (the loop shows `notice` once, after the answer).
      for await (const ev of free.stream({ ...req, model: freeModel })) yield ev.type === "done" ? { ...ev, notice: "Answered on the free model", model: freeModel } : ev;
    },
  };
}
