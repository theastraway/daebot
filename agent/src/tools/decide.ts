// decide: ask OpenRouter's decisions API to choose between named options and report how sure it is.
// Read-only: it changes nothing anywhere. It is advice for the model to weigh, never an instruction:
// the Decision Protocol in the system prompt says a result never overrides the user or a kernel gate.
//
// Billing (TODO, DAEBOT_BILLING=mind): MIND's proxy only covers chat completions, so this calls the decisions
// API with the server's own OPENROUTER_API_KEY and reports the cost in result.meta.costUsd (the loop adds it to
// the turn's usage). Once MIND proxies /api/alpha/decisions, send it through the user's MIND key instead.
import type { Tool } from "../types.ts";
import { errMsg, fail, ok } from "./util.ts";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const DECISION_MODELS = { jev: "typesafe/jev-1.13", decider: "perplexity/pplx-decider-v1.1-27b" } as const;
type ModelKey = keyof typeof DECISION_MODELS;

const TIMEOUT_MS = 30_000;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 12;
const QUESTION = "decision";
const CONTEXT_CAP = 20_000;

export interface DecideOptions {
  fetchImpl?: typeof fetch;
  /** OpenRouter key, or a getter for it. Never shown to the model or the user. */
  apiKey: string | (() => string);
  url?: string;
  timeoutMs?: number;
}

interface Answer { model: string; choice: string; probabilities: Record<string, number>; confidence: number; costUsd: number; inputTokens: number; outputTokens: number }

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function parseDecision(body: unknown, options: string[]): Answer {
  const b = body as any;
  const a = b?.answers?.[QUESTION];
  if (!a || typeof a.choice !== "string") throw new Error("no choice in the response");
  if (!options.includes(a.choice)) throw new Error(`the model chose '${a.choice.slice(0, 60)}', which is not one of the options`);
  const probabilities: Record<string, number> = {};
  for (const o of options) probabilities[o] = num(a.probabilities?.[o]) ?? 0;
  return {
    model: typeof b?.model === "string" ? b.model : "",
    choice: a.choice,
    probabilities,
    confidence: num(a.confidence) ?? probabilities[a.choice] ?? 0,
    costUsd: Math.max(0, num(b?.usage?.cost) ?? 0),
    inputTokens: num(b?.usage?.input_tokens) ?? 0,
    outputTokens: num(b?.usage?.output_tokens) ?? 0,
  };
}

function cleanOptions(raw: unknown): Record<string, string> | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "decide: options must be an object of {option name: definition}";
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = k.trim();
    if (!name || typeof v !== "string" || !v.trim()) return `decide: option '${k.slice(0, 40)}' needs a non-empty definition string`;
    out[name] = v.trim();
  }
  const n = Object.keys(out).length;
  if (n < MIN_OPTIONS) return `decide: give at least ${MIN_OPTIONS} options (a decision with one option is not a decision)`;
  if (n > MAX_OPTIONS) return `decide: at most ${MAX_OPTIONS} options`;
  return out;
}

export function createDecideTool(opts: DecideOptions): Tool {
  const doFetch: typeof fetch = opts.fetchImpl ?? ((...a) => fetch(...a));
  const url = opts.url ?? DECISIONS_URL;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const key = (): string => (typeof opts.apiKey === "function" ? opts.apiKey() : opts.apiKey) ?? "";

  // Errors may echo request details; never let the key through.
  function scrub(s: string): string {
    const k = key();
    let out = k ? s.split(k).join("[key]") : s;
    out = out.replace(/sk-or-[A-Za-z0-9_-]{8,}/g, "[key]");
    return out.replace(/\s+/g, " ").slice(0, 160);
  }

  async function call(model: string, question: string, criteria: Record<string, string>, state: Record<string, unknown>, signal?: AbortSignal): Promise<Answer> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ model, state, questions: { [QUESTION]: { type: "choice", instructions: question, criteria } } }),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new Error(ctrl.signal.aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `network error (${scrub(String((e as Error)?.message ?? e)).slice(0, 80)})`);
      }
      const text = await res.text();
      if (!res.ok) {
        let detail = "";
        try { const j = JSON.parse(text); const d = j?.error?.message ?? j?.error ?? j?.message; detail = typeof d === "string" ? d : ""; } catch { detail = ""; }
        throw new Error(`HTTP ${res.status}${detail ? ` ${scrub(detail)}` : ""}`);
      }
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new Error("response was not JSON"); }
      return parseDecision(body, Object.keys(criteria));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    class: "read", // advice only: no outward or irreversible effect, so staff and admin identities may both use it
    spec: {
      name: "decide",
      description:
        "Ask a decision model to choose one option and report probabilities and confidence. Use it inside the Decision Protocol when judgment is close, or to calibrate confidence. " +
        "Advice, not authority: it never overrides an explicit user instruction or a kernel gate. State the confidence plainly. Costs a fraction of a cent.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The decision, as a full sentence, with the user's aim stated" },
          options: { type: "object", description: "Option name -> definition (2 to 12). Definitions say what choosing it means.", additionalProperties: { type: "string" } },
          context: { type: "object", description: "Facts the decision turns on (constraints, numbers, evidence, deadlines)", additionalProperties: true },
          model: { type: "string", enum: ["jev", "decider"], description: "jev (default) or decider. The other one is the automatic fallback." },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) return fail("decide: question is required");
      const criteria = cleanOptions(args.options);
      if (typeof criteria === "string") return fail(criteria);
      const context = args.context ?? {};
      if (typeof context !== "object" || Array.isArray(context) || context === null) return fail("decide: context must be an object");
      if (JSON.stringify(context).length > CONTEXT_CAP) return fail(`decide: context is over ${CONTEXT_CAP} characters; send the facts that matter`);
      const first: ModelKey = args.model === "decider" ? "decider" : "jev";
      if (args.model !== undefined && args.model !== "jev" && args.model !== "decider") return fail("decide: model must be 'jev' or 'decider'");
      if (!key()) return fail("decide: no decision provider key is configured on this server");

      const order: ModelKey[] = [first, first === "jev" ? "decider" : "jev"];
      const errors: string[] = [];
      let spent = 0;
      for (const m of order) {
        try {
          const a = await call(DECISION_MODELS[m], question, criteria, context as Record<string, unknown>, ctx.signal);
          spent += a.costUsd;
          const ranked = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).map(([o, p]) => `  ${o}: ${(p * 100).toFixed(0)}%`);
          const out = [
            `choice: ${a.choice}`,
            `confidence: ${(a.confidence * 100).toFixed(0)}%`,
            "probabilities:",
            ...ranked,
            `model: ${a.model || DECISION_MODELS[m]}${errors.length ? ` (fallback after ${errors[0]})` : ""}`,
            "Advice only. It does not override the user's instruction or a kernel gate.",
          ].join("\n");
          return ok(out, {
            costUsd: spent, inputTokens: a.inputTokens, outputTokens: a.outputTokens, model: a.model || DECISION_MODELS[m],
            choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, fellBack: errors.length > 0,
          });
        } catch (e) {
          if (ctx.signal?.aborted) return fail("decide: aborted");
          errors.push(`${m}: ${errMsg(e)}`);
        }
      }
      return fail(`decide: could not get a decision (${errors.join("; ")}). Decide with the protocol alone and say no model was consulted.`);
    },
  };
}
