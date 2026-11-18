// Trust and content guards. A lesson is persistent prompt text, so it is treated as an attack surface:
// who may cause one to be written (trust), and what it may say (content).
import type { CallRecord } from "../types.ts";
import type { Tier } from "../kernel/index.ts";
import { tokenSet } from "./text.ts";

// Tools whose output comes from outside (a web page, anything a third party controls). A turn that read one is tainted.
const UNTRUSTED_TOOLS = new Set(["web_fetch", "web_search"]);

export interface Trust { ok: boolean; why?: string }

/** Only the owner's own admin sessions may cause a write. Public/staff tiers, non-admin channel senders and turns that read web content never do. */
export function writeTrust(tier: Tier, calls: CallRecord[], o: { tenant?: boolean } = {}): Trust {
  // A tenant runtime (a hosted user on their own MIND key) learns into its own MIND as staff; a public identity never does.
  if (tier !== "admin" && !(tier === "staff" && o.tenant)) return { ok: false, why: `tier ${tier} is untrusted for learning` };
  const tainted = calls.find((c) => UNTRUSTED_TOOLS.has(c.tool));
  if (tainted) return { ok: false, why: `turn read untrusted content (${tainted.tool})` };
  return { ok: true };
}

export const SECRET = /\b(?:mind_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{16,}|sk-or-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{30,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)\b/;
const SECRET_ALL = new RegExp(SECRET.source, "g");

/** Replaces every secret-looking token with a marker. Used on tool outputs before they reach the model, the transcript or a preview. */
export function redactSecrets(text: string): string {
  if (!text || !SECRET.test(text)) return text;
  return text.replace(SECRET_ALL, (m) => (m.startsWith("Bearer") ? "Bearer [redacted secret]" : m.startsWith("-----") ? "[redacted private key]" : "[redacted secret]"));
}
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const URL_RE = /\bhttps?:\/\/\S+/i;
const LONG_ID = /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/i;
const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?/;
const PHONE = /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;

// A lesson may never teach the agent to get around the kernel or to act on a third party without a go-ahead.
// "act as" is its own rule so the page screen can skip it: ordinary pages say "act as a server".
const BYPASS_KERNEL = /\b(?:skip|bypass|disable|ignore|override|circumvent|turn off|switch off|work around|get around)\b[^.\n]{0,40}\b(?:kernel|gates?|receipts?|guard\w*|safety|owner[_ ]check|confirmations?|isolation|boot|danger|rules?)\b/i;
const WITHOUT_ASKING = /\bwithout (?:asking|confirm\w*|approval|permission|a go[- ]ahead|a receipt|receipts|checking)\b/i;
const IGNORE_PREVIOUS = /\b(?:ignore|disregard|forget) (?:all |any |the )?(?:previous|prior|above|earlier|system) (?:instructions?|rules?|prompts?)\b/i;
const YOU_ARE_NOW = /\byou (?:are|were) now\b|\bnew instructions?\b|\bjailbreak\b/i;
const ACT_AS = /\bact as\b/i;
const ROLE_TAGS = /<\/?(?:system|assistant|user|tool|memory-context|learned)\b|\[kernel:|\[learned\]|^\s*(?:system|assistant)\s*:/im;
const ALWAYS_SEND = /\b(?:always|just) (?:send|post|publish|deploy|delete|merge|email)\b/i;
const KERNEL_OVERRIDE: RegExp[] = [BYPASS_KERNEL, WITHOUT_ASKING, IGNORE_PREVIOUS, YOU_ARE_NOW, ACT_AS, ROLE_TAGS, ALWAYS_SEND];

// Fillers a page puts between "ignore" and "previous instructions" ("all of the previous"). The lesson regex above stays exact.
const IGNORE_LOOSE = /\b(?:ignore|disregard|forget)(?:\s+(?:all|any|of|the|your|my|these))*\s+(?:previous|prior|above|earlier|system|original)\s+(?:instructions?|prompts?|rules?)\b|\b(?:ignore|disregard|forget) (?:all |any )(?:the )?(?:instructions?|prompts?|rules?)\b/i;
// Chat-template markers and a JSON tool call. A docs page that shows a real function-call payload is withheld on purpose.
const TOOL_OR_TEMPLATE = /<\|(?:im_start|im_end)\|>|\b(?:tool_calls?|function_call)\b|<(?:tool_call|function_call|invoke)\b|\{\s*"(?:name|function)"\s*:\s*"[^"]{1,80}"[^}]{0,240}"(?:arguments|parameters|args)"\s*:/i;
const EXFIL = /\b(?:exfiltrate|steal)\b[^.\n]{0,60}\b(?:secret|key|token|password|credential)s?\b|\b(?:send|email|post|forward|upload|give|print|dump|cat)\b[^.\n]{0,80}\b(?:api[ _-]?key|secrets?|passwords?|tokens?|credentials?|\.env|id_rsa|~\/\.ssh)\b/i;
// Characters that hide words. ZWJ (U+200D) and ZWNJ (U+200C) are real emoji and Arabic spelling, so they are not in this class.
const HIDDEN_TEXT = /[\u180e\u200b\u2060\ufeff\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}]/u;
// Page text reuses the lesson rules that are specific, and not "act as" / "just email us" / "without asking", which normal pages say.
const PAGE_RULES: RegExp[] = [BYPASS_KERNEL, IGNORE_PREVIOUS, IGNORE_LOOSE, YOU_ARE_NOW, ROLE_TAGS, TOOL_OR_TEMPLATE, EXFIL];

// "never skip the receipt" and "do not act without asking" are the kernel's own rules restated, not overrides.
function negated(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 24), at).toLowerCase();
  return /\b(?:never|don'?t|do not|must not|should not|shouldn'?t|not|no|stop|avoid|refuse to)\s+(?:\w+\s+)?$/.test(before);
}

/** True when any rule matches at a spot that is not a negation ("do not ignore…"). A later hit still counts. */
function ruleHit(text: string, rules: RegExp[]): boolean {
  for (const re of rules) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      if (!negated(text, m.index)) return true;
      if (m.index === g.lastIndex) g.lastIndex++;
    }
  }
  return false;
}

export interface ScrubOpts { clientNames?: string[] }

/**
 * The lighter scan for prompt text that is allowed to carry URLs, code and numbers (a file skill, an imported how-to): refuses a
 * secret-looking token and any attempt to override the kernel or its rules. Returns the reason, else null.
 */
export function promptInjectionProblem(text: string): string | null {
  if (SECRET.test(text)) return "contains a secret-looking token";
  if (ruleHit(text, KERNEL_OVERRIDE)) return "tries to override the kernel or its rules";
  return null;
}

/**
 * A block of outside text (a fetched page, later a recalled MIND note) that is trying to instruct the assistant.
 * Reuses the lesson guard's specific rules and adds page patterns (chat templates, fake tool calls, hidden text,
 * "send the api key"). "act as", "just email us" and "without asking" are normal prose and are not flagged.
 * Returns a reason, else null. A secret-looking example on a docs page is redacted later, not withheld here.
 */
export function fetchedInstructionProblem(text: string): string | null {
  if (HIDDEN_TEXT.test(text)) return "contains hidden or zero-width text";
  if (ruleHit(text, PAGE_RULES)) return "looks like instructions to the assistant";
  return null;
}

/** Returns a reason when the text must not be stored or injected, else null. */
export function contentProblem(text: string, o: ScrubOpts = {}): string | null {
  if (SECRET.test(text)) return "contains a secret-looking token";
  if (EMAIL.test(text)) return "contains an email address";
  if (URL_RE.test(text)) return "contains a URL";
  if (LONG_ID.test(text)) return "contains a long id";
  if (MONEY.test(text)) return "contains a dollar amount";
  if (PHONE.test(text)) return "contains a phone number";
  if (ruleHit(text, KERNEL_OVERRIDE)) return "tries to override the kernel or its rules";
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
