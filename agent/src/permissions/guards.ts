// User-authored guard rules: a few lines of markdown the OWNER writes in Settings, turned into permission rules that sit beside the
// ones learned from the cards. Trust boundary: the text comes only from the authenticated settings route (or DAEBOT_GUARDS_FILE on a
// self-host), never from the model, a tool result or a document; a line that does not parse is reported and ignored, never guessed.
//
//   - never bash: rm -rf                 deny: a command that starts with these words, anywhere in a chain
//   - never write_file: ~/.ssh/**        deny: a path matching the glob (edit_file too)
//   - never web_fetch: *.facebook.com    deny: a host under that domain
//   - never send_email: @competitor.com  deny: any recipient at that domain
//   - never bot_manage                   deny: the whole tool
//   - always bash: npm test              allow: a simple command that starts with these words (no chain)
//   - always read_file: ~/notes/**       allow: reads under that glob
// Allows obey the same limits as the cards (allowKindsFor): an outward tool can never be allowed wholesale here.
import { validateRule } from "./rules.ts";
import type { Matcher, PermissionRule } from "./rules.ts";

export interface GuardParse { rules: PermissionRule[]; problems: string[] }

const LINE = /^\s*(?:[-*]\s+)?(never|always|deny|allow)\s+([A-Za-z0-9_:.-]{1,128})\s*(?::\s*(.+?))?\s*$/i;
const TOOL_RE = /^(group:fs-read|connector:[A-Za-z0-9_-]{1,64}|[A-Za-z0-9_:.-]{1,128})$/;
const PATH_TOOLS = new Set(["read_file", "write_file", "edit_file", "glob", "grep"]);
const COMMAND_TOOLS = new Set(["bash", "process", "terminal"]);
const HOST_TOOLS = new Set(["web_fetch", "web_search"]);
const MAIL_TOOLS = new Set(["send_email", "mind_mail"]);

function matcherFor(tool: string, value: string | undefined): Matcher | undefined {
  const v = (value ?? "").trim();
  if (!v) return { kind: "any" };
  if (COMMAND_TOOLS.has(tool)) return { kind: "prefix", value: v };
  if (PATH_TOOLS.has(tool) || tool === "group:fs-read") return { kind: "glob", value: v.replace(/^~(?=\/|$)/, "**") };
  if (HOST_TOOLS.has(tool)) return { kind: "domain", value: v.replace(/^\*\./, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "") };
  if (MAIL_TOOLS.has(tool)) return v.startsWith("@") ? { kind: "domain", value: v.slice(1) } : v.includes("@") ? { kind: "recipient", value: v } : { kind: "domain", value: v };
  return { kind: "exact", value: v };
}

/** Parses the guard text. Every usable line becomes a rule with a stable id (guard:<line>), so a re-parse after an edit replaces cleanly. */
export function parseGuards(text: string | undefined, now = Date.now()): GuardParse {
  const rules: PermissionRule[] = [];
  const problems: string[] = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length && i < 200; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw) || /^\s*<!--/.test(raw)) continue;
    const m = LINE.exec(raw);
    if (!m) { problems.push(`line ${i + 1}: expected "- never <tool>: <what>" or "- always <tool>: <what>"`); continue; }
    const effect = /^(never|deny)$/i.test(m[1]) ? "deny" : "allow";
    const tool = m[2].trim();
    if (!TOOL_RE.test(tool)) { problems.push(`line ${i + 1}: bad tool name`); continue; }
    const matcher = matcherFor(tool, m[3]);
    if (!matcher) { problems.push(`line ${i + 1}: could not read the scope`); continue; }
    if (effect === "allow" && matcher.kind === "any") { problems.push(`line ${i + 1}: "always ${tool}" is too broad; name a command, a path or a domain`); continue; }
    try {
      const v = validateRule({ effect, tool, matcher });
      const scope = `${effect === "deny" ? "never" : "always"} ${tool}${m[3] ? `: ${m[3].trim()}` : ""}`.slice(0, 140);
      rules.push({ id: `guard:${i + 1}`, effect: v.effect, tool: v.tool, matcher: v.matcher, scope, createdAt: now, uses: 0 });
    } catch (e) {
      problems.push(`line ${i + 1}: ${String((e as Error)?.message ?? e)}`);
    }
  }
  return { rules, problems };
}

export const MAX_GUARDS_BYTES = 8 * 1024;
