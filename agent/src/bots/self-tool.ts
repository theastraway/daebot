// bot_self: what a bot uses to manage ITS OWN work during a Heartbeat. threads: see its threads and tasks. continue / stop: push a stalled
// thread along or stop it with one clear question for the user. learn: record a lesson in its own MIND. Offered to bots only (never the main
// session). continue and stop only work from the Heartbeat's own run, so a chat message or a routine's payload cannot steer other threads.
import type { Tool } from "../types.ts";
import type { LessonInput } from "./lessons.ts";

export interface ThreadView { id: string; title: string; updatedAt: number; state: string; lastUser?: string; lastBot?: string; tasks: { id: string; title: string; status: string; question?: string }[] }

export interface BotSelfDeps {
  threads(): Promise<ThreadView[]>;
  /** Is this session the Heartbeat's own run? */
  isHeartbeat(sessionId: string): boolean;
  continueThread(threadId: string, note: string): Promise<string>;
  stopThread(threadId: string, question: string): Promise<string>;
  learn(l: LessonInput): Promise<{ ok: boolean; text: string }>;
}

const ACTIONS = ["threads", "continue", "stop", "learn"] as const;
const fail = (m: string) => ({ ok: false, output: `bot_self: ${m}` });
const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function createBotSelfTool(d: BotSelfDeps): Tool {
  return {
    spec: {
      name: "bot_self",
      description:
        "Manage your own work (used in your Heartbeat). threads {}: lists ALL your threads with last messages, run state and tasks. It takes NO other argument: call it with just action \"threads\", never ask for or invent a thread id (the ids come back in its result). " +
        "continue {thread, note}: resume a stalled thread with a short instruction (Heartbeat only; at most 3 per run). " +
        "stop {thread, question}: mark a thread stopped with the one question the user must answer (Heartbeat only). " +
        "learn {kind: failure|win|behavior, trigger, behavior (2-3 words), rule, evidence}: record a lesson in your own memory.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...ACTIONS] },
          thread: { type: "string", description: "Only for continue and stop: a thread id taken from the result of threads. Never needed for threads itself." },
          note: { type: "string", description: "What to do next, one or two sentences" },
          question: { type: "string", description: "The exact question for the user" },
          kind: { type: "string", enum: ["failure", "win", "behavior"] },
          trigger: { type: "string" }, behavior: { type: "string" }, rule: { type: "string" }, evidence: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    class: "write",
    classFor: (a) => (a.action === "threads" ? "read" : "write"),
    async run(args, ctx) {
      const action = s(args.action);
      if (!(ACTIONS as readonly string[]).includes(action)) return fail(`action must be one of ${ACTIONS.join(", ")}`);
      try {
        // threads never needs a thread id: it lists them all. A thread id passed anyway (a model reading the schema too literally) only narrows the list.
        if (action === "threads") {
          const all = await d.threads();
          const only = s(args.thread);
          const hit = only ? all.filter((t) => t.id === only) : [];
          return { ok: true, output: JSON.stringify({ threads: hit.length ? hit : all }) };
        }
        if (action === "learn") {
          const r = await d.learn({ kind: s(args.kind) as LessonInput["kind"], trigger: s(args.trigger), behavior: s(args.behavior), rule: s(args.rule), evidence: s(args.evidence) });
          return { ok: r.ok, output: r.text };
        }
        if (!d.isHeartbeat(ctx.sessionId)) return fail(`${action} only works inside the Heartbeat run`);
        const thread = s(args.thread);
        if (!thread) return fail(`${action} needs a thread id (call threads)`);
        if (action === "continue") {
          const note = s(args.note);
          if (!note) return fail("continue needs a note");
          return { ok: true, output: await d.continueThread(thread, note.slice(0, 600)) };
        }
        const q = s(args.question);
        if (!q) return fail("stop needs the exact question for the user");
        return { ok: true, output: await d.stopThread(thread, q.slice(0, 600)) };
      } catch (e) {
        return fail(String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200));
      }
    },
  };
}
