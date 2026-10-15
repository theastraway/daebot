// Context compaction. When the model-facing history grows past a fraction of the context window, the older
// turns are summarized by the cheap model into ONE system note. The last N turns stay verbatim and every
// receipt line (MIND✓ / SURFACE✓) from the compacted turns is carried over word for word, so the receipt
// trail survives. Summarization failure never fails the chat: a mechanical digest takes its place.
import type { Message, Provider, Usage } from "./types.ts";

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

async function summarize(older: Message[], provider: Provider, model: string, signal?: AbortSignal): Promise<{ text: string; usage?: Usage }> {
  const prompt: Message[] = [
    { role: "system", content: "You compress a conversation between a user and an AI agent so the agent can continue it later. Write a dense factual summary (at most 400 words): decisions made, facts established with their sources, open tasks, names, numbers and ids that matter, what the user asked for and what is still pending. No preamble. Do not invent anything; leave out what you are unsure of." },
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

export interface CompactResult { messages: Message[]; compacted: number; usage?: Usage; mechanical: boolean }

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
  return { messages: [messages[0], { role: "system", content: note }, ...messages.slice(cut)], compacted: older.length, usage, mechanical };
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
