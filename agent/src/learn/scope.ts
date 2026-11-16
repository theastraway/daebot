// The learning scope of a session: where a lesson was learned and where it is recalled. A bot's threads learn as "bot:<slug>";
// a desktop or CLI session inside a git checkout learns as "workspace:<owner/repo>" (from the origin remote, read once per
// directory, never from message text); everything else as "person:<user>". A lesson that helps in two scopes is promoted and
// recalled everywhere (recall.ts inScope).
import { execFileSync } from "node:child_process";

const cache = new Map<string, string | undefined>();

/** "owner/repo" from a git remote URL (https, ssh, or scp-like), lowercased; undefined when it does not look like one. */
export function repoSlug(remote: string): string | undefined {
  const m = /(?:[:/])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?\s*$/.exec(remote.trim());
  if (!m) return undefined;
  const owner = m[1].toLowerCase(), repo = m[2].toLowerCase();
  if (!owner || !repo || owner === "." || repo === ".") return undefined;
  return `${owner}/${repo}`;
}

/** The workspace scope of a directory, or undefined outside a git checkout with an origin. Cached per directory; a missing git is fine. */
export function workspaceScope(cwd: string, run: (cwd: string) => string = (c) => execFileSync("git", ["-C", c, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] })): string | undefined {
  if (cache.has(cwd)) return cache.get(cwd);
  let out: string | undefined;
  try { const slug = repoSlug(run(cwd)); if (slug) out = `workspace:${slug}`; } catch { out = undefined; }
  cache.set(cwd, out);
  return out;
}

export const botScope = (slug: string): string => `bot:${slug.toLowerCase()}`;
export const personScope = (user: string): string => `person:${user.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || "user"}`;

/** Clears the per-directory cache (tests). */
export function resetScopeCache(): void { cache.clear(); }
