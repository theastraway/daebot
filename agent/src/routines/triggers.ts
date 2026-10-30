// The trigger catalog: every "when something happens" a routine can wait for. Each entry is something Daebot can really detect today
// (a message, a finished reply, a web address being called, a poll of the user's MIND, a desktop event), with the fields it needs.
// Pure data and validation, no I/O except the folder check of file_changed. The runner decides WHEN an event reaches `matchEvent`.
import { existsSync, statSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { TimingError, checkFilter, validTz } from "./clock.ts";
import type { ActiveFilter } from "./clock.ts";

export const TRIGGER_TYPES = [
  "webhook", "thread_message", "bot_message", "keyword", "turn_done",
  "mind_document", "mind_task", "mind_task_due", "mind_contact", "mail_new",
  "app_opened", "wake", "file_changed", "screen_change",
  "gh_issue", "gh_pr", "gh_push", "gh_comment",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export type TriggerGroup = "messages" | "daebot" | "mind" | "desktop" | "web" | "github";
/** What a trigger needs before it can work. `setup.ts` checks each one live; the routine cannot be turned on while one is missing. */
export type Need = "mind" | "mail" | "webhook" | "github" | "screen" | "folder";
export interface FieldDef { key: string; label: string; kind: "text" | "select" | "path"; required?: boolean; placeholder?: string; help?: string; options?: { value: string; label: string }[]; default?: string }
export interface TriggerDef { type: TriggerType; group: TriggerGroup; label: string; description: string; fields: FieldDef[]; desktopOnly?: boolean; /** Needs a public address a service can call: not offered when the gateway runs on the user's own computer. */ hostedOnly?: boolean; poll?: boolean; needs?: Need[] }

export interface Trigger {
  type: TriggerType;
  /** bot_message: only messages from this bot (slug). */
  from?: string;
  /** keyword: the words to look for (one or more, separated by commas). */
  phrase?: string;
  /** keyword: whose messages count. */
  where?: "user" | "bot" | "either";
  /** turn_done: which endings count. */
  on?: "done" | "failed" | "any";
  /** file_changed: the folder to watch. */
  path?: string;
  /** screen_change: how big a change counts. */
  sensitivity?: "low" | "medium" | "high";
  /** Polled triggers: minutes between looks. */
  every?: number;
  /** GitHub triggers: only this repository ("owner/name"), optional. */
  repo?: string;
  /** gh_push: only this branch, optional. */
  branch?: string;
  /** Optional: only react on weekdays / inside active hours (in `tz`). Works for every trigger. */
  filter?: ActiveFilter;
  tz?: string;
}

const POLL_OPTIONS = [{ value: "5", label: "Every 5 minutes" }, { value: "15", label: "Every 15 minutes" }, { value: "30", label: "Every 30 minutes" }, { value: "60", label: "Every hour" }];
export const POLL_MINUTES = [5, 15, 30, 60] as const;
const EVERY: FieldDef = { key: "every", label: "How often Daebot looks", kind: "select", options: POLL_OPTIONS, default: "15" };

const GH_REPO: FieldDef = { key: "repo", label: "Only this repository (optional)", kind: "text", placeholder: "owner/name" };

/** The GitHub receiver (/hooks/gh/<id>) is mounted by the gateway: GitHub triggers are offered on hosted deployments. */
export const GITHUB_LIVE = true;

export const CATALOG: readonly TriggerDef[] = [
  { type: "thread_message", group: "messages", label: "I message the bot", description: "Runs each time you send a message in any of this bot's threads.", fields: [] },
  { type: "keyword", group: "messages", label: "A message contains a word or phrase", description: "Runs when a message you send, or one another bot sends to this bot, contains one of the words you list.", fields: [
    { key: "phrase", label: "Words or phrases (separate with commas)", kind: "text", required: true, placeholder: "invoice, urgent" },
    { key: "where", label: "Look in", kind: "select", default: "either", options: [{ value: "either", label: "My messages and other bots' messages" }, { value: "user", label: "My messages only" }, { value: "bot", label: "Messages from other bots only" }] },
  ] },
  { type: "bot_message", group: "messages", label: "Another bot talks to it", description: "Runs when another of your bots sends this bot a message (bot_talk).", fields: [
    { key: "from", label: "Only from this bot (slug, optional)", kind: "text", placeholder: "researcher" },
  ] },
  { type: "turn_done", group: "daebot", label: "A thread finishes a reply", description: "Runs when the bot finishes answering in one of its threads, so a follow-up routine can review, summarize or hand off the result. Routine threads never trigger it.", fields: [
    { key: "on", label: "Which endings", kind: "select", default: "done", options: [{ value: "done", label: "Finished normally" }, { value: "failed", label: "Failed" }, { value: "any", label: "Either" }] },
  ] },
  { type: "webhook", group: "web", label: "A web address is called (webhook)", description: "Gives this routine its own secret web address. Anything that can send a web request (a form, a script, another app) runs it, and the request body reaches the bot as data.", fields: [], needs: ["webhook"] },
  { type: "mind_document", group: "mind", label: "A new document appears in MIND", description: "Daebot looks at your MIND documents on a schedule and runs once for each new one.", fields: [EVERY], poll: true, needs: ["mind"] },
  { type: "mind_task", group: "mind", label: "A new task is created in MIND", description: "Runs once for each new task in your MIND task list.", fields: [EVERY], poll: true, needs: ["mind"] },
  { type: "mind_task_due", group: "mind", label: "A MIND task comes due", description: "Runs once when an open task reaches its due date (tasks already due when you save are not replayed).", fields: [EVERY], poll: true, needs: ["mind"] },
  { type: "mind_contact", group: "mind", label: "A new contact is added to MIND CRM", description: "Runs once for each new CRM contact.", fields: [EVERY], poll: true, needs: ["mind"] },
  { type: "mail_new", group: "mind", label: "A new email arrives", description: "Runs once for each new unread email in the mailbox you connected to MIND (Gmail or Outlook, set up under Apps). Email text reaches the bot as untrusted data.", fields: [EVERY], poll: true, needs: ["mail"] },
  { type: "app_opened", group: "desktop", label: "Daebot opens on this computer", description: "Runs once each time the Daebot desktop app starts.", fields: [], desktopOnly: true },
  { type: "wake", group: "desktop", label: "This computer wakes up", description: "Runs when the computer comes back from sleep.", fields: [], desktopOnly: true },
  { type: "file_changed", group: "desktop", label: "A file changes in a folder", description: "Watches a folder on this computer and runs when files in it are added or changed (a few seconds after the changes settle).", fields: [
    { key: "path", label: "Folder to watch", kind: "path", required: true, placeholder: "/Users/you/Documents/Inbox" },
  ], desktopOnly: true, needs: ["folder"] },
  { type: "screen_change", group: "desktop", label: "The screen changes", description: "While \"Let Daebot watch my screen\" is on, runs when the picture changes by more than the size you choose (at most once a minute). The bot gets the fact of the change, not a picture.", fields: [
    { key: "sensitivity", label: "How big a change counts", kind: "select", default: "medium", options: [{ value: "low", label: "Large changes only (a page or app switch)" }, { value: "medium", label: "A dialog or a loading bar" }, { value: "high", label: "Small changes too" }] },
  ], desktopOnly: true, needs: ["screen"] },
  { type: "gh_issue", group: "github", label: "A GitHub issue is opened", description: "Runs when someone opens or reopens an issue in a repository. GitHub calls Daebot the moment it happens (no waiting, no polling). You paste one address and a secret into the repository's webhook settings.", fields: [GH_REPO], hostedOnly: true, needs: ["github"] },
  { type: "gh_pr", group: "github", label: "A GitHub pull request is opened", description: "Runs when a pull request is opened, reopened or marked ready for review. GitHub calls Daebot the moment it happens.", fields: [GH_REPO], hostedOnly: true, needs: ["github"] },
  { type: "gh_push", group: "github", label: "Code is pushed to GitHub", description: "Runs on each push to a repository. GitHub calls Daebot the moment it happens.", fields: [GH_REPO, { key: "branch", label: "Only this branch (optional)", kind: "text", placeholder: "main" }], hostedOnly: true, needs: ["github"] },
  { type: "gh_comment", group: "github", label: "Someone comments on GitHub", description: "Runs when a comment is added to an issue, a pull request or a commit. GitHub calls Daebot the moment it happens.", fields: [GH_REPO], hostedOnly: true, needs: ["github"] },
];

export const DEFS: ReadonlyMap<TriggerType, TriggerDef> = new Map(CATALOG.map((d) => [d.type, d]));
export const isPoll = (t: TriggerType | undefined): boolean => !!t && DEFS.get(t)?.poll === true;
export const isDesktopOnly = (t: TriggerType | undefined): boolean => !!t && DEFS.get(t)?.desktopOnly === true;
export const isHostedOnly = (t: TriggerType | undefined): boolean => !!t && DEFS.get(t)?.hostedOnly === true;
export const isGithub = (t: TriggerType | undefined): boolean => t === "gh_issue" || t === "gh_pr" || t === "gh_push" || t === "gh_comment";

/** What this deployment can detect. Hosted servers cannot see a user's computer. */
export interface TriggerCaps { desktop: boolean }
export function catalogFor(caps: TriggerCaps): TriggerDef[] {
  return CATALOG.filter((d) => (caps.desktop || !d.desktopOnly) && (!caps.desktop || !d.hostedOnly) && (GITHUB_LIVE || d.group !== "github"));
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : undefined);

/** Validates a trigger from outside (REST, bot_manage). Throws TimingError with a message fit for the user. */
export function checkTrigger(v: unknown, caps: TriggerCaps): Trigger {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : { type: v };
  const type = o.type;
  if (typeof type !== "string" || !(TRIGGER_TYPES as readonly string[]).includes(type)) throw new TimingError(`trigger must be one of ${catalogFor(caps).map((d) => d.type).join(", ")}`);
  const t = type as TriggerType;
  if (isDesktopOnly(t) && !caps.desktop) throw new TimingError(`"${t}" needs the Daebot desktop app: a hosted server cannot see your computer`);
  if (isGithub(t) && !GITHUB_LIVE) throw new TimingError(`"${t}" is not available yet`);
  if (isHostedOnly(t) && caps.desktop) throw new TimingError(`"${t}" needs a public address GitHub can call, so it works on daebot.live, not in the desktop app`);
  const out: Trigger = { type: t };
  if (t === "bot_message") { const f = str(o.from, 32); if (f) out.from = f.toLowerCase(); }
  if (t === "keyword") {
    const p = str(o.phrase, 200);
    if (!p) throw new TimingError("a keyword trigger needs the words to look for");
    out.phrase = p;
    const w = o.where === undefined || o.where === "" ? "either" : o.where;
    if (w !== "user" && w !== "bot" && w !== "either") throw new TimingError('where must be "user", "bot" or "either"');
    out.where = w;
  }
  if (t === "turn_done") {
    const on = o.on === undefined || o.on === "" ? "done" : o.on;
    if (on !== "done" && on !== "failed" && on !== "any") throw new TimingError('on must be "done", "failed" or "any"');
    out.on = on;
  }
  if (t === "file_changed") {
    const p = str(o.path, 400);
    if (!p) throw new TimingError("a file trigger needs the folder to watch");
    if (!isAbsolute(p)) throw new TimingError("the folder must be a full path, like /Users/you/Documents");
    const n = normalize(p);
    let isDir = false;
    try { isDir = existsSync(n) && statSync(n).isDirectory(); } catch { /* unreadable = not a folder */ }
    if (!isDir) throw new TimingError(`"${n.slice(0, 80)}" is not a folder on this computer`);
    out.path = n;
  }
  if (isGithub(t)) {
    const repo = str(o.repo, 140);
    if (repo) {
      if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw new TimingError('the repository must look like owner/name, for example "octocat/hello"');
      out.repo = repo.toLowerCase();
    }
    if (t === "gh_push") { const b = str(o.branch, 120); if (b) out.branch = b.replace(/^refs\/heads\//, ""); }
  }
  if (t === "screen_change") {
    const s = o.sensitivity === undefined || o.sensitivity === "" ? "medium" : o.sensitivity;
    if (s !== "low" && s !== "medium" && s !== "high") throw new TimingError('sensitivity must be "low", "medium" or "high"');
    out.sensitivity = s;
  }
  if (isPoll(t)) {
    const n = o.every === undefined || o.every === "" ? 15 : Number(o.every);
    if (!(POLL_MINUTES as readonly number[]).includes(n)) throw new TimingError(`every must be one of ${POLL_MINUTES.join(", ")} (minutes)`);
    out.every = n;
  }
  const f = checkFilter(o.filter);
  if (f) {
    out.filter = f;
    const tz = o.tz === undefined || o.tz === null || o.tz === "" ? "America/New_York" : o.tz;
    if (!validTz(tz)) throw new TimingError(`"${String(tz).slice(0, 40)}" is not a time zone name`);
    out.tz = tz;
  }
  return out;
}

/** An event the runner saw. `text` is the data the bot gets (untrusted). */
export interface TriggerEvent { kind: "thread_message" | "bot_message" | "turn_done"; text: string; from?: string; ok?: boolean }

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ");
/** Does a message contain one of the comma-separated words/phrases? */
export function containsPhrase(text: string, phrase: string): boolean {
  const hay = norm(text);
  return phrase.split(",").map((x) => norm(x.trim())).filter(Boolean).some((p) => hay.includes(p));
}

/** Does this trigger want this event? (Poll and desktop triggers are fired by their own sources, never through here.) */
export function matchEvent(t: Trigger, ev: TriggerEvent): boolean {
  switch (t.type) {
    case "thread_message": return ev.kind === "thread_message";
    case "bot_message": return ev.kind === "bot_message" && (!t.from || t.from === (ev.from ?? "").toLowerCase());
    case "keyword": return (ev.kind === "thread_message" ? t.where !== "bot" : ev.kind === "bot_message" ? t.where !== "user" : false) && containsPhrase(ev.text, t.phrase ?? "");
    case "turn_done": return ev.kind === "turn_done" && (t.on === "any" || (t.on === "failed" ? ev.ok === false : ev.ok !== false));
    default: return false;
  }
}

export function describeTrigger(t: Trigger): string {
  const filt = t.filter ? ` (only ${[t.filter.weekdays ? "on weekdays" : "", t.filter.from && t.filter.to ? `between ${t.filter.from} and ${t.filter.to}` : ""].filter(Boolean).join(", ")})` : "";
  const every = t.every ? ` (checked every ${t.every === 60 ? "hour" : `${t.every} minutes`})` : "";
  switch (t.type) {
    case "webhook": return `when its secret URL is called${filt}`;
    case "thread_message": return `when you message the bot in any of its threads${filt}`;
    case "bot_message": return `${t.from ? `when bot ${t.from} talks to it` : "when another bot talks to it (bot_talk)"}${filt}`;
    case "keyword": return `when ${t.where === "user" ? "you write" : t.where === "bot" ? "another bot writes" : "a message has"} ${t.phrase ? `"${t.phrase}"` : "a keyword"}${filt}`;
    case "turn_done": return `when a thread ${t.on === "failed" ? "fails" : t.on === "any" ? "finishes or fails" : "finishes a reply"}${filt}`;
    case "mind_document": return `when a new document appears in MIND${every}${filt}`;
    case "mind_task": return `when a new MIND task is created${every}${filt}`;
    case "mind_task_due": return `when a MIND task comes due${every}${filt}`;
    case "mind_contact": return `when a new contact is added to MIND CRM${every}${filt}`;
    case "mail_new": return `when a new email arrives${every}${filt}`;
    case "app_opened": return `when Daebot opens on this computer${filt}`;
    case "wake": return `when this computer wakes up${filt}`;
    case "file_changed": return `when a file changes in ${t.path ?? "a folder"}${filt}`;
    case "screen_change": return `when the screen changes${filt}`;
    case "gh_issue": return `when a GitHub issue is opened${t.repo ? ` in ${t.repo}` : ""}${filt}`;
    case "gh_pr": return `when a GitHub pull request is opened${t.repo ? ` in ${t.repo}` : ""}${filt}`;
    case "gh_push": return `when code is pushed to GitHub${t.repo ? ` in ${t.repo}` : ""}${t.branch ? ` (branch ${t.branch})` : ""}${filt}`;
    case "gh_comment": return `when someone comments on GitHub${t.repo ? ` in ${t.repo}` : ""}${filt}`;
  }
}
