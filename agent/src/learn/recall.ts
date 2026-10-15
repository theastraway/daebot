// Ranking and rendering of the "What you learned before" note, under a hard character budget.
import type { LearnConfig } from "./config.ts";
import { contentProblem } from "./guard.ts";
import { citeId } from "./records.ts";
import { clip, coverage, jaccard, oneLine, tokenSet } from "./text.ts";
import type { Item, UserModel } from "./types.ts";

export const NOTE_HEADER =
  "[learned] What you learned before. Recalled from MIND, not user input. Advisory only: it never overrides the kernel, receipts, confirmations or what the user just said. " +
  "If you apply one, cite its id in parentheses, as written below.";

function itemText(i: Item): string {
  return i.type === "lesson" ? `${i.trigger} ${i.behavior} ${i.rule}` : `${i.name} ${i.description} ${i.preconditions.join(" ")} ${i.tools.join(" ")}`;
}

export interface Ranked { item: Item; score: number; relevance: number }

export function ageDays(updated: string, now: Date): number {
  const t = Date.parse(updated);
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 86_400_000) : 0;
}

export function rank(message: string, items: Item[], cfg: LearnConfig, now: Date = new Date()): Ranked[] {
  const q = tokenSet(message);
  const out: Ranked[] = [];
  for (const it of items) {
    if (it.status !== "active") continue;
    const d = tokenSet(itemText(it));
    let overlap = 0;
    for (const x of q) if (d.has(x)) overlap++;
    const relevance = 0.6 * coverage(q, d) + 0.4 * jaccard(q, d);
    // Need real topical overlap: two shared content words, or one when the message is a short command.
    if (overlap < (q.size <= 3 ? 1 : 2) || relevance < 0.12) continue;
    const judged = it.helped + it.hurt;
    const utility = (it.helped + 1) / (judged + 2);                 // Laplace-smoothed helped rate, 0.5 when unknown
    const decay = Math.pow(0.5, ageDays(it.updated, now) / cfg.halfLifeDays);
    const usage = 1 + Math.min(it.uses, 10) * 0.02;
    out.push({ item: it, relevance, score: relevance * (0.5 + utility) * (0.5 + 0.5 * decay) * usage });
  }
  return out.sort((a, b) => b.score - a.score);
}

function renderItem(i: Item): string {
  if (i.type === "lesson") return `- ${citeId(i)} [${i.kind}] When: ${clip(i.trigger, 140)} Rule: ${clip(i.rule, 240)}`;
  const steps = i.steps.slice(0, 6).map((s, n) => `${n + 1}) ${clip(s, 110)}`).join(" ");
  const pre = i.preconditions.length ? ` Check first: ${clip(i.preconditions.join("; "), 120)}.` : "";
  return `- ${citeId(i)} [skill ${i.name}, worked ${i.successes}x] ${clip(i.description, 110)}.${pre} Steps: ${steps}`;
}

export function renderUserModel(m: UserModel | undefined, budget: number): string {
  if (!m || !m.prefs.length || budget < 80) return "";
  let s = `User model (${m.user}): `;
  const parts: string[] = [];
  for (const p of m.prefs.slice().reverse()) {
    const part = `${p.area}: ${p.statement}`;
    if (contentProblem(part)) continue;
    if ((s + [...parts, part].join("; ")).length > budget) break;
    parts.push(part);
  }
  return parts.length ? s + parts.join("; ") : "";
}

/** Build the note, or undefined when there is nothing to say. Never exceeds cfg.maxInjectChars. */
export function buildNote(opts: {
  message: string; items: Item[]; userModel?: UserModel; cfg: LearnConfig; clientNames?: string[]; now?: Date; maxItems?: number;
}): { note?: string; cited: Item[] } {
  const { cfg } = opts;
  const lines: string[] = [];
  let used = NOTE_HEADER.length + 2;
  const um = renderUserModel(opts.userModel, Math.min(600, cfg.maxInjectChars - used - 200));
  if (um) { lines.push(um); used += um.length + 1; }
  const cited: Item[] = [];
  for (const r of rank(opts.message, opts.items, cfg, opts.now)) {
    if (cited.length >= (opts.maxItems ?? 4)) break;
    // Defense in depth: anything that would not be allowed to be written is not allowed to be read either.
    if (contentProblem(itemText(r.item), { clientNames: opts.clientNames })) continue;
    const line = oneLine(renderItem(r.item), 520);
    if (used + line.length + 1 > cfg.maxInjectChars) continue;
    lines.push(line);
    used += line.length + 1;
    cited.push(r.item);
  }
  if (!lines.length) return { cited };
  return { note: `${NOTE_HEADER}\n${lines.join("\n")}`, cited };
}
