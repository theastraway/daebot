// When is a turn worth reflecting on? Pure functions, no I/O.
import { UNVERIFIED_FOOTER } from "../loop.ts";
import { jaccard, tokenSet } from "./text.ts";
import type { Trigger, TurnSummary } from "./types.ts";

const BOOT_TOOLS = new Set(["mind_context", "mind_sense", "mind_profile"]);

const CORRECTION: RegExp[] = [
  /^\s*(no|nope|nah|wrong|incorrect|stop|wait)\b[\s,.!:;-]/i,
  /^\s*(no|nope|wrong|incorrect|stop)\s*[.!]*\s*$/i,
  /\bthat(?:'s|\s+is|\s+was)?\s+(?:not|wrong|incorrect|not right|not what)\b/i,
  /\bnot what i (?:asked|said|meant|wanted)\b/i,
  /\bi (?:told|said|asked|already told|already said|just said) you\b/i,
  /\b(?:you|u) (?:keep|kept|always|never|still|didn'?t|did not|forgot|ignored|missed)\b/i,
  /\bwhy (?:did|are|do|would) you\b/i,
  /\bas i (?:said|told you|mentioned)\b/i,
  /\b(?:don'?t|do not|never) (?:do|use|say|add|make|write|send|call|open|ask)\b/i,
  /\bstop (?:doing|adding|asking|using|saying|making|writing)\b/i,
  /\b(?:try again|redo (?:it|this)|do it again|fix (?:it|this) again)\b/i,
];

const ANGER: RegExp[] = [
  /\b[A-Z]{4,}(?:\s+[A-Z]{3,}){1,}\b/,              // SHOUTED PHRASE
  /\b(?:fuck\w*|shit\w*|damn|wtf|goddamn|idiot|useless|stupid)\b/i,
  /!{2,}/,
];

export function looksLikeCorrection(msg: string, history: string[] = []): boolean {
  const m = (msg ?? "").trim();
  if (!m) return false;
  if (CORRECTION.some((r) => r.test(m))) return true;
  if (ANGER.some((r) => r.test(m)) && m.length > 8) return true;
  // Repeated instruction: the same ask again, nearly word for word, within the last three user messages.
  if (m.length > 12) {
    const cur = tokenSet(m);
    for (const h of history.slice(-3)) if (h.length > 12 && jaccard(cur, tokenSet(h)) >= 0.6) return true;
  }
  return false;
}

export function detectTriggers(t: TurnSummary): Trigger[] {
  const out: Trigger[] = [];
  const blocks = t.violations.filter((v) => v.enforced && v.action === "block");
  if (blocks.length) out.push({ kind: "kernel_block", detail: blocks.slice(0, 3).map((v) => `${v.gate}: ${v.reason}`).join(" | ") });
  if (t.finalText.includes(UNVERIFIED_FOOTER)) out.push({ kind: "kernel_block", detail: "answer shipped unverified after the receipt gate refused it" });
  const failed = t.calls.filter((c) => !c.result.ok);
  if (failed.length) out.push({ kind: "tool_failure", detail: failed.slice(0, 3).map((c) => `${c.tool}: ${c.result.output.replace(/\s+/g, " ").slice(0, 120)}`).join(" | ") });
  if (looksLikeCorrection(t.userMessage, t.userHistory)) out.push({ kind: "user_correction", detail: t.userMessage.replace(/\s+/g, " ").slice(0, 240) });
  if (isMultiStepSuccess(t)) {
    const names = [...new Set(t.calls.filter((c) => !BOOT_TOOLS.has(c.tool)).map((c) => c.tool))];
    out.push({ kind: "multi_step_success", detail: `${t.calls.length} calls, tools: ${names.join(", ")}` });
  }
  return out;
}

export function isMultiStepSuccess(t: TurnSummary): boolean {
  if (t.failed || !t.finalText.trim() || t.finalText.includes(UNVERIFIED_FOOTER)) return false;
  if (t.violations.some((v) => v.enforced && v.action !== "allow")) return false;
  const work = t.calls.filter((c) => !BOOT_TOOLS.has(c.tool));
  if (work.length < 3) return false;
  if (work.some((c) => !c.result.ok)) return false;
  return new Set(work.map((c) => c.tool)).size >= 2;
}

// A turn "went badly" for outcome accounting: something concrete broke inside it.
export function turnWentBadly(t: TurnSummary): boolean {
  return t.failed || t.calls.some((c) => !c.result.ok) || t.violations.some((v) => v.enforced && v.action === "block") || t.finalText.includes(UNVERIFIED_FOOTER);
}
