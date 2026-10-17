// The model catalog behind GET /models. MIND already serves the user's available LLM list (GET /developer/v1/profile/models,
// the same list its own picker uses), so Daebot proxies that. When MIND cannot be reached the catalog falls back to the
// models this deployment is configured with, plus the free model. Free plan: only free models are allowed.
import { createHash } from "node:crypto";
import type { Config } from "./types.ts";

export interface ModelRow { id: string; name: string; free: boolean; allowed: boolean }
export interface Catalog { models: ModelRow[]; source: "mind" | "config" }

const TTL_MS = 5 * 60_000;
const MAX_ROWS = 300;

export const isFreeModelId = (id: string): boolean => id.endsWith(":free") || id === "openrouter/free";

export function createModelCatalog(o: { cfg: Config; fetchImpl?: typeof fetch; now?: () => number }) {
  const cache = new Map<string, { at: number; rows: { id: string; name: string; free: boolean }[]; source: "mind" | "config" }>();
  const now = o.now ?? Date.now;
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  function configRows(): { id: string; name: string; free: boolean }[] {
    const ids = [...new Set([o.cfg.models.default, o.cfg.models.cheap, ...o.cfg.models.fallback, ...(o.cfg.freeModel ? [o.cfg.freeModel] : [])].filter(Boolean))];
    return ids.map((id) => ({ id, name: id, free: isFreeModelId(id) || id === o.cfg.freeModel }));
  }

  async function fromMind(key: string): Promise<{ id: string; name: string; free: boolean }[] | undefined> {
    try {
      const res = await f(`${o.cfg.mindBaseUrl.replace(/\/+$/, "")}/profile/models`, { headers: { "X-API-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return undefined;
      const j: any = await res.json();
      const list: any[] = Array.isArray(j?.models) ? j.models : [];
      const rows = list
        .filter((m) => m && typeof m.id === "string" && m.id)
        .slice(0, MAX_ROWS)
        .map((m) => ({ id: String(m.id), name: String(m.name ?? m.id).slice(0, 120), free: isFreeModelId(String(m.id)) || String(m.tier ?? "").toLowerCase() === "free" }));
      return rows.length ? rows : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    /** key: the MIND key the user is billed through (never returned to a client). freePlan: only free models are allowed. */
    async list(key: string | undefined, freePlan: boolean): Promise<Catalog> {
      const k = createHash("sha256").update(key ?? "").digest("hex").slice(0, 24);
      let hit = cache.get(k);
      if (!hit || now() - hit.at > TTL_MS) {
        const mind = key ? await fromMind(key) : undefined;
        hit = { at: now(), rows: mind ?? configRows(), source: mind ? "mind" : "config" };
        if (cache.size > 500) cache.clear();
        cache.set(k, hit);
      }
      return { source: hit.source, models: hit.rows.map((r) => ({ ...r, allowed: !freePlan || r.free })) };
    },
  };
}
