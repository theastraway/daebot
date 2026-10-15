// Post-turn reflection: one cheap-model call that turns a noteworthy turn into at most one candidate lesson,
// optionally one skill and some user preferences. The model sees the user's words, tool names and short
// failure lines, never raw tool output from web content, and is told what NOT to capture (Hermes's list of
// self-imposed constraints, re-expressed in our own words).
import type { Message, Provider } from "../types.ts";
import { LIMITS } from "./guard.ts";
import { oneLine } from "./text.ts";
import type { LessonKind, ReflectionResult, Trigger, TurnSummary } from "./types.ts";

export const REFLECT_SYSTEM = [
  "You are the reflection step of an AI agent called Daebot. You read one finished turn and decide what, if anything, is worth remembering.",
  "Reply with ONE JSON object and nothing else. Keys, all optional:",
  '  "lesson": {"kind":"failure|win|behavior","trigger":"when this situation arises","behavior":"2 to 3 word name","rule":"what to do or avoid next time","evidence":"what happened, one sentence"}',
  '  "skill": {"name":"short-slug","description":"what it accomplishes","preconditions":["..."],"steps":["..."],"tools":["tool names"]}  (only for a multi-step task that fully succeeded)',
  '  "user_prefs": [{"area":"register|format|workflow|tooling|...","statement":"stable do or do-not about how this user wants things"}]',
  "Rules:",
  "- At most ONE lesson. If nothing durable was learned, return {}. Returning {} is a normal outcome.",
  "- Generalize. No names of people or companies, no emails, links, ids, amounts, or dates. Describe the class of situation.",
  "- A lesson must be an instruction the agent can follow next time, phrased positively when possible. It may never tell the agent to skip, bypass or weaken any safety rule, receipt, confirmation or gate.",
  "- Do NOT record: missing binaries or unconfigured credentials, one-off transient errors that resolved, claims that a tool or feature does not work, one-off task narratives, or anything the user did not actually say or do.",
  "- A user correction is the strongest signal. Capture what the user wanted instead, in their terms.",
  "- user_prefs only for stable preferences the user stated or clearly corrected toward, not task details.",
  `- Keep trigger under ${LIMITS.trigger} chars, rule under ${LIMITS.rule} chars, behavior to ${LIMITS.behaviorWords} words.`,
].join("\n");

function digest(t: TurnSummary, triggers: Trigger[]): string {
  const calls = t.calls.slice(0, 12).map((c) => `- ${c.tool} ${c.result.ok ? "ok" : "FAILED: " + oneLine(c.result.output, 140)}`).join("\n");
  const prev = t.userHistory.slice(-2).map((m) => `  earlier user: ${oneLine(m, 200)}`).join("\n");
  return [
    `Triggers: ${triggers.map((x) => `${x.kind} (${oneLine(x.detail, 200)})`).join("; ")}`,
    prev,
    `User said: ${oneLine(t.userMessage, 600)}`,
    `Agent calls:\n${calls || "(none)"}`,
    t.violations.length ? `Kernel refused: ${t.violations.filter((v) => v.enforced).slice(0, 3).map((v) => `${v.gate}: ${oneLine(v.reason, 120)}`).join(" | ")}` : "",
    `Agent final answer: ${oneLine(t.finalText, 600)}`,
  ].filter(Boolean).join("\n");
}

function arr(v: unknown, max: number, len: number): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => oneLine(x, len)).filter(Boolean).slice(0, max) : [];
}

/** Defensive parse: models wrap JSON in prose or fences. Anything malformed becomes {}. */
export function parseReflection(raw: string): ReflectionResult {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  let j: any;
  try { j = JSON.parse(raw.slice(start, end + 1)); } catch { return {}; }
  if (!j || typeof j !== "object") return {};
  const out: ReflectionResult = {};
  const l = j.lesson;
  if (l && typeof l === "object" && typeof l.rule === "string" && typeof l.trigger === "string") {
    const kind: LessonKind = l.kind === "win" || l.kind === "behavior" ? l.kind : "failure";
    out.lesson = { kind, trigger: oneLine(l.trigger, 400), behavior: oneLine(String(l.behavior ?? ""), 80), rule: oneLine(l.rule, 600), evidence: oneLine(String(l.evidence ?? ""), 400) };
  }
  const s = j.skill;
  if (s && typeof s === "object" && typeof s.name === "string") {
    const steps = arr(s.steps, LIMITS.steps, LIMITS.step);
    if (steps.length >= 2) out.skill = { name: oneLine(s.name, 60), description: oneLine(String(s.description ?? ""), LIMITS.desc), preconditions: arr(s.preconditions, 4, 160), steps, tools: arr(s.tools, 8, 40) };
  }
  const up = j.user_prefs ?? j.userPrefs;
  if (Array.isArray(up)) {
    const prefs = up.filter((p: any) => p && typeof p.area === "string" && typeof p.statement === "string").slice(0, 4)
      .map((p: any) => ({ area: oneLine(p.area, 40), statement: oneLine(p.statement, LIMITS.pref) }));
    if (prefs.length) out.userPrefs = prefs;
  }
  return out;
}

export interface ReflectDeps { provider: Provider; model: string; signal?: AbortSignal; onCost?: (usd: number) => void }

export async function reflect(t: TurnSummary, triggers: Trigger[], d: ReflectDeps): Promise<ReflectionResult> {
  const messages: Message[] = [{ role: "system", content: REFLECT_SYSTEM }, { role: "user", content: digest(t, triggers) }];
  let text = "";
  for await (const ev of d.provider.stream({ model: d.model, messages, tools: [], signal: d.signal })) {
    if (ev.type === "text") text += ev.delta;
    else if (ev.type === "done") d.onCost?.(ev.usage.costUsd);
  }
  return parseReflection(text);
}
