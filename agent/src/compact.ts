// Context compaction. When the model-facing history grows past a fraction of the context window, the older
// turns are summarized by the cheap model into ONE system note. The last N turns stay verbatim and every
// receipt line (MIND✓ / SURFACE✓) from the compacted turns is carried over word for word, so the receipt
// trail survives. Summarization failure never fails the chat: a mechanical digest takes its place.
import type { HandoffCard, Message, Provider, Usage } from "./types.ts";

export const SUMMARY_TAG = "[context summary: earlier turns were compacted to save context]";
export const KEEP_TURNS = 8;
const RECEIPT_LINE = /^\s*(?:MIND|SURFACE)✓.*$/gm;
const MAX_RECEIPT_LINES = 300;
const MAX_TRANSCRIPT_CHARS = 200_000;

/** chars/4 is close enough for a threshold; it only has to be monotone and cheap. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length + 16;
    if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
  }
  return Math.ceil(chars / 4);
}

export function needsCompaction(messages: Message[], contextWindow: number, ratio: number): boolean {
  return estimateTokens(messages) > contextWindow * ratio;
}

export function receiptLines(messages: Message[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" && !(m.role === "system" && m.content.startsWith(SUMMARY_TAG))) continue;
    for (const line of m.content.match(RECEIPT_LINE) ?? []) {
      const t = line.trim().slice(0, 400);
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out.slice(-MAX_RECEIPT_LINES);
}

function renderTranscript(older: Message[]): string {
  const lines: string[] = [];
  for (const m of older) {
    if (m.role === "tool") lines.push(`[tool ${m.name ?? ""}] ${m.content.slice(0, 600)}`);
    else {
      const calls = m.toolCalls?.length ? ` (calls: ${m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 160)})`).join(", ")})` : "";
      lines.push(`[${m.role}] ${m.content.slice(0, 2000)}${calls}`);
    }
  }
  const t = lines.join("\n");
  return t.length > MAX_TRANSCRIPT_CHARS ? t.slice(t.length - MAX_TRANSCRIPT_CHARS) : t;
}

function mechanicalDigest(older: Message[]): string {
  const out: string[] = [];
  for (const m of older) {
    if (m.role === "user") out.push(`- user: ${m.content.replace(/\s+/g, " ").slice(0, 200)}`);
    else if (m.role === "assistant" && m.content.trim() && !m.toolCalls?.length) out.push(`  assistant: ${m.content.replace(/\s+/g, " ").slice(0, 200)}`);
    else if (m.role === "system" && m.content.startsWith(SUMMARY_TAG)) out.push(m.content.slice(SUMMARY_TAG.length).trim().slice(0, 1500));
  }
  return out.join("\n").slice(0, 6000);
}

/** The summary is written in the handoff card's shape, so the next worker (or the same model after compaction) starts from the same five lines. */
export const HANDOFF_HEADINGS = ["Objective", "Evidence", "What is left", "Next action", "How to verify"] as const;

/** Parses a summary written in the handoff shape. undefined when the headings are not there (a free-form summary is still a fine summary). */
export function parseHandoff(text: string, at = Date.now()): HandoffCard | undefined {
  const sec: Record<string, string[]> = {};
  let cur: string | undefined;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const h = /^\s*(?:#+\s*)?(Objective|Evidence|What is left|Next action|How to verify)\s*:?\s*(.*)$/i.exec(raw);
    if (h) { cur = HANDOFF_HEADINGS.find((x) => x.toLowerCase() === h[1].toLowerCase()); if (cur) { sec[cur] = sec[cur] ?? []; if (h[2].trim()) sec[cur].push(h[2].trim()); } continue; }
    if (cur && raw.trim()) sec[cur].push(raw.trim().replace(/^[-*]\s+/, ""));
  }
  const objective = (sec.Objective ?? []).join(" ").trim();
  const next = (sec["Next action"] ?? []).join(" ").trim();
  if (!objective || !next) return undefined;
  const lines = (k: string) => (sec[k] ?? []).map((l) => l.slice(0, 300)).filter(Boolean).slice(0, 12);
  const verify = (sec["How to verify"] ?? []).join(" ").trim();
  return { objective: objective.slice(0, 400), evidence: lines("Evidence"), left: lines("What is left"), next: next.slice(0, 400), ...(verify ? { verify: verify.slice(0, 400) } : {}), at };
}

async function summarize(older: Message[], provider: Provider, model: string, signal?: AbortSignal): Promise<{ text: string; usage?: Usage }> {
  const prompt: Message[] = [
    { role: "system", content: "You compress a conversation between a user and an AI agent so the agent (or another agent) can continue it later. Write a handoff card, at most 400 words, under exactly these five headings: Objective (what the user wants, one or two sentences), Evidence (facts established and receipts: paths, ids, numbers, what already works, with their sources, one per line), What is left (open tasks, one per line), Next action (the one thing to do next), How to verify (the check that proves the result). No preamble. Do not invent anything; leave out what you are unsure of." },
    { role: "user", content: renderTranscript(older) },
  ];
  let text = "";
  let usage: Usage | undefined;
  for await (const ev of provider.stream({ model, messages: prompt, tools: [], signal })) {
    if (ev.type === "text") text += ev.delta;
    else if (ev.type === "done") usage = ev.usage;
  }
  return { text: text.trim(), usage };
}

export interface CompactResult { messages: Message[]; compacted: number; usage?: Usage; mechanical: boolean; /** The handoff card, when the summary came in that shape. */ card?: HandoffCard }

/**
 * Replaces everything before the last `keepTurns` user messages with one summary note.
 * Returns undefined when there is nothing old enough to compact. messages[0] is the system prompt and is kept.
 */
export async function compactMessages(
  messages: Message[],
  o: { provider: Provider; model: string; keepTurns?: number; signal?: AbortSignal },
): Promise<CompactResult | undefined> {
  const keep = o.keepTurns ?? KEEP_TURNS;
  const userIdx: number[] = [];
  messages.forEach((m, i) => { if (i > 0 && m.role === "user") userIdx.push(i); });
  if (userIdx.length <= keep) return undefined;
  const cut = userIdx[userIdx.length - keep]; // a user-message boundary: tool-call/result pairs stay intact
  const older = messages.slice(1, cut);
  if (older.length === 0) return undefined;

  let summary = "";
  let usage: Usage | undefined;
  let mechanical = false;
  try {
    const r = await summarize(older, o.provider, o.model, o.signal);
    summary = r.text;
    usage = r.usage;
  } catch (e) {
    if (o.signal?.aborted || (e as Error)?.name === "AbortError") throw e;
  }
  if (!summary) { mechanical = true; summary = mechanicalDigest(older); }

  const receipts = receiptLines(older);
  const note = [SUMMARY_TAG, summary, receipts.length ? `Receipt lines from the compacted turns (verbatim):\n${receipts.join("\n")}` : ""].filter(Boolean).join("\n\n");
  const card = mechanical ? undefined : parseHandoff(summary);
  return { messages: [messages[0], { role: "system", content: note }, ...messages.slice(cut)], compacted: older.length, usage, mechanical, ...(card ? { card } : {}) };
}

/** Last resort when even the verbatim tail is too big: clip old tool outputs (never the newest `protect` messages). */
export function clipToolOutputs(messages: Message[], maxChars = 4000, protect = 6): number {
  let clipped = 0;
  for (let i = 1; i < messages.length - protect; i++) {
    const m = messages[i];
    if (m.role === "tool" && m.content.length > maxChars) {
      messages[i] = { ...m, content: `${m.content.slice(0, maxChars)}\n[clipped to save context]` };
      clipped++;
    }
  }
  return clipped;
}
