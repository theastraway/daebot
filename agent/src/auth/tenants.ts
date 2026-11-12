// MIND tenants a signed-in user owns, from MIND's own multi-MIND accounts API (accounts_routes.py, mounted at /developer/v1/accounts).
// The caller's OWN MIND credential is the only thing used to ask: MIND answers with every MIND that credential may switch into, and
// only grants whose role is "owner" count here (viewers are never listed or switchable). Switching mints MIND's delegated token
// (POST /accounts/switch, MIND checks the grant again), and that token creates a plain tenant API key (POST /developer/keys) which is
// what a Daebot account for the tenant runs on. Nothing here trusts the browser: callers pass a username, MIND decides.

export interface OwnedTenant { username: string; label: string; self: boolean }

export class TenantError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

const DEFAULT_TTL_MS = 20_000;
const MAX_TENANTS = 500;
const USERNAME_OK = (u: unknown): u is string => typeof u === "string" && u.length > 0 && u.length <= 120 && !/[\u0000-\u001f]/.test(u);

export class TenantDirectory {
  private cache = new Map<string, { at: number; list: OwnedTenant[] }>();
  private base: string;
  private origin: string;
  private f: typeof fetch;
  private now: () => number;
  private ttl: number;

  /** @param mindBaseUrl the developer API base, e.g. https://mindapp.onrender.com/developer/v1 */
  constructor(mindBaseUrl: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now, ttlMs = DEFAULT_TTL_MS) {
    this.ttl = ttlMs;
    this.base = mindBaseUrl.replace(/\/+$/, "");
    this.origin = new URL(this.base).origin;
    this.f = fetchImpl;
    this.now = now;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try { return await this.f(url, { ...init, signal: AbortSignal.timeout(15_000) }); } catch { throw new TenantError("Could not reach MIND.", 502); }
  }

  /** Every MIND this credential owns (its own first). Cached briefly per credential; `fresh` skips the cache (used before any switch). */
  async owned(actorKey: string, fresh = false): Promise<OwnedTenant[]> {
    const ck = actorKey.slice(-24);
    const hit = this.cache.get(ck);
    if (!fresh && hit && this.now() - hit.at < this.ttl) return hit.list;
    const r = await this.call(`${this.base}/accounts`, { headers: { "X-API-Key": actorKey, Accept: "application/json" } });
    if (r.status === 401 || r.status === 403) throw new TenantError("MIND did not accept that sign-in.", 401);
    if (r.status === 404) return []; // multi-MIND accounts are not enabled on this MIND
    if (!r.ok) throw new TenantError("MIND could not list your MINDs right now.", 502);
    const body: any = await r.json().catch(() => ({}));
    const list: OwnedTenant[] = [];
    const seen = new Set<string>();
    for (const a of Array.isArray(body?.accounts) ? body.accounts : []) {
      if (!a || !USERNAME_OK(a.username) || a.role !== "owner") continue;
      const k = a.username.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      list.push({ username: a.username, label: typeof a.label === "string" && a.label.trim() ? a.label.trim().slice(0, 80) : a.username, self: a.is_self === true });
      if (list.length >= MAX_TENANTS) break;
    }
    this.cache.set(ck, { at: this.now(), list });
    while (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string);
    return list;
  }

  /** Mints a tenant API key for a MIND the actor owns. MIND re-checks the grant on /accounts/switch; a refusal is a refusal here. */
  async mintKey(actorKey: string, tenant: string): Promise<string> {
    const sw = await this.call(`${this.base}/accounts/switch`, {
      method: "POST",
      headers: { "X-API-Key": actorKey, "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: tenant }),
    });
    if (sw.status === 403 || sw.status === 404) throw new TenantError("You do not own that MIND.", 403);
    if (!sw.ok) throw new TenantError("MIND could not switch to that account right now.", 502);
    const swb: any = await sw.json().catch(() => ({}));
    const jwt = typeof swb?.access_token === "string" ? swb.access_token : "";
    if (!jwt || swb?.account?.username !== tenant) throw new TenantError("MIND did not return a token for that account.", 502);
    const kr = await this.call(`${this.origin}/developer/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: "Daebot account switch" }),
    });
    if (!kr.ok) throw new TenantError("MIND could not issue a key for that account.", 502);
    const kb: any = await kr.json().catch(() => ({}));
    if (typeof kb?.key !== "string" || !kb.key.startsWith("mind_")) throw new TenantError("MIND did not issue a key for that account.", 502);
    return kb.key;
  }
}
