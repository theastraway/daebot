// Suggested replies: after an assistant turn that waits on the user (a question, a proposal, a draft for approval), Dae drafts
// 1-3 replies in the user's own voice. Tapping one only fills the composer (the user edits and sends); nothing is ever auto-sent.
// What the user did with them (took one as is, edited it, ignored it) is stored per user and fed back as few-shot examples.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryEvent, Message, Provider, StreamEvent, Usage } from "../types.ts";

export interface SuggestionFeedback {
  /** The chips that were on screen. */
  shown: string[];
  /** The chip the user tapped, if any. */
  picked?: string;
  /** What the user finally sent. */
  sent?: string;
  action: "chosen" | "edited" | "ignored";
}

export interface SuggestionRecord { at: number; ask: string; shown: string[]; picked?: string; sent?: string; action: "chosen" | "edited" | "ignored" }

const MAX_RECORDS = 300;
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

function seg(s: string): string {
  const v = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return v === "" || v === "." || v === ".." ? "_" : v;
}

/** Per-user feedback log: DATA_DIR/suggestions/<ownerId>.json next to the session and permission data. */
export class SuggestionStore {
  private file: string;
  private root: string;
  private cache: SuggestionRecord[] | undefined;
  private stamp = "";

  constructor(dir: string, owner: string) {
    this.root = join(dir, "suggestions");
    this.file = join(this.root, `${seg(owner)}.json`);
  }

  private load(): SuggestionRecord[] {
    let stamp = "none";
    try { const st = statSync(this.file); stamp = `${st.mtimeMs}:${st.size}`; } catch { /* none yet */ }
    if (this.cache && stamp === this.stamp) return this.cache;
    let recs: SuggestionRecord[] = [];
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8"));
      if (j && Array.isArray(j.records)) recs = j.records.filter((r: SuggestionRecord) => r && typeof r.ask === "string" && Array.isArray(r.shown) && (r.action === "chosen" || r.action === "edited" || r.action === "ignored"));
    } catch { /* missing or torn: start empty */ }
    this.cache = recs;
    this.stamp = stamp;
    return recs;
  }

  /** Clips and cleans everything: the body comes from a browser, so nothing in it is trusted for size or shape. */
  record(fb: SuggestionFeedback, ask: string, now = Date.now()): SuggestionRecord | undefined {
    if (fb.action !== "chosen" && fb.action !== "edited" && fb.action !== "ignored") return undefined;
    const shown = (Array.isArray(fb.shown) ? fb.shown : []).filter((x) => typeof x === "string").slice(0, 3).map((x) => clip(flat(x), 300));
    if (!shown.length) return undefined;
    const picked = typeof fb.picked === "string" && fb.picked.trim() ? clip(flat(fb.picked), 600) : undefined;
    const sent = typeof fb.sent === "string" && fb.sent.trim() ? clip(flat(fb.sent), 1200) : undefined;
    if (fb.action !== "ignored" && !picked) return undefined;
    const rec: SuggestionRecord = { at: now, ask: clip(flat(ask), 500), shown, ...(picked ? { picked } : {}), ...(sent ? { sent } : {}), action: fb.action };
    const recs = [...this.load(), rec].slice(-MAX_RECORDS);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, records: recs }), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.cache = recs;
    try { const st = statSync(this.file); this.stamp = `${st.mtimeMs}:${st.size}`; } catch { this.stamp = ""; }
    return rec;
  }

  all(): SuggestionRecord[] { return this.load().slice(); }

  /** Few-shot: recent replies the user took (as sent) plus a few things they typed themselves instead of taking a chip. */
  examples(accepted = 5, own = 3): { ask: string; reply: string; how: "took" | "edited" | "wrote their own" }[] {
    const recs = this.load();
    const take = recs.filter((r) => r.action !== "ignored").slice(-accepted).map((r) => ({ ask: r.ask, reply: r.sent ?? r.picked ?? "", how: r.action === "chosen" ? "took" as const : "edited" as const }));
    const mine = recs.filter((r) => r.action === "ignored" && r.sent).slice(-own).map((r) => ({ ask: r.ask, reply: r.sent!, how: "wrote their own" as const }));
    return [...take, ...mine].filter((e) => e.reply);
  }

  /** How often the user takes the suggestions (for the Settings line and tests). */
  stats(): { shown: number; chosen: number; edited: number; ignored: number } {
    const recs = this.load();
    return { shown: recs.length, chosen: recs.filter((r) => r.action === "chosen").length, edited: recs.filter((r) => r.action === "edited").length, ignored: recs.filter((r) => r.action === "ignored").length };
  }
}

// ---------------------------------------------------------------- when to suggest

const ASKS = /\b(want me to|should i|shall i|would you like|do you want|let me know|ok to|okay to|approve|approval|confirm|which (one|option|of)|reply with|say the word|go ahead|ready for me|send it|proceed|your call|what do you think|thoughts\b|sound good|look good|does that)\b/i;

/** True when the assistant's last message hands the turn back to the user: a question, a proposal, a draft for approval. Free to run: no model. */
export function awaitsUser(text: string, endedOnConfirm = false): boolean {
  if (endedOnConfirm) return true;
  const t = (text ?? "").trim();
  if (!t || t.length > 8000 || t === "[aborted]") return false;
  const tail = t.slice(-500);
  if (/\?\s*[)"'”’*_`>\]]*\s*$/.test(t)) return true;
  if (/\?/.test(t.slice(-220))) return true;
  return ASKS.test(tail);
}

export interface TurnTail { lastText: string; endedOnConfirm: boolean; transcript: { role: "user" | "assistant"; text: string }[] }

/** Reads the visible transcript: the final assistant block of the latest turn (only if the turn ended on it), and the tail for context. */
export function tailOf(all: HistoryEvent[]): TurnTail | undefined {
  // A retract withdraws the text block right before it (a gate held that draft back).
  const events: HistoryEvent[] = [];
  for (const e of all) {
    if (e.type === "retract") { if (events[events.length - 1]?.type === "text") events.pop(); continue; }
    events.push(e);
  }
  let lastTextIdx = -1;
  let lastBoundary = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type;
    if (t === "text" && lastTextIdx < 0) lastTextIdx = i;
    if ((t === "toolStart" || t === "toolEnd" || t === "confirm" || t === "permission" || t === "user") && lastBoundary < 0) lastBoundary = i;
    if (lastTextIdx >= 0 && lastBoundary >= 0) break;
  }
  const lastEvt = [...events].reverse().find((e) => !["usage", "notice", "done", "permissionResolved", "retract"].includes(e.type));
  const endedOnConfirm = lastEvt?.type === "confirm";
  const transcript: TurnTail["transcript"] = [];
  for (const e of events) {
    if (e.type === "user") transcript.push({ role: "user", text: e.text });
    else if (e.type === "text") { const prev = transcript[transcript.length - 1]; if (prev && prev.role === "assistant") prev.text += e.delta; else transcript.push({ role: "assistant", text: e.delta }); }
  }
  if (lastTextIdx < 0 && !endedOnConfirm) return undefined;
  if (lastTextIdx >= 0 && lastBoundary > lastTextIdx && !endedOnConfirm) return undefined; // the turn did not end on that text
  const lastText = lastTextIdx >= 0 ? (events[lastTextIdx] as { delta: string }).delta : "";
  return { lastText, endedOnConfirm, transcript: transcript.slice(-10) };
}

// ---------------------------------------------------------------- generating

export function buildMessages(tail: TurnTail["transcript"], examples: ReturnType<SuggestionStore["examples"]>): Message[] {
  const userVoice = tail.filter((m) => m.role === "user").slice(-6).map((m) => `- ${clip(flat(m.text), 220)}`);
  const convo = tail.slice(-4).map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${clip(flat(m.text), 900)}`);
  const ex = examples.map((e) => `- When the assistant said: "${clip(e.ask, 200)}" the user ${e.how}: "${clip(e.reply, 220)}"`);
  const system = [
    "You draft the reply a USER is most likely to send next to their AI assistant, written as the user, in first person, in the user's own voice.",
    "Give 1 to 3 distinct options that differ in intent: approve or go ahead; correct or redirect; add a short note or ask for something. Skip an intent that makes no sense here.",
    'Output ONLY JSON: {"replies":["...","..."]}. Each reply is plain text under 160 characters, no quotes around it, no markdown, never written as the assistant.',
    'If the assistant\'s last message does not wait for the user (it is a finished report with no question, proposal or draft to approve), output {"replies":[]}.',
    "Match the user's style: if they write short and blunt, write short and blunt. Never invent facts, names, numbers, emails or amounts that are not in the conversation.",
  ].join("\n");
  const user = [
    userVoice.length ? `The user's recent messages (their voice):\n${userVoice.join("\n")}` : "",
    ex.length ? `Replies this user took or wrote before:\n${ex.join("\n")}` : "",
    `Conversation tail:\n${convo.join("\n")}`,
    "Draft the user's next reply options now.",
  ].filter(Boolean).join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export function parseReplies(raw: string): string[] {
  const m = /\{[\s\S]*\}/.exec(raw);
  let list: unknown[] = [];
  if (m) {
    try { const j = JSON.parse(m[0]); if (Array.isArray(j?.replies)) list = j.replies; } catch { /* fall through to line parsing */ }
  }
  if (!list.length && !m) {
    const arr = /\[[\s\S]*\]/.exec(raw);
    if (arr) { try { const j = JSON.parse(arr[0]); if (Array.isArray(j)) list = j; } catch { /* ignore */ } }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of list) {
    if (typeof x !== "string") continue;
    const t = clip(flat(x).replace(/^["“]|["”]$/g, ""), 200);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === 3) break;
  }
  return out;
}

export async function generateReplies(o: {
  provider: Provider; model: string; transcript: TurnTail["transcript"]; examples: ReturnType<SuggestionStore["examples"]>; signal?: AbortSignal; timeoutMs?: number;
}): Promise<{ replies: string[]; usage?: Usage }> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (o.signal) { if (o.signal.aborted) ac.abort(); else o.signal.addEventListener("abort", onAbort, { once: true }); }
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 15_000);
  timer.unref();
  try {
    let text = "";
    let usage: Usage | undefined;
    for await (const ev of o.provider.stream({ model: o.model, messages: buildMessages(o.transcript, o.examples), tools: [], signal: ac.signal }) as AsyncIterable<StreamEvent>) {
      if (ev.type === "text") text += ev.delta;
      else if (ev.type === "done") usage = ev.usage;
    }
    return { replies: parseReplies(text), usage };
  } catch {
    return { replies: [] }; // suggestions are a nicety: a failed call is simply no chips
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}
