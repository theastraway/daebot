// MIND App Store connector list (GET <MIND base>/connectors). The endpoint may not exist yet; every failure is an empty list.
// The reply is third-party-shaped data: it is parsed leniently and every string is clipped. Only https URLs survive.
import type { CatalogAuth, CatalogEntry } from "./service.ts";

function authOf(v: unknown): CatalogAuth {
  const a = String(v ?? "").toLowerCase();
  if (a === "none" || a === "no_auth") return "none";
  const oauth = a.includes("oauth"), key = a.includes("key") || a.includes("token") || a.includes("bearer");
  return oauth && key ? "oauth_or_key" : oauth ? "oauth" : key ? "key" : "unknown";
}

export function parseCatalog(body: unknown): CatalogEntry[] {
  const rows: unknown[] = Array.isArray(body) ? body : Array.isArray((body as any)?.connectors) ? (body as any).connectors : Array.isArray((body as any)?.items) ? (body as any).items : [];
  const out: CatalogEntry[] = [];
  for (const r of rows.slice(0, 300)) {
    const o = r as Record<string, unknown> | null;
    const conn = (o?.connect && typeof o.connect === "object" ? o.connect : {}) as Record<string, unknown>;
    if (typeof o?.kind === "string" && o.kind !== "remote_mcp") continue; // MIND's own integrations are not MCP servers
    const url = [conn.mcp_url, o?.mcp_url, o?.mcpUrl, o?.url, o?.endpoint, o?.server_url].find((x) => typeof x === "string") as string | undefined;
    const name = [o?.name, o?.title, o?.slug].find((x) => typeof x === "string") as string | undefined;
    if (!url || !name) continue;
    try { if (new URL(url).protocol !== "https:") continue; } catch { continue; }
    // MIND's `tier` is the only thing that makes an entry official. A flag inside a community entry's own fields is ignored.
    const pub = String(o?.tier ?? o?.publisher ?? "").toLowerCase();
    const official = typeof o?.tier === "string" ? pub === "official" : o?.official === true || pub === "official" || pub === "verified";
    out.push({
      name: name.slice(0, 80), url: url.slice(0, 300), official,
      description: typeof o?.description === "string" ? o.description.slice(0, 200) : undefined,
      id: typeof o?.id === "string" ? o.id.slice(0, 60) : undefined,
      category: typeof o?.category === "string" ? o.category.slice(0, 30) : undefined,
      auth: authOf(conn.auth),
    });
  }
  return out;
}

export function createMindCatalog(o: { baseUrl: string; keyFor: (uid: string) => string | undefined; fetchImpl?: typeof fetch; ttlMs?: number; now?: () => number }): (uid: string) => Promise<CatalogEntry[]> {
  const f = o.fetchImpl ?? fetch;
  const ttl = o.ttlMs ?? 10 * 60_000;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; rows: CatalogEntry[] }>();
  return async (uid) => {
    const key = o.keyFor(uid); // the list is public; a key only makes MIND show this user's own submissions too
    const hit = cache.get(uid);
    if (hit && now() - hit.at < ttl) return hit.rows;
    let rows: CatalogEntry[] = [];
    try {
      const get = (k?: string) => f(`${o.baseUrl.replace(/\/+$/, "")}/connectors`, { headers: { ...(k ? { "X-API-Key": k } : {}), accept: "application/json" }, signal: AbortSignal.timeout(4000) });
      let res = await get(key);
      if ((res.status === 401 || res.status === 403) && key) res = await get(); // a sign-in token MIND will not take as a key: the public list still works
      if (res.ok) rows = parseCatalog(await res.json());
    } catch { /* not there yet, or down: empty */ }
    cache.set(uid, { at: rows.length ? now() : now() - ttl + 30_000, rows }); // an empty answer (MIND down) is retried after 30 seconds, not 10 minutes
    return rows;
  };
}
