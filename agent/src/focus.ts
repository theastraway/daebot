// Focused context (DAEBOT_FOCUSED_CONTEXT, default ON): inject only what the current message needs.
// Everything here is pure (no I/O) except relevantFromMind, which takes the MIND client it should use.
// Audit that motivated it: 59% of turns in the main working thread carried unrelated content (boot priorities, stale tasks,
// an "agent sessions first" lesson) on greetings like "Hello, how are you?".
import type { MindClient, Tool } from "./types.ts";
import { clip, tokenSet } from "./learn/text.ts";

/** DAEBOT_FOCUSED_CONTEXT: on unless explicitly 0 / off / false / no. */
export function focusedContextOn(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.DAEBOT_FOCUSED_CONTEXT ?? "").trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

export const BOOT_BLOCK_MAX_CHARS = 6_000;
export const RELEVANT_BLOCK_MAX_CHARS = 3_000;
export const RELEVANT_MAX_ITEMS = 3;
export const MAX_MCP_TOOLS = 40;
export const RECENT_ROUNDS = 3;

// ---------------------------------------------------------------- trivial messages (port of Hermes' TRIVIAL_PROMPT_RE idea)
const TRIVIAL_PHRASES = [
  "yes", "yep", "yeah", "yup", "yea", "no", "nope", "nah", "ok", "okay", "k", "kk", "thanks", "thank you", "thx", "ty", "cheers",
  "cool", "nice", "great", "perfect", "awesome", "got it", "sure", "fine", "alright", "right", "hi", "hello", "hey", "yo", "sup", "hiya", "howdy",
  "good morning", "good afternoon", "good evening", "good night", "gm", "gn", "how are you", "how are you doing", "how are you today", "how r u",
  "how's it going", "how is it going", "what's up", "whats up", "continue", "go on", "go ahead", "keep going", "proceed", "do it", "go", "send it",
  "ship it", "sounds good", "lgtm", "looks good", "yes please", "please do", "stop", "status", "ping", "test", "testing", "again", "next", "done", "bye", "goodbye",
  "see you", "later", "welcome", "np", "no problem", "you too", "same", "agreed", "correct", "exactly", "i see", "understood", "makes sense",
  "dae", "daebot", "there", "friend", "buddy", "please", "so much", "a lot", "very much", "and you", "you", "and", "good", "well", "pika", "today", "tonight", "everyone", "all", "doing", "going",
];
const TRIVIAL_RE = new RegExp(`(?<![a-z0-9'])(?:${[...TRIVIAL_PHRASES].sort((a, b) => b.length - a.length).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![a-z0-9])`, "g");

/** A greeting, an acknowledgement or a bare "go": nothing in MIND, no skill and no extra tool can help with it. */
export function isTrivialMessage(message: string): boolean {
  const m = String(message ?? "").toLowerCase().replace(/[’`]/g, "'").trim();
  if (!m) return true;
  if (m.length > 90 || /\[photo /.test(m)) return false;
  const rest = m.replace(TRIVIAL_RE, " ").replace(/[^a-z0-9]+/g, " ").trim();
  return rest === "";
}

/** A turn started by a timer, a heartbeat, a check-in or another agent: never gets per-turn recall or pruning. */
export function isAutomatedMessage(message: string): boolean {
  return /^\s*\[(?:Routine|Heartbeat|Check-in|Check in|Cron|Scheduled|From bot|Bot request)/i.test(String(message ?? ""));
}

// ---------------------------------------------------------------- groups
export type Group =
  | "bot" | "board" | "decision" | "photos" | "sessions" | "astra" | "computer" | "work" | "voice" | "mail" | "connect"
  | "people" | "mind" | "env" | "docs";

export const GROUP_TRIGGERS: Record<Group, RegExp> = {
  bot: /\b(?:bots?|daebots?|workforce|work ?force|teams?|org ?chart|hire[ds]?|hiring|staff(?:ed|ing)?|departments?|agents?|employees?|sales ?reps?|assistants?|routines?|schedul\w*|heartbeats?|cron|persona|personas|dae ?bot\.md|every (?:day|morning|evening|night|hour|week|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:daily|weekly|hourly|monthly|nightly))\b/i,
  board: /\b(?:tasks?|task ?board|board|to-?dos?|checklists?|kanon|projects?|priorit\w+|what'?s next|backlog|punch list|life board|outcome)\b/i,
  decision: /\b(?:decide|decision|decisions|options?|should (?:we|i)|recommend\w*|pros and cons|trade-?offs?|which (?:one|option|should)|choose|ooc|emr|worth it)\b/i,
  photos: /\[photo |\b(?:photos?|pictures?|images?|screenshots?|jpe?g|png|logo|attached|attachment|diagram|illustration)\b/i,
  sessions: /\b(?:sessions?|grok|conversations?|chat history|threads?|mind sync|claude code|agent sessions?|inbox)\b/i,
  astra: /\b(?:astra|portfolio|projects? board|astra board)\b/i,
  computer: /\b(?:open|click\w*|screen|window|windows|safari|chrome|firefox|edge|browser|desktop|mouse|keyboard|screenshots?|launch\w*|finder|terminal|powershell|cmd|command prompt|type into|scroll|app|notepad|installer)\b/i,
  work: /\b(?:search|look ?up|google|find|research|url|https?:\/\/|www\.|website|web ?page|link|fetch|browse|news|weather|price|file|files|folder|script|code|repo|repository|git|github|commit|branch|pr|pull request|test|tests|build|run|install|convert|bash|shell|command|deploy|fix|bug|implement|edit|write|read|download|csv|json|pdf|docx|xlsx)\b/i,
  voice: /\b(?:voice|speak|talk to me|call me|phone|audio|say it)\b/i,
  mail: /\b(?:e-?mails?|mail|inbox|gmail|outlook|calendar|meetings?|events?|appointments?|invites?|contacts?|apple|schedule|availability|free time|reminders?)\b/i,
  connect: /\b(?:connect\w*|connectors?|integrat\w+|mcp|app store|authori[sz]e|sign ?in|re-?sign|install\w*|github|dropbox|n8n|slack|linear|render|vercel|stripe|supabase|cloudflare|notion|jira|asana|google|microsoft|drive|onedrive|sharepoint|apps?)\b/i,
  people: /\b(?:contacts?|persons?|people|who is|crm|leads?|clients?|pipeline|customers?|prospects?|jessica|follow-?ups?)\b/i,
  mind: /\b(?:mind|folders?|documents?|docs?|notes?|profile|tenants?|feed|share|sense|mood|social|remember|memory|memories|knowledge|context|insights?|history|what do you know)\b/i,
  env: /\b(?:render|env(?:ironment)? ?vars?|environment variables?|deploys?|deployment|service)\b/i,
  docs: /\b(?:docs?|documents?|notes?|drafts?|saves?|saved|files?|folders?|dropbox|drive|write|writeup|memo|report)\b/i,
};

/** Tool -> group. A tool in no group is core: always offered. */
const TOOL_GROUP: Record<string, Group> = {
  bot_manage: "bot",
  task_board: "board", mind_life: "board", mind_life_write: "board", mind_tasks: "board", mind_tasks_write: "board", mind_todos: "board", mind_todos_write: "board",
  mind_checklists: "board", mind_checklists_write: "board",
  task_decision: "decision", decide: "decision", mind_decision_record: "decision",
  view_photo: "photos", image_generate: "photos",
  mind_sessions: "sessions", list_sessions: "sessions", read_session: "sessions", post_to_session: "sessions", search_chats: "sessions",
  astra_board: "astra",
  computer: "computer", screen: "computer", app: "computer", terminal: "computer",
  start_voice_agent: "voice",
  mind_mail: "mail", mind_calendar: "mail", mind_contacts: "mail", mind_apps: "mail", apple_calendar: "mail", send_email: "mail",
  mcp_connect: "connect",
  mind_crm: "people", mind_crm_write: "people",
  mind_context: "mind", mind_sense: "mind", mind_profile: "mind", mind_tenants: "mind", mind_folders: "mind", mind_folders_read: "mind", mind_social: "mind", mind_feed_post: "mind", mind_agents: "mind",
  render_env_set: "env",
};

/** Always sent, whatever the message says. */
export const CORE_TOOLS = new Set([
  "mind_query", "mind_remember", "web_search", "web_fetch", "read_file", "write_file", "edit_file", "glob", "grep", "bash", "process", "bot_talk", "bot_self",
]);

export function groupOfTool(name: string): Group | undefined { return TOOL_GROUP[name]; }

export function groupsForMessage(message: string): Set<Group> {
  const out = new Set<Group>();
  const m = String(message ?? "");
  if (!m.trim()) return out;
  for (const g of Object.keys(GROUP_TRIGGERS) as Group[]) if (GROUP_TRIGGERS[g].test(m)) out.add(g);
  // A tool named outright in the message brings its group (and the tool itself, see selectTools).
  for (const [tool, g] of Object.entries(TOOL_GROUP)) if (m.includes(tool)) out.add(g);
  return out;
}

export interface TurnFocus {
  /** Groups whose skill text and tools are in play for this turn. */
  groups: ReadonlySet<Group>;
  /** Names of the tools offered this round. */
  toolNames: ReadonlySet<string>;
  /** Changes whenever the prompt or tool list would change (the loop rebuilds the system prompt on a change). */
  key: string;
}

function mcpServerOf(t: Tool): string | undefined {
  if (t.mcp?.server) return t.mcp.server;
  const m = /^([a-z0-9][a-z0-9-]{0,30})__/.exec(t.spec.name);
  return m?.[1];
}

/**
 * Decide the tool list and the skill groups for one round.
 *  - core tools always; grouped tools when the message matches the group or the model used a tool of the group in the last RECENT_ROUNDS rounds;
 *  - a tool the model is mid-use of is never removed;
 *  - MCP connector tools (<server>__<tool>) only for a server the message names or the model just used, or tools whose name/description match the message; capped at MAX_MCP_TOOLS, ranked by match.
 */
export function computeFocus(all: readonly Tool[], message: string, recentRounds: readonly (readonly string[])[]): TurnFocus {
  const recent = new Set(recentRounds.slice(-RECENT_ROUNDS).flat());
  const groups = groupsForMessage(message);
  for (const n of recent) { const g = groupOfTool(n); if (g) groups.add(g); }
  const lower = String(message ?? "").toLowerCase();
  const q = tokenSet(message);
  const names = new Set<string>();
  const mcp: { t: Tool; score: number }[] = [];
  for (const t of all) {
    const n = t.spec.name;
    const server = mcpServerOf(t);
    if (server) {
      const named = new RegExp(`(?<![a-z0-9])${server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`).test(lower) || lower.includes(n.toLowerCase());
      const used = recent.has(n);
      const d = tokenSet(`${n.replace(/__/g, " ")} ${t.spec.description ?? ""}`);
      let overlap = 0;
      for (const x of q) if (d.has(x)) overlap++;
      if (used || named || overlap >= 3) mcp.push({ t, score: (used ? 1000 : 0) + (named ? 100 : 0) + overlap });
      continue;
    }
    const g = groupOfTool(n);
    if (!g || CORE_TOOLS.has(n) || groups.has(g) || recent.has(n) || lower.includes(n)) names.add(n);
  }
  mcp.sort((a, b) => b.score - a.score);
  for (const { t } of mcp.slice(0, MAX_MCP_TOOLS)) names.add(t.spec.name);
  // MCP use or naming a connected app brings the connector skill text.
  if (mcp.length) groups.add("connect");
  const key = `${[...groups].sort().join(",")}|${names.size}|${[...names].filter((n) => n.includes("__")).length}`;
  return { groups, toolNames: names, key };
}

// ---------------------------------------------------------------- per-turn "Relevant from MIND" block
export const RELEVANT_LABEL = "Relevant from MIND for this message (use only if it applies; ignore it if it does not)";

const GENERIC_ANSWER = /(?:i (?:don'?t|do not|could ?n'?t|cannot|can'?t) (?:have|find)|no (?:relevant|matching|related|results?|information|data)|not found|nothing (?:relevant|found)|no (?:documents?|entries|records) (?:found|match)|unable to (?:find|locate)|does not (?:contain|include) (?:any )?information|insufficient information)/i;

/** Splits retrieved text into candidate items (paragraph / chunk separators). */
function chunksOf(text: string): string[] {
  return String(text ?? "")
    .split(/\n\s*\n+|\n-{3,}\n|\n(?=#{1,3} )|\n(?=\[\d+\])/)
    .map((c) => c.trim())
    .filter((c) => c.length > 20);
}

/**
 * The block of MIND text that really bears on this message, or undefined. A truthy answer is not a relevant one:
 * empty and generic ("I don't have information") answers inject nothing, and each item must share at least two meaningful
 * terms with the message. At most 3 items, 3,000 chars.
 */
export function selectRelevant(message: string, text: string): string | undefined {
  const q = tokenSet(message);
  if (q.size < 2) return undefined;
  const scored: { c: string; n: number }[] = [];
  for (const c of chunksOf(text)) {
    if (GENERIC_ANSWER.test(c) && c.length < 400) continue;
    const d = tokenSet(c);
    let n = 0;
    for (const x of q) if (d.has(x)) n++;
    if (n >= 2) scored.push({ c, n });
  }
  if (!scored.length) return undefined;
  scored.sort((a, b) => b.n - a.n);
  const lines: string[] = [];
  let used = RELEVANT_LABEL.length + 4;
  for (const { c } of scored.slice(0, RELEVANT_MAX_ITEMS)) {
    const line = "- " + clip(c.replace(/\s+/g, " "), 900);
    if (used + line.length + 1 > RELEVANT_BLOCK_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length ? `${RELEVANT_LABEL}:\n${lines.join("\n")}` : undefined;
}

/** One mind_query for this message (retrieve only), filtered by selectRelevant. Fails open to undefined; bounded by timeoutMs. */
export async function relevantFromMind(client: MindClient, message: string, timeoutMs = 3_000): Promise<string | undefined> {
  if (isTrivialMessage(message) || isAutomatedMessage(message) || tokenSet(message).size < 2) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      client.query(clip(String(message).replace(/\s+/g, " ").trim(), 400), { mode: "hybrid", maxContextTokens: 1500 }),
      new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), timeoutMs); }),
    ]);
    return text ? selectRelevant(message, text) : undefined;
  } catch { return undefined; }
  finally { if (timer) clearTimeout(timer); }
}

// ---------------------------------------------------------------- boot cap
/** Caps the always-on boot block (soul + rules) to a digest: each section gets a share, so a long rulebook cannot crowd out the soul. */
export function capBoot(context: string, max = BOOT_BLOCK_MAX_CHARS): { text: string; chars: number; truncated: boolean } {
  const chars = context.length;
  if (chars <= max) return { text: context, chars, truncated: false };
  const secs = context.split(/\n\n(?=## )/);
  const share = secs.length > 1 ? Math.floor((max - 120) / secs.length) : max - 120;
  const cutOne = (t: string, n: number) => {
    if (t.length <= n) return t;
    const c = t.slice(0, n);
    const at = Math.max(c.lastIndexOf("\n"), Math.floor(n * 0.8));
    return `${c.slice(0, at).trimEnd()}\n[...digest: ${t.length - at} more chars; mind_query for the rest]`;
  };
  // Short sections keep their room; the long ones split what is left.
  const short = secs.filter((t) => t.length <= share).reduce((n, t) => n + t.length, 0);
  const longN = secs.filter((t) => t.length > share).length || 1;
  const longShare = Math.floor((max - 120 - short) / longN);
  const text = secs.map((t) => cutOne(t, t.length <= share ? t.length : longShare)).join("\n\n");
  return { text, chars, truncated: true };
}
