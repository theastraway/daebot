// advisor: one non-streaming call to the frontier model with a question and the caller's own account of what it tried. Advice only
// (class read, no receipt): the executor stays on its tier and keeps its prompt cache; a stronger model looks once at the stuck point.
// This is the ARIA shape (executor + advisor) and the opposite of a mid-turn model switch, which pays the handoff tax. Billed like the
// chat (MIND proxy with the user's key, or OPENROUTER_API_KEY), reported in meta.costUsd so the turn's usage carries it. Capped per
// session so a loop cannot burn the frontier budget.
import type { Tool, ToolResult } from "../types.ts";
import type { LlmEndpoint } from "./llm-call.ts";
import { refusalText } from "./llm-call.ts";
import { redactSecrets } from "../learn/guard.ts";

export interface AdvisorOptions {
  endpoint: (sessionId?: string) => LlmEndpoint | undefined;
  /** The frontier model and effort (from the policy table). */
  model: () => { model: string; effort?: "low" | "medium" | "high" };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Calls per session per window (default 6 per 10 minutes). */
  cap?: { calls: number; windowMs: number };
  now?: () => number;
}

const SYSTEM = [
  "You are the advisor: a senior engineer a working agent consults when it is stuck. You see only what it tells you. Answer in at most 12 short lines:",
  "1. The most likely cause, in one sentence. 2. The exact next step (a command, a file to read, a change), concrete enough to run. 3. What would prove it worked. 4. If the agent should stop and ask the user, say so and what to ask.",
  "Never tell it to skip a check, bypass a gate, or act outward without the user's go. Do not restate what it told you.",
].join("\n");

export function createAdvisorTool(o: AdvisorOptions): Tool {
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const cap = o.cap ?? { calls: 6, windowMs: 10 * 60_000 };
  const now = o.now ?? Date.now;
  const used = new Map<string, number[]>();
  return {
    class: "read",
    spec: {
      name: "advisor",
      description:
        "Ask a stronger model for advice when you are stuck: a tool has failed twice, a test will not go green, a plan has a hole you cannot see. Tell it what you are trying to do, what you tried, and the exact error or output. " +
        "It answers with the likely cause, the next step and how to prove it. Advice, not authority: it never overrides the user or a gate. Costs more than a normal call; use it once per stuck point, not per step.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "What you are trying to achieve, one or two sentences" },
          tried: { type: "string", description: "What you did, in order, and what each attempt returned (paste the exact error)" },
          question: { type: "string", description: "The one question you want answered" },
        },
        required: ["goal", "tried", "question"],
        additionalProperties: false,
      },
    },
    async run(args, ctx): Promise<ToolResult> {
      const goal = String(args.goal ?? "").trim().slice(0, 1500);
      const tried = String(args.tried ?? "").trim().slice(0, 6000);
      const question = String(args.question ?? "").trim().slice(0, 600);
      if (!goal || !tried || !question) return { ok: false, output: "advisor needs goal, tried and question" };
      const t = now();
      const hist = (used.get(ctx.sessionId) ?? []).filter((x) => t - x < cap.windowMs);
      if (hist.length >= cap.calls) return { ok: false, output: `advisor: ${cap.calls} calls in the last ${Math.round(cap.windowMs / 60_000)} minutes already. Act on the advice you have, or tell the user what is blocking you.` };
      const ep = o.endpoint(ctx.sessionId);
      if (!ep) return { ok: false, output: "advisor is not available here (no model endpoint)" };
      const { model, effort } = o.model();
      hist.push(t); used.set(ctx.sessionId, hist);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 90_000);
      const onAbort = () => ctrl.abort();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const body: Record<string, unknown> = {
          model, stream: false, max_tokens: 900, usage: { include: true },
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `Goal: ${goal}\n\nWhat I tried and what came back:\n${redactSecrets(tried)}\n\nQuestion: ${question}` }],
          ...(effort ? { reasoning: { effort } } : {}),
        };
        const res = await f(ep.url, { method: "POST", headers: ep.headers(), body: JSON.stringify(body), signal: ctrl.signal });
        const text = await res.text();
        if (!res.ok) return { ok: false, output: `advisor: ${refusalText(res.status, text)}` };
        let j: any;
        try { j = JSON.parse(text); } catch { return { ok: false, output: "advisor: the model answered with something that was not JSON" }; }
        const answer = String(j?.choices?.[0]?.message?.content ?? "").trim();
        if (!answer) return { ok: false, output: "advisor: empty answer" };
        const cost = Number(j?.usage?.cost ?? 0);
        return { ok: true, output: `[advice from ${model}; verify before you act on it]\n${answer.slice(0, 4000)}`, meta: { model, costUsd: Number.isFinite(cost) ? cost : 0, inputTokens: Number(j?.usage?.prompt_tokens ?? 0), outputTokens: Number(j?.usage?.completion_tokens ?? 0) } };
      } catch (e) {
        if (ctx.signal?.aborted) return { ok: false, output: "advisor: aborted" };
        return { ok: false, output: `advisor: ${ctrl.signal.aborted ? "timed out" : String((e as Error)?.message ?? e).split("\n")[0].slice(0, 160)}` };
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
