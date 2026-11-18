// The turns compaction removed, plus the span each summary covers, so a later summary still points at the
// original words. Append-only: re-compaction adds the newly dropped turns and keeps the earlier spans.
import { createHash } from "node:crypto";
import type { HistoryEvent, Message, RecallArchive, RecallMsg, RecallSpan, SessionState } from "../types.ts";

const SUMMARY_PREFIX = "[context summary:";

export function spansIn(text: string): RecallSpan[] {
  const out: RecallSpan[] = [];
  const re = /\[turns (\d+)\.\.(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (from >= 1 && to >= from && to < 1_000_000) out.push({ from, to });
  }
  return out;
}

export function formatSpans(spans: readonly RecallSpan[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const s of spans) {
    if (!Number.isFinite(s.from) || !Number.isFinite(s.to)) continue;
    const key = `${s.from}..${s.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`[turns ${s.from}..${s.to}]`);
  }
  return parts.join(" ");
}

export function mergeSpans(a: readonly RecallSpan[], b: readonly RecallSpan[]): RecallSpan[] {
  const seen = new Set<string>();
  const out: RecallSpan[] = [];
  for (const s of [...a, ...b]) {
    const key = `${s.from}..${s.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: s.from, to: s.to });
  }
  return out;
}

/** "1..4" or "[turns 1..4]". */
export function parseSpan(raw: string): RecallSpan | undefined {
  const m = /^(?:\[turns\s+)?(\d+)\.\.(\d+)\]?$/.exec(raw.trim());
  if (!m) return undefined;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from < 1 || to < from || to > 1_000_000) return undefined;
  return { from, to };
}

/** The first user-turn number of a slice being compacted: one past the newest span already in a summary, else the hint, else 1. */
export function openingTurn(older: readonly { role: string; content: string }[], hint?: number): number {
  let maxTo = 0;
  for (const m of older) {
    if (m.role === "system" && m.content.startsWith(SUMMARY_PREFIX)) {
      for (const s of spansIn(m.content)) if (s.to > maxTo) maxTo = s.to;
    }
  }
  if (maxTo > 0) return maxTo + 1;
  if (hint && hint > 0) return Math.floor(hint);
  return 1;
}

export function isEphemeral(m: { role: string; content: string }): boolean {
  if (m.role !== "system") return false;
  if (m.content.startsWith(SUMMARY_PREFIX)) return false;
  const c = m.content;
  return c.startsWith("[learned]") || c.startsWith("Relevant from MIND") || c.startsWith("[Check-in:") || c.startsWith("[kernel:") || c.startsWith("[Loop guard:") || c.startsWith("[Advisor:");
}

export function messageText(m: Message): string {
  let t = (m.content ?? "").replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, "[image omitted]");
  if (m.toolCalls?.length) {
    const calls = m.toolCalls.map((c) => {
      let args = "";
      try { args = JSON.stringify(c.args ?? {}).slice(0, 400); } catch { args = ""; }
      return `${c.name}(${args})`;
    }).join(", ");
    const line = `[calls: ${calls}]`;
    t = t ? `${t}\n${line}` : line;
  }
  return t;
}

function recallId(seq: number, turn: number, role: string, text: string): string {
  return "r" + createHash("sha256").update(`${seq}|${turn}|${role}|${text.slice(0, 120)}`).digest("hex").slice(0, 16);
}

/**
 * Number user messages from `firstTurn` (1-based). A compaction summary stays turn 0.
 * `startSeq` keeps ids stable when this slice is appended after turns already archived.
 */
export function toRecallMsgs(messages: readonly Message[], firstTurn: number, startSeq: number): RecallMsg[] {
  const out: RecallMsg[] = [];
  let turn = Math.max(0, firstTurn - 1);
  let seq = startSeq;
  for (const m of messages) {
    if (isEphemeral(m)) continue;
    const summary = m.role === "system" && m.content.startsWith(SUMMARY_PREFIX);
    if (m.role === "user") turn = turn < firstTurn ? firstTurn : turn + 1;
    const assigned = summary ? 0 : turn;
    const text = messageText(m);
    out.push({ id: recallId(seq, assigned, m.role, text), turn: assigned, role: m.role, text, ...(m.name ? { name: m.name } : {}) });
    seq++;
  }
  return out;
}

export function rememberCompaction(
  recall: RecallArchive | undefined,
  r: { dropped: readonly Message[]; span: RecallSpan; spans: readonly RecallSpan[]; firstTurn: number },
): RecallArchive {
  const base: RecallArchive = recall ?? { dropped: [], spans: [], nextTurn: 1 };
  const start = r.firstTurn || base.nextTurn || 1;
  const archived = toRecallMsgs(r.dropped, start, base.dropped.length);
  const spans = mergeSpans(base.spans, r.spans?.length ? r.spans : [r.span]);
  return {
    dropped: [...base.dropped, ...archived],
    spans,
    nextTurn: Math.max(base.nextTurn || 1, (r.span?.to ?? 0) + 1, start),
  };
}

function toolBody(state: SessionState, receiptId: string, preview: string): string {
  const prefix = `[#${receiptId}`;
  const msg = state.messages.find((m) => m.role === "tool" && m.content.startsWith(prefix));
  return msg ? messageText(msg) : preview;
}

/** History is the fallback for a session saved before the archive existed. toolEnd's 200-char preview is replaced by the full tool message when it is still in state. */
function fromHistory(state: SessionState, history: readonly HistoryEvent[]): RecallMsg[] {
  const out: RecallMsg[] = [];
  let turn = 0;
  let seq = 0;
  for (const ev of history) {
    if (ev.type === "user") {
      turn++;
      const text = ev.text ?? "";
      out.push({ id: ev.id || recallId(seq, turn, "user", text), turn, role: "user", text });
      seq++;
    } else if (ev.type === "text") {
      const text = ev.delta ?? "";
      const useTurn = turn || 0;
      out.push({ id: ev.id || recallId(seq, useTurn, "assistant", text), turn: useTurn, role: "assistant", text });
      seq++;
    } else if (ev.type === "toolEnd") {
      const text = toolBody(state, ev.receiptId, ev.preview ?? "");
      const useTurn = turn || 0;
      out.push({ id: ev.receiptId ? `t${ev.receiptId}` : recallId(seq, useTurn, "tool", text), turn: useTurn, role: "tool", text, name: ev.tool });
      seq++;
    }
  }
  return out;
}

/**
 * Archived turns (full text, from before they left the model context) plus whatever is still in state.
 * History is not merged in once an archive exists, or the same turn would appear twice.
 */
export function corpusOf(state: SessionState, history: readonly HistoryEvent[] | undefined): RecallMsg[] {
  const recall = state.recall;
  const messages = state.messages ?? [];
  if (recall && ((recall.dropped?.length ?? 0) > 0 || (recall.spans?.length ?? 0) > 0)) {
    const dropped = recall.dropped ?? [];
    return [...dropped, ...toRecallMsgs(messages, recall.nextTurn || 1, dropped.length)];
  }
  const hist = history ?? [];
  if (hist.some((e) => e.type === "user")) return fromHistory(state, hist);
  return toRecallMsgs(messages, 1, 0);
}
