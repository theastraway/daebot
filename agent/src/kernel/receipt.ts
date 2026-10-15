import type { CallRecord, Gate, GateVerdict } from "../types.ts";

export type ClaimKind = "completion" | "negative" | "fact";
export interface Claim { kind: ClaimKind; text: string }
export interface ReceiptCheck { line: string; id: string; kind: "mind" | "surface"; valid: boolean; why?: string }

// "complete"/"operational" only count as claims in status form ("is complete", "fully operational"), not as ordinary adjectives.
const COMPLETION = /\b(done|built|shipped|live(?!\s+(?:in|with|on|at|from)\b)|deployed|merged|working(?!\s+(?:on|with|through|towards|from)\b)|fixed|ready(?!\s+to\b)|(?<!\b(?:no|any|not|without)\s)verified|passing|completed|launched|finished|(?:is|are|was|were|now|fully|been)\s+complete|(?:is|are|now|fully|be|been)\s+operational)\b/i;
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
const RECEIPT_LINE = /^(MIND✓|SURFACE✓) #c(\d+)\b.*$/gm;

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
  t = t.replace(/^(MIND✓|SURFACE✓).*$/gm, " ");
  t = t.replace(/"[^"\n]{0,300}"/g, " ").replace(/“[^”\n]{0,300}”/g, " ");
  return t;
}

function squash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

// opts.userMessage: a fact that appears in the latest user message is exempt only when the same sentence
// carries attribution ("you said", "per your message", ...). An unattributed echo is still a claim.
export function findClaims(draft: string, opts: { userMessage?: string } = {}): Claim[] {
  const claims: Claim[] = [];
  const text = claimText(draft);
  const userText = squash(normApos(opts.userMessage ?? ""));
  for (const line of text.split("\n")) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const sent = sentence.trim();
      if (!sent || sent.endsWith("?")) continue;
      const neg = NEGATIVE.exec(sent);
      if (neg) claims.push({ kind: "negative", text: neg[1] });
      const comp = COMPLETION.exec(sent);
      if (comp) claims.push({ kind: "completion", text: comp[1].toLowerCase() });
      for (const re of FACT_PATTERNS) {
        const m = re.exec(sent);
        if (!m) continue;
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

function queryText(c: CallRecord): string {
  const a = c.call.args;
  const q = a.query ?? a.question ?? a.q ?? a.search;
  const raw = typeof q === "string" ? q : JSON.stringify(a);
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

// Negative claims need >= 2 successful mind calls with different query text, or one call with list_bare:true.
export function negativeEvidenceOk(calls: CallRecord[]): boolean {
  const ok = calls.filter((c) => c.result.ok);
  if (ok.some((c) => c.call.args.list_bare === true)) return true;
  const queries = new Set(ok.filter((c) => c.receipt === "mind").map(queryText));
  return queries.size >= 2;
}

export const receiptGate: Gate = {
  name: "receipt",
  preAnswer(s, draft) {
    const claims = findClaims(draft, { userMessage: s.userMessage });
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
