// A bot's own lessons. The Heartbeat records what worked, what failed and what the user corrected, in the BOT's own MIND (never the main one),
// through the same store, guards and revision rules as Daebot's own learning (src/learn). Recall is read-only and bounded in time.
import { contentProblem, lengthProblem } from "../learn/guard.ts";
import { buildNote } from "../learn/recall.ts";
import { LearnStore } from "../learn/store.ts";
import { cleanBehavior } from "../learn/text.ts";
import type { LearnConfig } from "../learn/config.ts";
import type { LearnHooks, LessonKind } from "../learn/types.ts";
import type { Config, MindClient } from "../types.ts";

export interface LessonInput { kind: LessonKind; trigger: string; behavior: string; rule: string; evidence: string }

/** Validates and files one lesson. Returns a short sentence for the model: what happened. */
export async function recordBotLesson(client: MindClient, cfg: Config, learn: LearnConfig, l: LessonInput): Promise<{ ok: boolean; text: string }> {
  if (!["failure", "win", "behavior"].includes(l.kind)) return { ok: false, text: "kind must be failure, win or behavior" };
  const problem = lengthProblem(l) ?? contentProblem(`${l.trigger} ${l.behavior} ${l.rule} ${l.evidence}`, { clientNames: cfg.clientNames }) ?? (!cleanBehavior(l.behavior) ? "behavior needs a short name (two to three words)" : null);
  if (problem) return { ok: false, text: `not recorded: ${problem}` };
  const store = new LearnStore(client, { ...learn, enabled: true }, { clientNames: cfg.clientNames });
  const r = await store.upsertLesson(l);
  return r.action === "rejected" ? { ok: false, text: `not recorded: ${r.why ?? "rejected"}` } : { ok: true, text: `lesson ${r.action}${r.item ? `: ${r.item.title}` : ""}` };
}

/** Read-only recall for a bot's turns: the bot's own lessons that match the message, as a short note. Fails open to no note. */
export function botRecall(client: MindClient, cfg: Config, learn: LearnConfig): LearnHooks {
  const store = new LearnStore(client, { ...learn, enabled: true }, { clientNames: cfg.clientNames });
  return {
    async beforeTurn(message) {
      try {
        await Promise.race([store.search(message), new Promise((res) => setTimeout(res, learn.beforeTurnTimeoutMs))]);
        return buildNote({ message, items: store.all(), cfg: { ...learn, enabled: true }, clientNames: cfg.clientNames }).note;
      } catch { return undefined; }
    },
    afterTurn() { /* a bot's turns are not reflected on turn by turn; the Heartbeat does that */ },
    async idle() {},
    async close() {},
  };
}
