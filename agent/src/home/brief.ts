// The opening brief: what a new chat (and a voice call) opens with. Not a fixed line: the user's name, one or two sentences of what
// actually needs them right now, and three starters drawn from that, the way an agent app (Claude Duet, Meta Muse) opens with your
// situation instead of a blank box.
//
// Inputs come from the user's MIND (identity and priorities from mind_context, to-dos in progress, unread email when connected), each
// with its own short timeout; any of them may be missing. A fast model writes the brief as JSON from ONLY those facts. When the model is
// slow or fails, a deterministic brief is built from the to-dos. Never throws.
import type { Message, Provider, StreamEvent, Usage } from "../types.ts";
import { plainSpeech } from "../voice/speech.ts";

export interface BriefStarter { label: string; prompt: string }
export interface OpeningBrief {
  /** First name for the greeting ("Anthony"), or "" when unknown. The greeting itself ("Good evening") is the client's: it knows the local time. */
  name: string;
  /** One or two plain sentences: what needs the user now. "" when there is nothing real to say. */
  line: string;
  starters: BriefStarter[];
  /** "model" = written by the brief writer; "facts" = the deterministic fallback; "empty" = no MIND facts at all. */
  source: "model" | "facts" | "empty";
  at: number;
}

export interface BriefTodo { title: string; status: string; priority?: string; due?: string | null; waiting?: boolean; project?: string }
export interface BriefMail { from: string; subject: string }
export interface BriefInputs {
  /** mind_context text (user, priorities, recent), trimmed. */
  context: string;
  todos: BriefTodo[];
  mail: BriefMail[];
  /** For a bot's chat: who it is. Absent = the main Daebot. */
  bot?: { name: string; purpose: string };
  /** The user's local date and weekday as the client sent it (e.g. "Friday, November 27, 2026"), for "due today" reasoning. */
  today: string;
}

const MAX_CONTEXT = 6_000;
const MAX_LINE = 240;
const MAX_LABEL = 48;
const MAX_PROMPT = 300;
export const BRIEF_TIMEOUT_MS = 8_000;

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** The to-dos worth opening with: waiting on the user, overdue or due soon, then urgent/high. At most 8. */
export function pickTodos(todos: BriefTodo[], todayIso: string): BriefTodo[] {
  const soon = (d?: string | null) => (d ? d.slice(0, 10) <= addDays(todayIso, 2) : false);
  const score = (t: BriefTodo) => (t.waiting ? 0 : 10) + (soon(t.due) ? 0 : 5) + (PRIORITY_RANK[t.priority ?? "medium"] ?? 2);
  return todos.filter((t) => t.title && t.status !== "done" && t.status !== "completed").sort((a, b) => score(a) - score(b)).slice(0, 8);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "9999-12-31";
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** First name from the identity text MIND returns ("Full name: Anthony Conti", "# ... Identity — Anthony Conti"). "" when not found. */
export function nameFromContext(ctx: string): string {
  const m = /full name:\**\s*\**\s*([A-Z][a-zA-Z'’-]{1,30})/i.exec(ctx) ?? /[Ii]dentity\s*[—–-]\s*([A-Z][a-zA-Z'’-]{1,30})\s+[A-Z]/.exec(ctx) ?? /^\s*name:\s*([A-Z][a-zA-Z'’-]{1,30})/im.exec(ctx);
  return m ? m[1] : "";
}

const short = (s: string, n: number) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t; };
/** A to-do title made speakable and short: "Daebot: picking Bypass permissions takes up to 30 seconds…" -> "picking Bypass permissions takes up to 30 seconds". */
const gist = (title: string, n = 60) => short(title.replace(/^[A-Z][\w &.-]{1,24}:\s+/, ""), n);

/** The deterministic brief: from the to-dos alone. */
export function factsBrief(inp: BriefInputs, now = Date.now()): OpeningBrief {
  const name = nameFromContext(inp.context);
  if (inp.bot) {
    return { name, line: inp.bot.purpose ? short(`${inp.bot.name} here: ${inp.bot.purpose.replace(/[.\s]+$/, "")}.`, MAX_LINE) : "", starters: [
      { label: "What can you do?", prompt: `What can you do for me, ${inp.bot.name}? Keep it short.` },
      { label: "What's my next step?", prompt: "Based on what you know about my work, what should I do next?" },
    ], source: inp.context || inp.todos.length ? "facts" : "empty", at: now };
  }
  const top = pickTodos(inp.todos, todayIso(inp.today, now));
  const waiting = top.filter((t) => t.waiting).length;
  const urgent = top.filter((t) => t.priority === "urgent" || t.priority === "high").length;
  let line = "";
  if (top.length) {
    const lead = waiting ? `${waiting} to-do${waiting === 1 ? " is" : "s are"} waiting on you` : urgent ? `${urgent} high-priority to-do${urgent === 1 ? "" : "s"} in progress` : `${top.length} to-do${top.length === 1 ? "" : "s"} in progress`;
    line = `${lead}. Top of the list: ${gist(top[0].title, 90)}.`;
  } else if (inp.mail.length) {
    line = `${inp.mail.length} unread email${inp.mail.length === 1 ? "" : "s"}, the latest from ${short(inp.mail[0].from, 40)}.`;
  }
  const starters: BriefStarter[] = top.slice(0, 2).map((t) => ({ label: short(`Work on: ${gist(t.title, 32)}`, MAX_LABEL), prompt: short(`Let's work on this to-do: "${t.title}". Where does it stand and what's the next step?`, MAX_PROMPT) }));
  if (inp.mail.length) starters.push({ label: "Catch me up on email", prompt: "Catch me up on my unread email: what needs a reply?" });
  if (starters.length < 3) starters.push({ label: "Plan my day", prompt: "Look at my to-dos, calendar and priorities and plan my day: the three things that matter most." });
  if (starters.length < 3) starters.push({ label: "What's new?", prompt: "What changed since we last talked? Check MIND for anything that needs me." });
  return { name, line: short(line, MAX_LINE), starters: starters.slice(0, 3), source: line || inp.context ? "facts" : "empty", at: now };
}

function todayIso(today: string, now: number): string {
  const d = new Date(today);
  return Number.isNaN(d.getTime()) ? new Date(now).toISOString().slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export const BRIEF_SYSTEM = [
  "You write the opening of a new chat with the user's own AI agent. It is the first thing they see, like a sharp chief of staff glancing up as they walk in.",
  "Use ONLY the facts given (their MIND context, to-dos, unread email). Never invent a task, person, date, number or event. If there is nothing real that needs them, say so briefly or leave line empty.",
  "Return ONLY a JSON object, no prose, no code fence: {\"name\": string, \"line\": string, \"starters\": [{\"label\": string, \"prompt\": string}, ...]}",
  "- name: the user's first name from their identity, or \"\".",
  "- line: one or two short plain sentences, max 220 characters, no markdown, no greeting (the app adds \"Good evening, <name>\"). Lead with what needs them most right now: something waiting on them, overdue or due today, or urgent. Name the actual thing in plain words. Mention a second thing only if it matters.",
  "- starters: exactly three. label: 2 to 6 words, an action the user would tap (\"Reply to Andrew\", \"Finish the Ilyven tiers\"). prompt: the full message the user is sending to their agent when they tap it, first person, specific (names, dates, the to-do's title), max 300 characters.",
  "- The starters must come from the facts, most important first. If the facts are thin, make the third one \"Plan my day\".",
  "- For a bot's chat, write as that bot: line says what it can do for them right now given its purpose and the facts; starters fit its purpose.",
].join("\n");

export function briefMessages(inp: BriefInputs): Message[] {
  const todos = inp.todos.map((t) => `- [${t.status}${t.priority ? `, ${t.priority}` : ""}${t.due ? `, due ${t.due.slice(0, 10)}` : ""}${t.waiting ? ", WAITING ON THE USER" : ""}] ${t.title}${t.project ? ` (project: ${t.project})` : ""}`).join("\n");
  const mail = inp.mail.map((m) => `- from ${m.from}: ${m.subject}`).join("\n");
  const parts = [
    `Today is ${inp.today}.`,
    inp.bot ? `This is the chat of the bot ${inp.bot.name}. Its purpose: ${inp.bot.purpose || "(none given)"}.` : "This is the user's main agent.",
    `MIND context (identity, priorities, recent activity):\n${inp.context.slice(0, MAX_CONTEXT) || "(none)"}`,
    `To-dos (most relevant first):\n${todos || "(none)"}`,
    `Unread email:\n${mail || "(none or not connected)"}`,
  ];
  return [{ role: "system", content: BRIEF_SYSTEM }, { role: "user", content: parts.join("\n\n") }];
}

/** Parse and clean the writer's JSON. undefined when it is not usable. */
export function parseBrief(raw: string, now = Date.now()): OpeningBrief | undefined {
  const s = String(raw || "").replace(/<think>[\s\S]*?(<\/think>|$)/gi, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return undefined;
  let j: any;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch { return undefined; }
  if (!j || typeof j !== "object") return undefined;
  const name = typeof j.name === "string" && /^[A-Za-z'’-]{1,30}$/.test(j.name.trim()) ? j.name.trim() : "";
  const line = typeof j.line === "string" ? short(plainSpeech(j.line, MAX_LINE + 40), MAX_LINE) : "";
  const starters: BriefStarter[] = [];
  for (const st of Array.isArray(j.starters) ? j.starters : []) {
    const label = typeof st?.label === "string" ? short(st.label.replace(/[*_`#]/g, ""), MAX_LABEL) : "";
    const prompt = typeof st?.prompt === "string" ? short(st.prompt, MAX_PROMPT) : "";
    if (label && prompt) starters.push({ label, prompt });
    if (starters.length === 3) break;
  }
  if (!starters.length && !line) return undefined;
  return { name, line, starters, source: "model", at: now };
}

/** The writer. undefined when the model failed, timed out or returned nothing usable (the caller uses factsBrief). */
export async function writeBrief(o: { provider: Provider; model: string; inputs: BriefInputs; signal?: AbortSignal; timeoutMs?: number }): Promise<{ brief: OpeningBrief; usage?: Usage } | undefined> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (o.signal) { if (o.signal.aborted) ac.abort(); else o.signal.addEventListener("abort", onAbort, { once: true }); }
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? BRIEF_TIMEOUT_MS);
  timer.unref?.();
  try {
    let text = ""; let usage: Usage | undefined;
    for await (const ev of o.provider.stream({ model: o.model, messages: briefMessages(o.inputs), tools: [], signal: ac.signal, noReasoning: true }) as AsyncIterable<StreamEvent>) {
      if (ev.type === "text") text += ev.delta; else if (ev.type === "done") usage = ev.usage;
    }
    const brief = parseBrief(text);
    if (!brief) return undefined;
    if (!brief.name) brief.name = nameFromContext(o.inputs.context);
    return { brief, usage };
  } catch { return undefined; } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

/** Raw MIND to-dos (GET /todos JSON) -> BriefTodo[]. */
export function todosFromMind(raw: unknown): BriefTodo[] {
  let j: any = raw;
  if (typeof raw === "string") { try { j = JSON.parse(raw); } catch { return []; } }
  const list = Array.isArray(j) ? j : Array.isArray(j?.todos) ? j.todos : [];
  return list.slice(0, 60).map((t: any) => ({
    title: String(t?.title ?? "").slice(0, 200), status: String(t?.status ?? ""), priority: typeof t?.priority === "string" ? t.priority : undefined,
    due: typeof t?.due_date === "string" ? t.due_date : null, waiting: t?.waiting_on_reply === true, project: typeof t?.project_title === "string" ? t.project_title.slice(0, 80) : undefined,
  })).filter((t: BriefTodo) => t.title);
}

/** Raw MIND inbox JSON -> BriefMail[] (unread first, at most 5). */
export function mailFromMind(raw: unknown): BriefMail[] {
  let j: any = raw;
  if (typeof raw === "string") { try { j = JSON.parse(raw); } catch { return []; } }
  const list = Array.isArray(j) ? j : Array.isArray(j?.messages) ? j.messages : Array.isArray(j?.emails) ? j.emails : Array.isArray(j?.items) ? j.items : [];
  return list.slice(0, 5).map((m: any) => ({ from: short(String(m?.from_name ?? m?.from ?? m?.sender ?? ""), 60), subject: short(String(m?.subject ?? ""), 120) })).filter((m: BriefMail) => m.subject);
}

/** The brief as the first thing a voice call says: "Hey Anthony. <line> Want to start there?" undefined when there is no line. */
export function spokenOpener(b: Pick<OpeningBrief, "name" | "line">): string | undefined {
  const line = plainSpeech(b.line || "", 260);
  if (!line) return undefined;
  return `Hey${b.name ? ` ${b.name}` : ""}. ${line}${/[?]$/.test(line) ? "" : " Want to start there?"}`;
}

/** The "## Right now" system-prompt block: what MIND says needs the user, so a spoken or day question is answered without a search. */
export function agendaFacts(inp: BriefInputs, at: number): string {
  const top = pickTodos(inp.todos, new Date(at).toISOString().slice(0, 10));
  if (!top.length && !inp.mail.length) return "";
  const when = new Date(at).toISOString().slice(11, 16);
  const lines = [`## Right now (read from the user's MIND at ${when} UTC)`];
  if (top.length) {
    lines.push(`To-dos in progress, most pressing first (${inp.todos.length} open in all):`);
    for (const t of top) lines.push(`- ${t.title}${t.priority ? ` [${t.priority}]` : ""}${t.due ? ` due ${t.due.slice(0, 10)}` : ""}${t.waiting ? " WAITING ON THEM" : ""}${t.project ? ` (${t.project})` : ""}`);
  }
  if (inp.mail.length) { lines.push("Unread email:"); for (const m of inp.mail) lines.push(`- ${m.from}: ${m.subject}`); }
  lines.push("For questions about their day, plate, to-dos, email or what needs them, answer from this list straight away. Call mind_todos, mind_calendar or mind_mail only for more detail or to change something. Never say you cannot see their to-dos.");
  return lines.join("\n");
}
