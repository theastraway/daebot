// MIND App Store connector list (GET <MIND base>/connectors). The endpoint may not exist yet; every failure is an empty list.
// The reply is third-party-shaped data: it is parsed leniently and every string is clipped. Only https URLs survive.
import type { CatalogEntry } from "./service.ts";

export function parseCatalog(body: unknown): CatalogEntry[] {
  const rows: unknown[] = Array.isArray(body) ? body : Array.isArray((body as any)?.connectors) ? (body as any).connectors : Array.isArray((body as any)?.items) ? (body as any).items : [];
  const out: CatalogEntry[] = [];
  for (const r of rows.slice(0, 300)) {
    const o = r as Record<string, unknown> | null;
    const url = [o?.mcp_url, o?.mcpUrl, o?.url, o?.endpoint, o?.server_url].find((x) => typeof x === "string") as string | undefined;
    const name = [o?.name, o?.title, o?.slug].find((x) => typeof x === "string") as string | undefined;
    if (!url || !name) continue;
    try { if (new URL(url).protocol !== "https:") continue; } catch { continue; }
    const pub = String(o?.publisher ?? o?.tier ?? "").toLowerCase();
    out.push({
      name: name.slice(0, 80), url: url.slice(0, 300),
      official: o?.official === true || pub === "official" || pub === "verified",
      description: typeof o?.description === "string" ? o.description.slice(0, 200) : undefined,
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
    const key = o.keyFor(uid);
    if (!key) return [];
    const hit = cache.get(uid);
    if (hit && now() - hit.at < ttl) return hit.rows;
    let rows: CatalogEntry[] = [];
    try {
      const res = await f(`${o.baseUrl.replace(/\/+$/, "")}/connectors`, { headers: { "X-API-Key": key, accept: "application/json" }, signal: AbortSignal.timeout(4000) });
      if (res.ok) rows = parseCatalog(await res.json());
    } catch { /* not there yet, or down: empty */ }
    cache.set(uid, { at: now(), rows });
    return rows;
  };
}
