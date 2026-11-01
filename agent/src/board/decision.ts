// task_decision: the built-in decision skill (OOC/EMR). When a task needs a choice, the model records the decision with this tool BEFORE it acts:
// outcomes ranked, at least four options with consequences and a score, the winner, the mitigations, one resolve sentence and the winner's
// cost in dollars. It is filed as a PRIVATE MIND document (never the public feed) in the user's own MIND, and the receipt id is attached to the
// task so its card on the board shows "Decision" with the winner and a link that opens the document.
import type { Tool } from "../types.ts";
import { decisionTitle } from "../mind/tools.ts";
import type { BoardDecision, BoardIO, BoardMind, BoardTask } from "./board.ts";

const MIN_OPTIONS = 4;
const MAX_OPTIONS = 9;
const clip = (v: unknown, n: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const strList = (v: unknown, max: number, each: number): string[] => (Array.isArray(v) ? v.map((x) => clip(typeof x === "string" ? x : JSON.stringify(x), each)).filter(Boolean).slice(0, max) : []);

export interface DecisionInput {
  subject: string; outcomes: string[]; options: Array<{ name: string; consequences: string; score: number }>;
  winner: string; mitigations: string[]; resolve: string; cost: string;
}

export function checkDecision(a: Record<string, unknown>): { ok: true; value: DecisionInput } | { ok: false; error: string } {
  const subject = clip(a.subject, 80);
  if (!subject) return { ok: false, error: "subject is required (what is being decided, a few words)" };
  const outcomes = strList(a.outcomes, 7, 200);
  if (!outcomes.length) return { ok: false, error: "outcomes is required: what the user wants, ranked, the aim first" };
  const rawOpts = Array.isArray(a.options) ? a.options : [];
  if (rawOpts.length < MIN_OPTIONS) return { ok: false, error: `options needs at least ${MIN_OPTIONS} real options (status quo, the obvious one, the opposite, a hybrid, a long shot). Two options is a false binary.` };
  const options: DecisionInput["options"] = [];
  for (const o of rawOpts.slice(0, MAX_OPTIONS)) {
    const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
    const name = clip(r.name, 120), consequences = clip(r.consequences, 500), score = Number(r.score);
    if (!name || !consequences || !Number.isFinite(score) || score < 0 || score > 10) return { ok: false, error: "each option needs name, consequences (upsides and downsides) and score (a number from 0 to 10)" };
    if (options.some((x) => x.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `duplicate option ${JSON.stringify(name)}` };
    options.push({ name, consequences, score });
  }
  const winner = clip(a.winner, 120);
  const w = options.find((x) => x.name.toLowerCase() === winner.toLowerCase());
  if (!w) return { ok: false, error: "winner must be the name of one of the options" };
  const best = Math.max(...options.map((x) => x.score));
  if (w.score < best) return { ok: false, error: `the winner scored ${w.score} but another option scored ${best}. The highest score wins; if judgment overrides a near-tie, raise the winner's score and say why in its consequences.` };
  const mitigations = strList(a.mitigations, 8, 300);
  if (!mitigations.length) return { ok: false, error: "mitigations is required: one countermeasure per downside of the winner, or state the price" };
  const resolve = clip(a.resolve, 500);
  if (!resolve) return { ok: false, error: "resolve is required: the one decision sentence, the sequenced plan and an owner for each step" };
  const cost = clip(a.cost, 120);
  if (!cost) return { ok: false, error: "cost is required: the winner's cost in dollars (\"$0, no spend\" when there is none)" };
  return { ok: true, value: { subject, outcomes, options, winner: w.name, mitigations, resolve, cost } };
}

export function renderTaskDecision(d: DecisionInput, date: string, task?: { id: string; title: string; project?: string; scope?: string }): string {
  const ranked = [...d.options].sort((a, b) => b.score - a.score);
  return [
    `# Decision: ${d.subject}`,
    `Date: ${date}`,
    ...(task ? [`Task: ${task.title}${task.project ? ` (project ${task.project}${task.scope ? `, ${task.scope === "astra" ? "Astra AI" : "MIND"}` : ""})` : ""}`] : []),
    "",
    "## Outcomes, ranked (first is the aim)",
    ...d.outcomes.map((o, i) => `${i + 1}. ${o}`),
    "",
    "## Options, consequences and score out of 10",
    ...ranked.map((o) => `- ${o.name} (${o.score}/10): ${o.consequences}`),
    "",
    "## Winner",
    `${d.winner}. Cost: ${d.cost}.`,
    "",
    "## Mitigations",
    ...d.mitigations.map((m) => `- ${m}`),
    "",
    "## Resolve",
    d.resolve,
  ].join("\n");
}

const todayET = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export interface DecisionToolDeps {
  /** The user's MIND (or the bot's MIND) the document is filed in. */
  mind: BoardMind;
  /** The board of the session, so the receipt can be attached to a task. Absent = the document is filed and the receipt returned. */
  board?: Pick<BoardIO, "get" | "set">;
}

export function createTaskDecisionTool(deps: DecisionToolDeps): Tool {
  return {
    spec: {
      name: "task_decision",
      description:
        "The decision skill (OOC/EMR). Use it when a task needs a CHOICE: reasonable people could pick differently, it costs money, or it reaches someone outside. Run the Decision Protocol, then record it here BEFORE you act. " +
        "Needs: subject, outcomes (ranked, the user's aim first), options (at least 4, each with name, consequences and a score from 0 to 10), winner (one of the options, the highest score), mitigations, resolve (the one decision sentence with the plan and an owner per step) and cost (the winner's cost in dollars). " +
        "It files a PRIVATE MIND document and, when you pass task_id (a task on the board), attaches the receipt so the task card shows Decision with the winner and a link. Not for routine work with no real choice. It never replaces the user's yes on a spend or an outward action.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "the board task this decision belongs to (declare the task first with task_board)" },
          subject: { type: "string", description: "what is being decided, a few words" },
          outcomes: { type: "array", items: { type: "string" }, description: "what the user wants, ranked; the first is the aim" },
          options: {
            type: "array", description: "at least 4: status quo, the obvious option, the opposite, a hybrid, a long shot",
            items: { type: "object", properties: { name: { type: "string" }, consequences: { type: "string", description: "upsides and downsides, with evidence" }, score: { type: "number", description: "0 to 10 against the outcomes" } }, required: ["name", "consequences", "score"], additionalProperties: false },
          },
          winner: { type: "string", description: "the name of the winning option (highest score)" },
          mitigations: { type: "array", items: { type: "string" }, description: "one countermeasure per downside of the winner" },
          resolve: { type: "string", description: "the one decision sentence, the sequenced plan, an owner per step" },
          cost: { type: "string", description: "the winner's cost in dollars, e.g. \"$0, no spend\"" },
        },
        required: ["subject", "outcomes", "options", "winner", "mitigations", "resolve", "cost"],
        additionalProperties: false,
      },
    },
    class: "write", // a private document in the user's own MIND and a field on this chat's own board
    async run(args, ctx) {
      if (ctx.origin === "bot") return { ok: false, output: "blocked: a message from another bot cannot file a decision for the user's task." };
      const c = checkDecision(args);
      if (!c.ok) return { ok: false, output: `task_decision: ${c.error}` };
      const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
      const tasks = deps.board?.get(ctx.sessionId) ?? [];
      const task: BoardTask | undefined = taskId ? tasks.find((t) => t.id === taskId) : undefined;
      if (taskId && !task) return { ok: false, output: `task_decision: no task ${JSON.stringify(taskId)} on the board. Declare it with task_board first, or leave task_id out to just file the decision.` };
      if (task?.status === "cancelled") return { ok: false, output: `task_decision: task ${taskId} was cancelled.` };
      const date = todayET();
      const saved = await deps.mind.saveDecision(decisionTitle(c.value.subject, date), renderTaskDecision(c.value, date, task && { id: task.id, title: task.title, project: task.project?.name, scope: task.scope }));
      const decision: BoardDecision = { id: saved.id, subject: c.value.subject, winner: c.value.winner, ...(saved.local ? { local: true } : {}) };
      if (task) deps.board!.set(ctx.sessionId, tasks.map((t) => (t.id === taskId ? { ...t, decision, updatedAt: Date.now() } : t)));
      const where = saved.local ? "NOT saved to MIND (it was unreachable); local receipt" : "Filed as a private MIND document";
      return { ok: true, output: `${where}: ${decision.id}. Winner: ${decision.winner}.${task ? ` Attached to task ${taskId}; its card now shows Decision.` : " No task attached."}`, meta: { decisionId: decision.id, subject: decision.subject, ...(saved.local ? { local: true } : {}) } };
    },
  };
}
