// Trust and content guards. A lesson is persistent prompt text, so it is treated as an attack surface:
// who may cause one to be written (trust), and what it may say (content).
import type { CallRecord } from "../types.ts";
import type { Tier } from "../kernel/index.ts";
import { tokenSet } from "./text.ts";

// Tools whose output comes from outside (a web page, anything a third party controls). A turn that read one is tainted.
const UNTRUSTED_TOOLS = new Set(["web_fetch"]);

export interface Trust { ok: boolean; why?: string }

/** Only the owner's own admin sessions may cause a write. Public/staff tiers, non-admin channel senders and turns that read web content never do. */
export function writeTrust(tier: Tier, calls: CallRecord[]): Trust {
  if (tier !== "admin") return { ok: false, why: `tier ${tier} is untrusted for learning` };
  const tainted = calls.find((c) => UNTRUSTED_TOOLS.has(c.tool));
  if (tainted) return { ok: false, why: `turn read untrusted content (${tainted.tool})` };
  return { ok: true };
}

const SECRET = /\b(?:mind_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{16,}|sk-or-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const URL_RE = /\bhttps?:\/\/\S+/i;
const LONG_ID = /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/i;
const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?/;
const PHONE = /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;

// A lesson may never teach the agent to get around the kernel or to act on a third party without a go-ahead.
const KERNEL_OVERRIDE: RegExp[] = [
  /\b(?:skip|bypass|disable|ignore|override|circumvent|turn off|switch off|work around|get around)\b[^.\n]{0,40}\b(?:kernel|gates?|receipts?|guard\w*|safety|owner[_ ]check|confirmations?|isolation|boot|danger|rules?)\b/i,
  /\bwithout (?:asking|confirm\w*|approval|permission|a go[- ]ahead|a receipt|receipts|checking)\b/i,
  /\b(?:ignore|disregard|forget) (?:all |any |the )?(?:previous|prior|above|earlier|system) (?:instructions?|rules?|prompts?)\b/i,
  /\byou (?:are|were) now\b|\bnew instructions?\b|\bact as\b|\bjailbreak\b/i,
  /<\/?(?:system|assistant|user|tool|memory-context|learned)\b|\[kernel:|\[learned\]|^\s*(?:system|assistant)\s*:/im,
  /\b(?:always|just) (?:send|post|publish|deploy|delete|merge|email)\b/i,
];

// "never skip the receipt" and "do not act without asking" are the kernel's own rules restated, not overrides.
function negated(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 24), at).toLowerCase();
  return /\b(?:never|don'?t|do not|must not|should not|shouldn'?t|not|no|stop|avoid|refuse to)\s+(?:\w+\s+)?$/.test(before);
}

export interface ScrubOpts { clientNames?: string[] }

/** Returns a reason when the text must not be stored or injected, else null. */
export function contentProblem(text: string, o: ScrubOpts = {}): string | null {
  if (SECRET.test(text)) return "contains a secret-looking token";
  if (EMAIL.test(text)) return "contains an email address";
  if (URL_RE.test(text)) return "contains a URL";
  if (LONG_ID.test(text)) return "contains a long id";
  if (MONEY.test(text)) return "contains a dollar amount";
  if (PHONE.test(text)) return "contains a phone number";
  for (const re of KERNEL_OVERRIDE) {
    const m = re.exec(text);
    if (m && !negated(text, m.index)) return "tries to override the kernel or its rules";
  }
  const lower = text.toLowerCase();
  for (const n of o.clientNames ?? []) {
    const name = n.trim().toLowerCase();
    if (name.length >= 3 && lower.includes(name)) return "names a client (client material stays out of our own lessons)";
  }
  return null;
}

export const LIMITS = { trigger: 180, behaviorWords: 3, rule: 260, evidence: 220, step: 160, steps: 10, desc: 160, pref: 200 } as const;

export function lengthProblem(f: { trigger: string; rule: string; evidence: string }): string | null {
  if (!f.trigger.trim() || !f.rule.trim()) return "trigger and rule are required";
  if (f.trigger.length > LIMITS.trigger) return "trigger too long";
  if (f.rule.length > LIMITS.rule) return "rule too long";
  if (f.evidence.length > LIMITS.evidence) return "evidence too long";
  if (tokenSet(f.rule).size < 3) return "rule too vague";
  return null;
}
