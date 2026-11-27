// loop: run it until it is a 9/10. The MIND /loop (MINDloop's engine) inside Daebot: study, build, check, grade against a rubric
// like a tough editor, attack the weakest category, and go again until the work clears the bar or the cycles run out.
//   - study: the first cycle starts from MIND: earlier loop wins that match the goal (tag daebot-loop-win) and what MIND knows.
//   - build: a helper does the work. mode "build" edits code in ONE git worktree that carries over from cycle to cycle (the branch
//     is the result); mode "write" produces a text artifact (a plan, a spec, a document, a prompt) as the helper's report.
//   - check + grade: a separate read-only grader helper runs the checks it can and scores every rubric category 0-10 as JSON.
//   - score: weakest-governed (0.7 x weakest + 0.3 x mean), the Rate-9 rule: work is only as good as its worst part.
//   - remember: a cleared loop files a win in MIND so the next loop on a similar goal starts from it.
// Helpers come from the same spawn as delegate (same MIND boot, same kernel); everything is recorded live in the HelperHub.
import type { MindClient, Tool, ToolResult } from "../types.ts";
import { done, failed } from "../tools/contract.ts";
import { MIND_RECALL_HEADER, withOriginTag } from "../mind/origin.ts";
import { screenUntrustedText, withScreenNotice } from "../tools/text-screen.ts";
import { redactSecrets } from "../learn/guard.ts";
import { runHelpers, type HelperOutcome, type HelperTask, type SpawnHelper } from "./delegate.ts";
import type { HelperHub } from "./hub.ts";
import type { Worktree, WorktreeOps } from "./worktree.ts";

export const DEFAULT_BAR = 9;
export const MAX_CYCLES = 6;

/** The universal rubric library (a slice of MINDloop's), picked by what the goal is about. */
const LIBRARY: { key: string; when: RegExp; what: string }[] = [
  { key: "correctness", when: /./, what: "it does what the goal asks, with no errors or false claims" },
  { key: "completeness", when: /./, what: "nothing the goal asks for is missing or left as a placeholder" },
  { key: "verification", when: /\b(code|build|fix|bug|test|feature|api|app|script|function|endpoint|refactor|implement|tool)\b/i, what: "the checks were run (tests, type check, a fetch) and passed; the proof is shown" },
  { key: "robustness", when: /\b(code|build|fix|api|app|script|function|endpoint|service|tool|agent|bot|workflow|pipeline)\b/i, what: "edge cases, errors and bad input are handled" },
  { key: "security", when: /\b(auth|login|password|token|key|secret|payment|user data|permission|api|endpoint|upload)\b/i, what: "no secret leaks, no injection, least privilege" },
  { key: "design polish", when: /\b(ui|ux|page|screen|design|landing|studio|dashboard|css|layout|premium|brand)\b/i, what: "looks professional and consistent; spacing, type, states and mobile are right" },
  { key: "clarity", when: /\b(doc|docs|write|spec|plan|prompt|email|post|readme|guide|report|copy|instructions)\b/i, what: "plain, specific, easy to act on" },
  { key: "evidence", when: /\b(research|compare|market|analysis|decide|options|report|data)\b/i, what: "every claim names its source" },
  { key: "learning", when: /\b(agent|bot|workflow|loop|routine|automation|learn)\b/i, what: "it records what it learns in MIND and the next run starts smarter" },
];

/** "/loop <goal>" (typed in any surface) becomes the instruction the model acts on: run the loop tool on that goal. Anything else is unchanged. */
export function expandLoopCommand(text: string): string {
  const m = /^\s*\/loop(?:\s+([\s\S]*))?$/i.exec(String(text ?? ""));
  if (!m) return text;
  const goal = (m[1] ?? "").trim();
  if (!goal) return "The user typed /loop with no goal. Explain in two lines what /loop does (study, build, check, grade against a rubric, fix the weakest part, repeat until it clears 9/10, remember the win in MIND) and ask for the goal.";
  const build = /\b(code|build|fix|implement|refactor|feature|bug|test|app|page|api)\b/i.test(goal);
  return `/loop ${goal}\n\n[The user ran /loop. Call the loop tool now with this goal${build ? ' (mode "build" if this session can build; otherwise "write")' : ""}, then report the cycles, the final score and what to review. Goal: ${goal}]`;
}

export function suggestRubric(goal: string, max = 6): string[] {
  return LIBRARY.filter((c) => c.when.test(goal)).slice(0, max).map((c) => c.key);
}

/** Weakest-governed score: 0.7 x the weakest category + 0.3 x the mean. */
export function overallScore(scores: Record<string, number>): number {
  const v = Object.values(scores).filter((x) => Number.isFinite(x));
  if (!v.length) return 0;
  const min = Math.min(...v), mean = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.round((0.7 * min + 0.3 * mean) * 10) / 10;
}

export interface Grade { scores: Record<string, number>; weakest: string; notes: string; checks?: string }

/** Balanced {...} spans, last-starting first (string-aware), so code quoted before the grader's JSON does not hide it. */
function jsonObjectsFromEnd(text: string): string[] {
  const out: string[] = [];
  for (let i = text.lastIndexOf("{"); i >= 0 && out.length < 50; i = i > 0 ? text.lastIndexOf("{", i - 1) : -1) {
    let depth = 0, inStr = false, esc = false;
    for (let k = i; k < text.length; k++) {
      const c = text[k];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { out.push(text.slice(i, k + 1)); break; }
    }
  }
  return out;
}

/** Reads the grader's JSON (the last {...} block that parses), keeps only rubric keys, clamps to 0-10. A missing key scores 0. */
export function parseGrade(text: string, rubric: readonly string[]): Grade | undefined {
  let j: any;
  for (const b of jsonObjectsFromEnd(String(text ?? ""))) {
    try { const v = JSON.parse(b); if (v && typeof v === "object" && v.scores && typeof v.scores === "object") { j = v; break; } } catch { /* try the next */ }
  }
  if (!j || typeof j !== "object" || typeof j.scores !== "object" || !j.scores) return undefined;
  const scores: Record<string, number> = {};
  const lower = new Map(Object.entries(j.scores as Record<string, unknown>).map(([k, v]) => [k.trim().toLowerCase(), Number(v)]));
  for (const k of rubric) { const v = lower.get(k.toLowerCase()); scores[k] = Number.isFinite(v) ? Math.max(0, Math.min(10, v as number)) : 0; }
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0]?.[0] ?? rubric[0];
  return { scores, weakest, notes: String(j.notes ?? j.feedback ?? "").slice(0, 3000), ...(j.checks ? { checks: String(j.checks).slice(0, 600) } : {}) };
}

export interface LoopOptions {
  spawn: SpawnHelper;
  worktrees?: WorktreeOps;
  hub?: HelperHub;
  mind?: () => MindClient | undefined;
  /** Per helper (default 6 minutes; build helpers get twice that). */
  timeoutMs?: number;
  recallMs?: number;
}

const one = (s: unknown, n: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n… (cut)` : s);

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<undefined>((r) => { t = setTimeout(() => r(undefined), ms); })]); } catch { return undefined; } finally { if (t) clearTimeout(t); }
}

export function builderPrompt(o: { goal: string; rubric: readonly string[]; bar: number; cycle: number; maxCycles: number; mode: "build" | "write"; recall?: string; last?: { grade: Grade; score: number; artifact?: string } }): string {
  const lines = [
    `Loop goal: ${o.goal}`,
    `Cycle ${o.cycle} of ${o.maxCycles}. The work is graded 0-10 on: ${o.rubric.join(", ")}. It must reach ${o.bar}/10, where the score is governed by the weakest category.`,
  ];
  if (o.recall) lines.push("", "Study first. What MIND already knows (earlier wins and notes; use what applies):", o.recall);
  if (o.last) {
    lines.push("", `Last cycle scored ${o.last.score}/10: ${Object.entries(o.last.grade.scores).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
      `Attack the weakest category first: ${o.last.grade.weakest}. The grader said:`, clip(o.last.grade.notes || "(no notes)", 2000));
    if (o.mode === "write" && o.last.artifact) lines.push("", "The current draft (improve it; return the whole new version):", clip(o.last.artifact, 8000));
  }
  lines.push("", o.mode === "build"
    ? "Make the change in your checkout (your edits from earlier cycles are already there), run the checks that prove it, and report what you changed and the check result lines."
    : "Return the complete artifact as your report, ready to use, with no commentary before or after it.");
  return lines.join("\n");
}

export function graderPrompt(o: { goal: string; rubric: readonly string[]; bar: number; mode: "build" | "write"; artifact: string; builderReport?: string }): string {
  return [
    `Grade this work for the goal: ${o.goal}`,
    o.mode === "build" ? "The work is the change in your checkout (read the changed files; run the checks yourself where you can, e.g. the tests named in the report). The builder's report, a claim until you check it:" : "The artifact:",
    clip(o.mode === "build" ? (o.builderReport ?? "") : o.artifact, 10_000),
    "",
    `Score every category 0-10, honestly (a ${o.bar} means you would ship it as is): ${o.rubric.join(", ")}.`,
    "End your reply with ONE JSON object and nothing after it:",
    `{"scores": {${o.rubric.map((k) => `"${k}": 0`).join(", ")}}, "notes": "the concrete fixes, weakest category first", "checks": "the checks you ran and their result lines"}`,
  ].join("\n");
}

export function createLoopTool(o: LoopOptions): Tool {
  const timeoutMs = o.timeoutMs ?? 6 * 60_000;
  const running = new Set<string>();
  return {
    class: "read",
    classFor: (a) => (a.mode === "build" ? "write" : "read"),
    spec: {
      name: "loop",
      description:
        "Run it until it is a 9/10 (the MIND /loop). Give a goal; the loop studies MIND for earlier wins, has a helper do the work, has a separate tough grader check it and score every rubric category 0-10, " +
        "then attacks the weakest category and goes again until the score (governed by the weakest category) clears the bar or the cycles run out. A cleared loop is remembered in MIND so the next one starts smarter. " +
        (o.worktrees ? "mode build: the helper edits code in its own git worktree that carries across cycles; you get the branch to review and merge. " : "") +
        "mode write: the result is a text artifact (plan, spec, document, prompt, workflow). Use it when quality matters more than speed; it takes several minutes.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The outcome, specific enough to grade (what, for whom, what done looks like)" },
          mode: { type: "string", enum: o.worktrees ? ["write", "build"] : ["write"], description: "build = change code in a worktree; write = produce a text artifact (default write)" },
          rubric: { type: "array", items: { type: "string" }, description: "Categories to grade (default: picked from the goal, e.g. correctness, completeness, verification)" },
          bar: { type: "number", description: "Score to clear, 1-10 (default 9)" },
          max_cycles: { type: "number", description: `Cycles at most, 1-${MAX_CYCLES} (default 3)` },
        },
        required: ["goal"],
        additionalProperties: false,
      },
    },
    async run(args, ctx): Promise<ToolResult> {
      if (ctx.origin === "bot") return failed("loop is for turns the person started", { retry: "pointless" });
      const goal = one(args.goal, 1500);
      if (goal.length < 12) return failed("loop needs a goal specific enough to grade (a sentence: what, for whom, what done looks like)", { retry: "pointless" });
      const mode: "build" | "write" = args.mode === "build" ? "build" : "write";
      if (mode === "build" && !o.worktrees) return failed("build loops are not available here (no file tools in this session, or a hosted deployment)", { retry: "pointless", next: "use mode write" });
      if (running.has(ctx.sessionId)) return failed("a loop is already running in this chat", { retry: "pointless", next: "wait for it to finish" });
      const rubric = (Array.isArray(args.rubric) ? args.rubric.map((r) => one(r, 40)).filter(Boolean) : []).slice(0, 8);
      const cats = rubric.length ? [...new Set(rubric)] : suggestRubric(goal);
      const bar = Math.max(1, Math.min(10, Number(args.bar) || DEFAULT_BAR));
      const maxCycles = Math.max(1, Math.min(MAX_CYCLES, Math.round(Number(args.max_cycles) || 3)));
      running.add(ctx.sessionId);
      const lid = o.hub?.startLoop({ session: ctx.sessionId, goal, bar, maxCycles });
      let tree: Worktree | undefined;
      try {
        // study: earlier wins and what MIND knows about the goal.
        let recall: string | undefined;
        const client = o.mind?.();
        if (client) {
          const text = await withTimeout(client.query(`daebot-loop-win ${goal}: earlier loop wins, decisions and lessons for this kind of work`, { maxContextTokens: 1200, signal: ctx.signal }), o.recallMs ?? 8000);
          if (text?.trim()) recall = `${MIND_RECALL_HEADER}\n${withScreenNotice(screenUntrustedText(clip(text.trim(), 3000)))}`;
        }
        if (mode === "build") {
          const wt = o.worktrees!.prepare(ctx.cwd, `loop ${goal}`);
          if ("error" in wt) { if (lid) o.hub?.updateLoop(lid, { phase: "failed" }); return failed(wt.error, { retry: "pointless" }); }
          tree = wt;
          if (lid) o.hub?.updateLoop(lid, { branch: wt.branch });
        }
        // Every helper of a build loop works in the one worktree (the work carries over); the loop itself owns it, so no per-helper worktree.
        const spawnIn: SpawnHelper = tree ? (task, so) => o.spawn(task, { ...so, cwd: tree!.cwd }) : o.spawn;
        const history: { cycle: number; score: number; grade: Grade }[] = [];
        let artifact = "", lastReport = "", cost = 0;
        let last: { grade: Grade; score: number; artifact?: string } | undefined;
        let cleared = false, stopReason = "";
        for (let cycle = 1; cycle <= maxCycles; cycle++) {
          if (ctx.signal?.aborted) { stopReason = "stopped"; break; }
          if (lid) o.hub?.updateLoop(lid, { cycle, phase: "build" });
          const buildTask: HelperTask = { title: `Cycle ${cycle}: ${mode === "build" ? "build" : "draft"}`, kind: mode === "build" ? "build" : "draft", prompt: builderPrompt({ goal, rubric: cats, bar, cycle, maxCycles, mode, recall: cycle === 1 ? recall : undefined, last }) };
          // build-kind helpers normally get their own worktree from runHelpers; here the loop's tree is shared, so no worktrees are passed.
          const [b] = await runHelpers([buildTask], { spawn: spawnIn, hub: o.hub, parallel: 1, timeoutMs, /* runHelpers already doubles the limit for build helpers */ sessionId: ctx.sessionId, cwd: tree?.cwd ?? ctx.cwd, signal: ctx.signal, worktrees: mode === "build" ? sharedTree(tree!) : undefined, loop: lid ? { id: lid, cycle } : undefined });
          cost += b.costUsd || 0;
          if (!b.ok && !b.text.trim()) { stopReason = `the builder did not finish: ${b.error ?? "no report"}`; break; }
          lastReport = b.text;
          if (mode === "write") artifact = b.text.trim();
          if (lid) o.hub?.updateLoop(lid, { phase: "grade" });
          const gradeTask: HelperTask = { title: `Cycle ${cycle}: grade`, kind: "grade", prompt: graderPrompt({ goal, rubric: cats, bar, mode, artifact, builderReport: lastReport }) };
          const [g] = await runHelpers([gradeTask], { spawn: spawnIn, hub: o.hub, parallel: 1, timeoutMs, sessionId: ctx.sessionId, cwd: tree?.cwd ?? ctx.cwd, signal: ctx.signal, loop: lid ? { id: lid, cycle } : undefined });
          cost += g.costUsd || 0;
          const grade = parseGrade(g.text, cats);
          if (!grade) { stopReason = `the grader gave no readable scores${g.error ? ` (${g.error})` : ""}`; break; }
          const score = overallScore(grade.scores);
          history.push({ cycle, score, grade });
          if (lid) o.hub?.updateLoop(lid, { score, weakest: grade.weakest });
          last = { grade, score, artifact };
          if (score >= bar) { cleared = true; break; }
        }
        const best = history.length ? history[history.length - 1] : undefined;
        if (lid) o.hub?.updateLoop(lid, { phase: cleared ? "cleared" : stopReason === "stopped" ? "stopped" : history.length ? "stopped" : "failed" });
        let branch: string | undefined, files: string[] = [];
        if (tree) {
          const fin = o.worktrees!.finish(tree, `Daebot loop: ${goal.slice(0, 120)}`);
          branch = fin.branch; files = fin.files;
          tree = undefined;
          if (lid && branch) o.hub?.updateLoop(lid, { branch });
        }
        // remember: a cleared loop is a win in MIND (the next loop's study step finds it).
        let remembered = "";
        if (cleared && client && best) {
          const content = [
            `Goal: ${goal}`, `Mode: ${mode}. Cleared ${best.score}/10 (bar ${bar}) in ${best.cycle} cycle(s).`,
            `Scores: ${Object.entries(best.grade.scores).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
            `Grader notes: ${clip(best.grade.notes, 1200)}`,
            mode === "write" ? `Winning artifact:\n${clip(redactSecrets(artifact), 3000)}` : `Branch: ${branch ?? "(no change)"}; files: ${files.slice(0, 20).join(", ")}`,
          ].join("\n");
          try {
            await client.remember({ type: "entry", title: `Loop win - ${goal.slice(0, 80)}`, content, tags: withOriginTag(["daebot-loop-win", `loop-mode:${mode}`], "tool"), source: "daebot-loop", origin: "tool" }, ctx.signal);
            remembered = "Filed the win in MIND (tag daebot-loop-win).";
          } catch { remembered = "MIND did not take the win; it is not remembered."; }
        }
        const table = history.map((h) => `- cycle ${h.cycle}: ${h.score}/10 (weakest: ${h.grade.weakest} ${h.grade.scores[h.grade.weakest]}) · ${Object.entries(h.grade.scores).map(([k, v]) => `${k} ${v}`).join(", ")}`);
        const out = [
          `Goal: ${goal}`, `Rubric: ${cats.join(", ")} · bar ${bar}/10 · ${history.length} of ${maxCycles} cycle(s)`,
          "Cycles:", ...(table.length ? table : ["- (none graded)"]),
          ...(stopReason ? [`Stopped: ${stopReason}`] : []),
          ...(best ? ["", `Grader's last notes: ${clip(best.grade.notes, 1500)}`, ...(best.grade.checks ? [`Checks the grader ran: ${best.grade.checks}`] : [])] : []),
          ...(mode === "build" ? ["", branch ? `Branch with the work: ${branch} (${files.length} file(s): ${files.slice(0, 15).join(", ")}). Review it (git diff HEAD...${branch}), run the checks yourself, and merge only with the user's go if the branch is shared.` : "No file changed."] : ["", "Artifact:", clip(redactSecrets(artifact), 12_000)]),
          ...(remembered ? ["", remembered] : []),
          "", "Scores are the grader's reading, not your receipts: confirm the checks yourself before you say it works.",
        ].join("\n");
        const summary = cleared ? `loop cleared ${best!.score}/10 (bar ${bar}) in ${best!.cycle} cycle(s)` : best ? `loop stopped at ${best.score}/10 after ${history.length} cycle(s) (bar ${bar})` : "loop did not get a graded cycle";
        const meta = { cleared, cycles: history.length, ...(best ? { score: best.score } : {}), ...(branch ? { branch } : {}), ...(cost > 0 ? { costUsd: cost, model: "loop helpers" } : {}) };
        if (!best) return failed(summary + (stopReason ? `: ${stopReason}` : ""), { retry: "safe", stop: "after one retry, do the work directly", output: out, meta });
        return done(summary, { output: out, partial: !cleared, ...(branch ? { artifacts: [branch] } : {}), meta });
      } finally {
        if (tree) { try { o.worktrees!.finish(tree, `Daebot loop (interrupted): ${goal.slice(0, 100)}`); } catch { /* best effort */ } }
        running.delete(ctx.sessionId);
      }
    },
  };
}

/** WorktreeOps that hand every build helper the loop's one worktree and never close it (the loop finishes it once). */
function sharedTree(tree: Worktree): WorktreeOps {
  return {
    prepare: () => tree,
    finish: () => ({ changed: false, files: [], stat: "" }),
  };
}

export type { HelperOutcome };
