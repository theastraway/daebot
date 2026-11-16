// The small default connector set: what Daebot suggests first when a user asks what they can connect, and what the catalog lists
// first. A short list on purpose (the App Store has dozens): the ones most people ask for in the first week. The operator can change
// it with DAEBOT_FEATURED_CONNECTORS (comma list of provider ids / names); the full catalog is always one query away.
export const DEFAULT_FEATURED: readonly string[] = ["github", "google", "dropbox", "slack", "n8n", "notion"];

export function featuredConnectors(env: Record<string, string | undefined> = process.env): string[] {
  const raw = (env.DAEBOT_FEATURED_CONNECTORS ?? "").trim();
  const list = raw ? raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(s)) : [...DEFAULT_FEATURED];
  return [...new Set(list)].slice(0, 12);
}

/** Featured entries first (in the featured order), then the rest in their given order. Matches on id, then on a lowercased name. */
export function orderFeatured<T extends { id?: string; name: string }>(entries: readonly T[], featured: readonly string[] = featuredConnectors()): T[] {
  const rank = (e: T): number => {
    const id = (e.id ?? "").toLowerCase(), name = e.name.toLowerCase();
    const i = featured.findIndex((f) => f === id || name === f || name.startsWith(f + " "));
    return i < 0 ? featured.length : i;
  };
  return [...entries].map((e, i) => ({ e, i, r: rank(e) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.e);
}
