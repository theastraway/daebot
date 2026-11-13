import type { CallRecord, Gate, GateVerdict } from "../types.ts";

export type ClaimKind = "completion" | "negative" | "fact";
export interface Claim { kind: ClaimKind; text: string }
export interface ReceiptCheck { line: string; id: string; kind: "mind" | "surface"; valid: boolean; why?: string }

// "complete"/"operational" only count as claims in status form ("is complete", "fully operational"), not as ordinary adjectives.
const COMPLETION = /\b(done|built|shipped|live(?!\s+(?:in|with|on|from)\b|\s+at\s+\d)|deployed|merged|working(?!\s+(?:on|with|through|towards|from)\b)|fixed|ready(?!\s+to\b)|(?<!\b(?:no|any|not|without)\s)verified|passing|completed|launched|finished|(?:is|are|was|were|now|fully|been)\s+complete|(?:is|are|now|fully|be|been)\s+operational|(?<=\b(?:I|we|it|email|message|reply|mail|has been|have been|was|were|just|already|now)\s)sent)\b/i;
// Status adjectives are claims only in status form ("it is live", "tests passing", "went live"), never attributive ("the live ILYVEN re-run", "passing checks").
const ADJECTIVE_CLAIMS = new Set(["live", "working", "passing", "ready", "verified"]);
const STATUS_LEAD = /(?:\b(?:is|are|was|were|been|be|now|just|already|fully|all|went|goes|go|still|currently|seems?|looks?|stays?|remains?)|['\u2019](?:s|re)|[:\u2014-])\s*(?:\*\*|_)?$/i;
const STATUS_TRAIL = /^\s*(?:\*\*|_)?(?:[.,;:!)\u2014-]|$|at\b|now\b|again\b|and\b|for\b)/i;
// Not a claim: the clause before the word talks about what the user wants, what will or might happen, or negates it.
const NOT_A_CLAIM_LEAD = /\b(?:want(?:s|ed)?|need(?:s|ed)?|get(?:s|ting)?|if|when|once|until|unless|whether|will|won't|going to|gonna|let me|let's|can|could|should|would|might|may|must|how to|before|after|so that|in order to|to be|not|never|yet|no|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|didn't|don't|doesn't|can't|couldn't|n't|instead of|rather than)\b[^.!?\n]*$/i;
// A fact inside an offer, plan, question-to-user or condition ("I'll email bob@x.com") asserts nothing yet.
const NOT_A_CLAIM_SENTENCE = /\b(?:I'll|I will|I'd|I would|I can|I could|I'm going to|I am going to|let me|let's|want me to|shall I|should I|say the word|if you|when you|once you|want to|do you want|would you like|which one|which of)\b/i;
// A bare "I can't" is a refusal, not an existence claim: only "I can't find/see/access..." counts.
const NEGATIVE = /\b(doesn't exist|does not exist|no such|isn't supported|is not supported|not supported|there is no|there's no|I (?:can't|cannot|couldn't|could not) (?:find|locate|see|access|retrieve|recover|reset|read|open)|not stored|not available|isn't available|is not available|has no|have no|doesn't have|does not have|no support for)\b/i;
// Attribution makes echoing a figure from the user's own latest message legitimate.
const ATTRIBUTION = /\b(you said|you mentioned|you noted|you told me|you wrote|you stated|you put it|per your (?:message|note|email|text)|as you (?:said|noted|mentioned|put it)|according to you|by your (?:count|numbers?))\b/i;
const FACT_PATTERNS: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/,          // email
  /\$\s?\d[\d,]*(?:\.\d+)?/,                                       // dollar amount
  /\b\d+(?:\.\d+)?\s?%/,                                           // percentage
  /\b\d+(?:\.\d+)?\s?percent\b/i,                                 // percentage, spelled out
  /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/i,                              // 8+ char hex / uuid segment / long digit id
  /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/,                         // phone
];
// A receipt starts its line; a list marker ("- ", "* ", "• ", "1. ") or bold before it still counts.
const RECEIPT_PREFIX = String.raw`^[ \t]*(?:[-*•]|\d+[.)])?[ \t]*(?:\*\*)?`;
const RECEIPT_LINE = new RegExp(RECEIPT_PREFIX + String.raw`(MIND✓|SURFACE✓)(?:\*\*)? #c(\d+)\b.*$`, "gm");

function normApos(s: string): string {
  return s.replace(/[‘’]/g, "'");
}

function stripFences(s: string): string {
  return s.replace(/```[\s\S]*?(?:```|$)/g, " ");
}

// Text in which claims are looked for: no code, no quotes, no receipt lines.
function claimText(draft: string): string {
  let t = stripFences(normApos(draft));
  t = t.replace(/`[^`\n]*`/g, " ");
  t = t.replace(new RegExp(RECEIPT_PREFIX + "(MIND✓|SURFACE✓).*$", "gm"), " ");
  t = t.replace(/"[^"\n]{0,300}"/g, " ").replace(/“[^”\n]{0,300}”/g, " ");
  return t;
}

function squash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

// opts.userMessage: a fact that appears in the latest user message is exempt only when the same sentence
// carries attribution ("you said", "per your message", ...). An unattributed echo is still a claim.
// First completion word in `sent` that really asserts finished work; undefined for plans, wishes, negations and adjective uses.
function completionClaim(sent: string): string | undefined {
  for (const m of sent.matchAll(new RegExp(COMPLETION.source, "gi"))) {
    const word = m[1];
    const before = sent.slice(0, m.index);
    if (NOT_A_CLAIM_LEAD.test(before)) continue;
    if (/\b(?:the|a|an|this|that|these|those|your|my|our|its|their|any|each|every|of|last|latest|previous)\s+$/i.test(before)) continue; // "the deployed build": attributive, not a claim
    if (ADJECTIVE_CLAIMS.has(word.toLowerCase())) {
      const after = sent.slice(m.index! + word.length);
      if (!STATUS_LEAD.test(before) && !(before.trim() === "" && STATUS_TRAIL.test(after))) continue;
    }
    return word;
  }
  return undefined;
}

// opts.grounded: squashed outputs of this turn's tool calls; a fact that appears verbatim in one is sourced, not guessed.
export function findClaims(draft: string, opts: { userMessage?: string; grounded?: string[] } = {}): Claim[] {
  const claims: Claim[] = [];
  const text = claimText(draft);
  const userText = squash(normApos(opts.userMessage ?? ""));
  for (const line of text.split("\n")) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const sent = sentence.trim();
      if (!sent || sent.endsWith("?")) continue;
      const neg = NEGATIVE.exec(sent);
      if (neg) claims.push({ kind: "negative", text: neg[1] });
      const comp = completionClaim(sent);
      if (comp) claims.push({ kind: "completion", text: comp.toLowerCase() });
      const planned = NOT_A_CLAIM_SENTENCE.test(sent);
      for (const re of FACT_PATTERNS) {
        const m = re.exec(sent);
        if (!m) continue;
        if (planned) continue;
        if (opts.grounded?.some((g) => g.includes(squash(m[0])))) continue;
        if (userText && ATTRIBUTION.test(sent) && userText.includes(squash(m[0]))) continue;
        claims.push({ kind: "fact", text: m[0] });
      }
    }
  }
  return claims;
}

export function validReceipts(draft: string, calls: CallRecord[]): ReceiptCheck[] {
  const out: ReceiptCheck[] = [];
  const src = stripFences(draft);
  for (const m of src.matchAll(RECEIPT_LINE)) {
    const kind = m[1] === "MIND✓" ? "mind" : "surface";
    const id = "c" + m[2];
    const rec = calls.find((c) => c.receiptId === id);
    let why: string | undefined;
    if (!rec) why = `#${id} is not a call from this turn`;
    else if (rec.receipt !== kind) why = `#${id} is a ${rec.receipt ?? "non-receipt"} call, not ${kind}`;
    else if (!rec.result.ok) why = `#${id} failed`;
    out.push({ line: m[0], id, kind, valid: why === undefined, why });
  }
  return out;
}

// The MIND a call asked: its `mind` argument, or the session's own MIND (the empty string).
function tenantOf(c: CallRecord): string {
  const m = c.call.args.mind;
  return typeof m === "string" ? m.trim().toLowerCase() : "";
}

// Query text WITH the tenant: the same sentence asked of two different MINDs is two different queries.
function queryText(c: CallRecord): string {
  const a = c.call.args;
  const q = a.query ?? a.question ?? a.q ?? a.search;
  const raw = typeof q === "string" ? q : JSON.stringify(a);
  return `${tenantOf(c)}|${raw.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

// Negative claims need, on EACH tenant the turn queried, >= 2 successful mind calls with different query text,
// or one call with list_bare:true on that tenant. (The roster tool is not evidence about any MIND's content.)
export function negativeEvidenceOk(calls: CallRecord[]): boolean {
  const ok = calls.filter((c) => c.result.ok && c.tool !== "mind_tenants");
  const bare = new Set(ok.filter((c) => c.call.args.list_bare === true).map(tenantOf));
  const perTenant = new Map<string, Set<string>>();
  for (const c of ok.filter((x) => x.receipt === "mind")) {
    const t = tenantOf(c);
    if (!perTenant.has(t)) perTenant.set(t, new Set());
    perTenant.get(t)!.add(queryText(c));
  }
  for (const t of bare) if (!perTenant.has(t)) perTenant.set(t, new Set());
  if (perTenant.size === 0) return false;
  for (const [t, qs] of perTenant) if (!bare.has(t) && qs.size < 2) return false;
  return true;
}

export const receiptGate: Gate = {
  name: "receipt",
  preAnswer(s, draft) {
    const claims = findClaims(draft, { userMessage: s.userMessage, grounded: s.calls.filter((c) => c.result.ok).map((c) => squash(c.result.output)) });
    if (claims.length === 0) return undefined;
    const receipts = validReceipts(draft, s.calls);
    const good = receipts.filter((r) => r.valid);
    const block = (reason: string): GateVerdict => ({ gate: "receipt", action: "block", reason });
    if (good.length === 0) {
      const first = claims[0];
      const bad = receipts.find((r) => !r.valid);
      const badNote = bad ? ` (your receipt ${bad.why})` : "";
      const kind = first.kind === "negative" ? "MIND✓ #cN after querying" : first.kind === "completion" ? "SURFACE✓ #cN" : "MIND✓ #cN or SURFACE✓ #cN";
      return block(`claim '${first.text}' has no valid receipt${badNote}: run a check and cite it as ${kind}`);
    }
    const comp = claims.find((c) => c.kind === "completion");
    if (comp && !good.some((r) => r.kind === "surface")) {
      return block(`claim '${comp.text}' needs a SURFACE✓ #cN receipt (a MIND✓ receipt does not prove it is done): open the real surface and cite it`);
    }
    const neg = claims.find((c) => c.kind === "negative");
    if (neg && !negativeEvidenceOk(s.calls)) {
      return block(`negative claim '${neg.text}' needs 2 differently worded mind_query calls (or one list with list_bare:true) this turn: query again with other wording`);
    }
    return undefined;
  },
};
