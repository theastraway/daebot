// Harness pieces for the LEARNING suite: a scripted student model, a scripted reflector, and a session runner that
// drives the REAL createAgentSession + REAL kernel + REAL learning layer against a FakeMind.
import { createAgentSession } from "../../loop.ts";
import { createKernel } from "../../kernel/index.ts";
import { createLearning, resolveLearnConfig } from "../../learn/index.ts";
import type { Learning } from "../../learn/index.ts";
import type { LearnHooks } from "../../learn/types.ts";
import type { AgentEvent, Config, Message, Provider, SessionSync, StreamEvent, ToolSpec } from "../../types.ts";
import { dropEnv, makeEnv } from "../runner.ts";
import { createFakeTools } from "../tools.ts";
import type { ExecLog } from "../tools.ts";
import type { Env, RunResult, StepCall } from "../types.ts";
import type { MistakeClass } from "./classes.ts";
import { FakeMind } from "./fake-mind.ts";

export interface Plan { calls?: StepCall[]; text: string }
export type Script = (ctx: { user: string; note?: string }) => Plan;

const NOTE_RE = /^\[learned\]/;

/** Deterministic stand-in for the main model. It makes whatever mistake its script says, and follows a lesson only
 *  when the script's check finds the lesson text in the "[learned]" system note. It cannot see anything else. */
export class Student implements Provider {
  readonly name = "scripted-student";
  script: Script = () => ({ text: "ok" });
  scratch = "";
  notesSeen: (string | undefined)[] = [];   // the note visible at the first request of each turn
  private turnNote: string | undefined;
  private fresh = true;
  private seq = 0;
  requests = 0;

  beginTurn(script: Script): void { this.script = script; this.fresh = true; }

  async *stream(req: { model: string; messages: Message[]; tools: ToolSpec[] }): AsyncIterable<StreamEvent> {
    this.requests++;
    const note = [...req.messages].reverse().find((m) => m.role === "system" && NOTE_RE.test(m.content))?.content;
    if (this.fresh) { this.notesSeen.push(note); this.fresh = false; }
    this.turnNote = note;
    const last = req.messages[req.messages.length - 1];
    const user = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const plan = this.script({ user, note: this.turnNote });
    const calls = plan.calls ?? [];
    if (last.role === "tool" || !calls.length) {
      yield { type: "text", delta: plan.text };
      yield { type: "done", usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 }, finishReason: "stop" };
      return;
    }
    for (const c of calls) {
      const args = JSON.parse(JSON.stringify(c.args).replace(/\{\{scratch\}\}/g, this.scratch)) as Record<string, unknown>;
      yield { type: "toolCall", call: { id: `call_${++this.seq}`, name: c.name, args } };
    }
    yield { type: "done", usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 }, finishReason: "tool_calls" };
  }
}

/** Scripted reflector: returns the JSON a competent reflection model would write for each correction. */
export class Reflector implements Provider {
  readonly name = "scripted-reflector";
  calls = 0;
  private table: { match: string; json: unknown }[];
  constructor(table: { match: string; json: unknown }[]) { this.table = table; }
  async *stream(req: { messages: Message[] }): AsyncIterable<StreamEvent> {
    this.calls++;
    const digest = req.messages[req.messages.length - 1]?.content ?? "";
    const hit = this.table.find((t) => digest.includes(t.match));
    yield { type: "text", delta: hit ? JSON.stringify(hit.json) : "{}" };
    yield { type: "done", usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 }, finishReason: "stop" };
  }
}

export function reflectorFor(classes: MistakeClass[]): Reflector {
  return new Reflector(classes.map((c) => ({ match: c.correction.slice(0, 32), json: c.reflection })));
}

export const scriptFor = (c: MistakeClass): Script => ({ note }) => {
  const follows = !!note && c.fixWords.every((w) => note.toLowerCase().includes(w));
  return follows ? c.good : c.bad;
};
export const alwaysGood = (c: MistakeClass): Script => () => c.good;
export const controlScript: Script = () => ({ text: "Eastern." });

const nullSync: SessionSync = { async open() {}, async append() {}, async pendingReplies() { return []; }, async close() {} };

export function evalCfg(): Config {
  return {
    mindBaseUrl: "https://eval.invalid/developer/v1", mindApiKey: "eval", openrouterKey: "eval",
    models: { default: "scripted/student", cheap: "scripted/reflector", fallback: [] },
    shadow: false, kernel: true, maxToolRoundsPerTurn: 8,
  };
}

export interface SessionOpts {
  mind: FakeMind;
  turns: { user: string; script: Script }[];
  hooks?: "learning" | LearnHooks | "none";
  reflector?: Provider;
  tier?: "public" | "staff" | "admin";
  outputs?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface SessionResult extends RunResult {
  notes: (string | undefined)[];
  events: AgentEvent[][];
  learning?: Learning;
}

export async function runSession(o: SessionOpts): Promise<SessionResult> {
  const env: Env = makeEnv();
  const log: ExecLog = { records: [], turn: 0 };
  const student = new Student();
  student.scratch = env.scratch;
  const cfg = evalCfg();
  const kernel = createKernel({
    shadow: false, enabled: true,
    isolation: { enabled: true, cwd: env.scratch, githubRoot: env.githubRoot, worktreesRoot: env.worktreesRoot },
  });
  let learning: Learning | undefined;
  let hooks: LearnHooks | undefined;
  if (o.hooks === "learning" || o.hooks === undefined) {
    learning = createLearning({
      client: o.mind, provider: o.reflector ?? new Reflector([]), cfg,
      learn: resolveLearnConfig({ MINDCLAW_LEARNING: "1", ...(o.env ?? {}) }), tier: o.tier ?? "admin", now: o.now,
    });
    hooks = learning;
  } else if (o.hooks !== "none") hooks = o.hooks;

  const session = createAgentSession({
    id: `learn-${Math.random().toString(36).slice(2, 8)}`, surface: "headless", provider: student, kernel,
    tools: createFakeTools(log, o.outputs), sync: nullSync, cfg, cwd: env.scratch, systemPrompt: "You are Daebot (eval harness, scripted model).",
    bootContext: "MIND boot context", learn: hooks,
  });

  const finalTexts: string[] = [];
  const events: AgentEvent[][] = [];
  let error: string | undefined;
  try {
    for (let t = 0; t < o.turns.length; t++) {
      log.turn = t;
      student.beginTurn(o.turns[t].script);
      const evs: AgentEvent[] = [];
      let final = "";
      for await (const ev of session.send(o.turns[t].user)) {
        evs.push(ev);
        if (ev.type === "done") final = ev.finalText;
        if (ev.type === "notice" && ev.text.startsWith("error:")) error = ev.text;
      }
      finalTexts.push(final);
      events.push(evs);
      // Reflection runs after the reply; let it land before the next turn so sessions are deterministic.
      if (learning) await learning.idle();
    }
    await session.close();
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  } finally {
    dropEnv(env);
  }
  return {
    scenarioId: "learning", mode: "enforced", turns: [], exec: log.records, gateEvents: [], violations: session.violations(),
    finalTexts, env, providerRequests: student.requests, error, notes: student.notesSeen, events, learning,
  };
}

export const hasLessonIds = (note: string | undefined) => !!note && /\b[LS]-[0-9a-f]{6}\b/.test(note);
