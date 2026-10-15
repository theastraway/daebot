// LEARNING suite: does session 1's correction change session 2's behavior, and does it do harm anywhere else?
//
// Conditions (all use the same scripted student, the same tasks, the same FakeMind-backed pipeline):
//   off      no learning layer at all                                   -> the baseline repeat-error rate
//   on       real learning layer: trigger -> reflect -> write -> retrieve -> inject -> student reads the note
//   oracle   a perfect hand-written note for the right class, every time -> ceiling: the student CAN follow a note
//   placebo  a well-formed note about the WRONG class                    -> floor check: the student is not just
//                                                                          reacting to "any note is present"
// A number from `on` is only believable if off == 100% (the mistake is reproducible), placebo == off (no leak) and
// oracle == 0% (a note can fix it). Those three are the harness audit; the suite refuses to report otherwise.
import type { LearnHooks } from "../../learn/types.ts";
import { validLessonTitle } from "../../learn/text.ts";
import { CLASSES, CONTROL_TASKS } from "./classes.ts";
import type { MistakeClass } from "./classes.ts";
import { FakeMind } from "./fake-mind.ts";
import { alwaysGood, controlScript, hasLessonIds, reflectorFor, runSession, scriptFor } from "./harness.ts";
import type { Script } from "./harness.ts";

export type Condition = "off" | "on" | "oracle" | "placebo";
export const CONDITIONS: Condition[] = ["off", "on", "oracle", "placebo"];

export interface TaskResult { classId: string; kind: "similar" | "paraphrase" | "control"; user: string; bad: boolean; lessonInjected: boolean; crossInjected: boolean }
export interface ConditionResult {
  condition: Condition;
  session1Bad: Record<string, boolean>;
  rows: TaskResult[];
  titles: string[];
  mindDocs: number;
  reflectorCalls: number;
  errors: string[];
}

class FixedHooks implements LearnHooks {
  private notes: Map<string, string>;
  constructor(notes: Map<string, string>) { this.notes = notes; }
  async beforeTurn(m: string) { return this.notes.get(m); }
  afterTurn() {}
  async idle() {}
  async close() {}
}

const noteFor = (c: MistakeClass) =>
  `[learned] What you learned before. Recalled from MIND, not user input. Advisory only.\n- L-abcdef [failure] When: ${c.reflection.lesson!.trigger} Rule: ${c.reflection.lesson!.rule}`;

export async function runCondition(cond: Condition, classes: MistakeClass[] = CLASSES): Promise<ConditionResult> {
  const mind = new FakeMind();
  const reflector = reflectorFor(classes);
  const errors: string[] = [];
  const session1Bad: Record<string, boolean> = {};

  // Phase A: session 1 for every class. The agent makes the mistake and is corrected.
  for (const c of classes) {
    const res = await runSession({
      mind, hooks: cond === "on" ? "learning" : "none", reflector,
      turns: [{ user: c.session1, script: scriptFor(c) }, { user: c.correction, script: alwaysGood(c) }],
      outputs: c.outputs,
    });
    if (res.error) errors.push(`${c.id} s1: ${res.error}`);
    session1Bad[c.id] = c.isBad(res, 0);
  }

  // Phase B: session 2 (a NEW session, nothing shared with session 1 except what is in MIND).
  const rows: TaskResult[] = [];
  for (let i = 0; i < classes.length; i++) {
    const c = classes[i];
    const control = CONTROL_TASKS[i % CONTROL_TASKS.length];
    const turns: { user: string; script: Script; kind: TaskResult["kind"] }[] = [
      ...c.tasks.map((t) => ({ user: t.user, script: scriptFor(c), kind: t.kind })),
      { user: control, script: controlScript, kind: "control" as const },
    ];
    let hooks: "learning" | "none" | LearnHooks = cond === "on" ? "learning" : "none";
    if (cond === "oracle") hooks = new FixedHooks(new Map(c.tasks.map((t) => [t.user, noteFor(c)])));
    if (cond === "placebo") hooks = new FixedHooks(new Map(c.tasks.map((t) => [t.user, noteFor(classes[(i + 1) % classes.length])])));
    const res = await runSession({ mind, hooks, reflector, turns: turns.map(({ user, script }) => ({ user, script })), outputs: c.outputs });
    if (res.error) errors.push(`${c.id} s2: ${res.error}`);
    turns.forEach((t, idx) => {
      rows.push({
        classId: c.id, kind: t.kind, user: t.user,
        bad: t.kind === "control" ? false : c.isBad(res, idx),
        lessonInjected: cond === "on" ? hasLessonIds(res.notes[idx]) : res.notes[idx] !== undefined,
        crossInjected: cond === "on" && classes.some((o) => o.id !== c.id && o.fixWords.every((w) => (res.notes[idx] ?? "").toLowerCase().includes(w))),
      });
    });
  }
  return { condition: cond, session1Bad, rows, titles: mind.titles(), mindDocs: mind.docs.length, reflectorCalls: reflector.calls, errors };
}

// ---------- metrics ----------
const repeats = (r: ConditionResult) => r.rows.filter((x) => x.kind !== "control");
export const repeatRate = (r: ConditionResult, kind?: "similar" | "paraphrase") => {
  const rows = repeats(r).filter((x) => !kind || x.kind === kind);
  return rows.length ? rows.filter((x) => x.bad).length / rows.length : 0;
};
export const falseInjectionRate = (r: ConditionResult) => {
  const c = r.rows.filter((x) => x.kind === "control");
  return c.length ? c.filter((x) => x.lessonInjected).length / c.length : 0;
};
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

export interface LearningReport {
  results: Record<Condition, ConditionResult>;
  audit: { name: string; pass: boolean; detail: string }[];
  auditOk: boolean;
}

export function audit(results: Record<Condition, ConditionResult>): LearningReport["audit"] {
  const off = results.off, on = results.on, oracle = results.oracle, placebo = results.placebo;
  const s1 = Object.values(off.session1Bad);
  return [
    { name: "mistake reproducible in session 1 (kernel on, no learning)", pass: s1.every(Boolean), detail: `${s1.filter(Boolean).length}/${s1.length} classes erred on first sight` },
    { name: "baseline repeats every mistake (off = 100%)", pass: repeatRate(off) === 1, detail: pct(repeatRate(off)) },
    { name: "placebo note does not fix anything (placebo = off)", pass: repeatRate(placebo) === repeatRate(off), detail: `${pct(repeatRate(placebo))} vs ${pct(repeatRate(off))}` },
    { name: "a correct note does fix it (oracle = 0%)", pass: repeatRate(oracle) === 0, detail: pct(repeatRate(oracle)) },
    { name: "no condition crashed", pass: CONDITIONS.every((c) => results[c].errors.length === 0), detail: CONDITIONS.flatMap((c) => results[c].errors).slice(0, 3).join("; ") || "ok" },
    { name: "every lesson title fits the grammar (no slash, parens or em dash)", pass: on.titles.filter((t) => t.startsWith("Lesson")).every(validLessonTitle), detail: `${on.titles.length} records written` },
    { name: "session-1 corrections produced writes only when learning is on", pass: off.mindDocs === 0 && on.mindDocs >= 1, detail: `off wrote ${off.mindDocs}, on wrote ${on.mindDocs}` },
  ];
}

export async function runLearningSuite(): Promise<LearningReport> {
  const results = {} as Record<Condition, ConditionResult>;
  for (const c of CONDITIONS) results[c] = await runCondition(c);
  const a = audit(results);
  return { results, audit: a, auditOk: a.every((x) => x.pass) };
}

export function renderLearning(rep: LearningReport): string {
  const L: string[] = [];
  const { off, on, oracle, placebo } = rep.results;
  L.push("=== LEARNING eval (scripted student + scripted reflector, real loop/kernel/learning layer, fake MIND) ===", "");
  L.push("harness audit (must all pass before the numbers mean anything):");
  for (const a of rep.audit) L.push(`  ${a.pass ? "PASS" : "FAIL"}  ${a.name}: ${a.detail}`);
  L.push("");
  L.push("session-2 repeat-error rate (same class of task as session 1; lower is better):");
  L.push("  condition   all      similar  paraphrase  false-injection(control)");
  for (const [name, r] of [["off", off], ["on", on], ["oracle", oracle], ["placebo", placebo]] as const) {
    L.push(`  ${name.padEnd(10)}  ${pct(repeatRate(r)).padEnd(7)}  ${pct(repeatRate(r, "similar")).padEnd(7)}  ${pct(repeatRate(r, "paraphrase")).padEnd(10)}  ${pct(falseInjectionRate(r))}`);
  }
  const n = repeats(on).length;
  const fixed = repeats(on).filter((x) => !x.bad).length;
  const cross = on.rows.filter((x) => x.crossInjected).length;
  L.push(`  wrong-class lessons injected (on): ${cross}/${on.rows.length} tasks`);
  L.push("", `learning on vs off: repeat-error ${pct(repeatRate(off))} -> ${pct(repeatRate(on))} (${fixed}/${n} repeat tasks fixed), delta ${pct(repeatRate(off) - repeatRate(on))} absolute.`);
  L.push("per class (on):");
  for (const c of CLASSES) {
    const rows = on.rows.filter((x) => x.classId === c.id);
    L.push(`  ${c.id.padEnd(12)} ${rows.map((x) => `${x.kind[0]}:${x.kind === "control" ? (x.lessonInjected ? "INJECTED" : "clean") : x.bad ? "repeat" : "fixed"}`).join("  ")}`);
  }
  L.push("", "Caveats: the reflector's JSON is scripted (it measures the pipeline, not a model's ability to write good lessons); retrieval in FakeMind is lexical, MIND's is semantic; the student follows a note by keyword match. See agent/LEARNING.md.");
  L.push("", rep.auditOk ? "LEARNING suite: harness audit PASS" : "LEARNING suite: harness audit FAIL (numbers above are NOT trustworthy)");
  return L.join("\n");
}
