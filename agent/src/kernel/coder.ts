// Per-user "coder" grant: a staff user (read + local write) who may ALSO run a short list of GitHub write tools, but only against repositories
// that match that user's own globs. Configured by the operator (env DAEBOT_CODERS), never by the user or the model.
//
//   DAEBOT_CODERS='{"andrewcastaldi":{"repos":["theastraway/castaldi-*","theastraway/ysf-*"]}}'
//
// Unset, empty or invalid = nobody is a coder = exactly today's behaviour. Every rule here fails closed.
import type { Tool } from "../types.ts";

export interface CoderGrant { repos: string[] }

const SEG = /^[A-Za-z0-9._-]{1,100}$/;                 // one concrete owner or repo name in a tool call
const GLOB = /^([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._*-]{1,100})$/; // owner is literal, repo may carry * wildcards

/** The GitHub MCP tools a coder may run (writes inside an allowed repo). Anything not listed stays blocked: repository creation, forks, secrets, settings. */
export const CODER_GITHUB_TOOLS: ReadonlySet<string> = new Set([
  "create_branch", "delete_branch", "push_files", "create_or_update_file", "delete_file",
  "create_pull_request", "update_pull_request", "merge_pull_request", "update_pull_request_branch",
  "add_issue_comment", "create_issue", "update_issue", "issue_write", "sub_issue_write",
  "pull_request_review_write", "add_comment_to_pending_review", "add_pull_request_review_comment",
  "create_pull_request_review", "submit_pending_pull_request_review", "request_copilot_review",
]);

/** Only GitHub's own MCP hosts count. A server named "github" on any other host does not. */
export function isGithubHost(host: string | undefined): boolean {
  const h = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  return h === "github.com" || h.endsWith(".github.com") || h === "githubcopilot.com" || h.endsWith(".githubcopilot.com");
}

/** Parses DAEBOT_CODERS. Returns the grants by lowercase username plus one plain line per rejected entry (no values echoed beyond the username). */
export function parseCoders(raw: string | undefined): { coders: Map<string, CoderGrant>; problems: string[] } {
  const coders = new Map<string, CoderGrant>();
  const problems: string[] = [];
  const text = (raw ?? "").trim();
  if (!text) return { coders, problems };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { coders, problems: ["DAEBOT_CODERS is not valid JSON; no coder grants are active"] }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { coders, problems: ["DAEBOT_CODERS must be a JSON object of username to {repos}; no coder grants are active"] };
  for (const [user, v] of Object.entries(parsed as Record<string, unknown>)) {
    const name = user.trim().toLowerCase();
    const repos = v && typeof v === "object" ? (v as { repos?: unknown }).repos : undefined;
    if (!name || !Array.isArray(repos)) { problems.push(`DAEBOT_CODERS: ${name || "(empty name)"} needs a repos list; skipped`); continue; }
    const ok: string[] = [];
    for (const g of repos) {
      const m = typeof g === "string" ? GLOB.exec(g.trim()) : null;
      // Refuse a repo part that is only wildcards: "owner/*" would grant the whole organisation.
      if (!m || /^\*+$/.test(m[2]) || /^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) { problems.push(`DAEBOT_CODERS: ${name}: a repo pattern was refused (need owner/name or owner/prefix-*)`); continue; }
      ok.push(`${m[1].toLowerCase()}/${m[2].toLowerCase()}`);
    }
    if (ok.length) coders.set(name, { repos: ok });
    else problems.push(`DAEBOT_CODERS: ${name} has no usable repo pattern; skipped`);
  }
  return { coders, problems };
}

function globToRegExp(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[A-Za-z0-9._-]*") + "$");
}

/** True when owner/repo (concrete names) matches one of the grant's patterns. Case-insensitive; a name with any odd character never matches. */
export function repoAllowed(grant: CoderGrant | undefined, owner: unknown, repo: unknown): boolean {
  if (!grant || typeof owner !== "string" || typeof repo !== "string" || !SEG.test(owner) || !SEG.test(repo) || /^\.+$/.test(owner) || /^\.+$/.test(repo)) return false;
  const full = `${owner}/${repo}`.toLowerCase();
  return grant.repos.some((g) => globToRegExp(g).test(full));
}

/** The connected-tool facts the grant is decided on. Set by the MCP connector from what the server reported, never from model text. */
function githubBase(tool: Pick<Tool, "mcp">): string | undefined {
  const m = tool.mcp;
  if (!m || !isGithubHost(m.host)) return undefined;
  return CODER_GITHUB_TOOLS.has(m.tool) ? m.tool : undefined;
}

/**
 * Does the coder grant let this tool run? With no args (the tool list) it answers "could it ever run", so the model is offered it;
 * with args it answers for exactly this call: owner and repo must be present, concrete and inside the user's globs.
 */
export function coderAllows(grant: CoderGrant | undefined, tool: Pick<Tool, "mcp">, args?: Record<string, unknown>): boolean {
  if (!grant || !githubBase(tool)) return false;
  if (args === undefined) return true;
  return repoAllowed(grant, args.owner, args.repo);
}

export function coderPrompt(grant: CoderGrant): string[] {
  return [
    "## Coder grant",
    `Operator-granted: you may run GitHub write tools (branch, push files, pull requests, merge, comments) on these repositories only: ${grant.repos.join(", ")}. A call naming any other repository is refused. Everything else that is outward still needs the user's explicit go-ahead.`,
  ];
}
