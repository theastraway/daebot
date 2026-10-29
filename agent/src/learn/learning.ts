// The learning layer: wires triggers, reflection, the MIND-backed store, recall, outcome tracking and the guards
// into the two hooks the loop calls (beforeTurn / afterTurn). Nothing in here can block a reply: beforeTurn is
// time-bounded and fails open to "no note"; afterTurn is fire-and-forget.
import type { Config, MindClient, Provider } from "../types.ts";
import type { LearnConfig } from "./config.ts";
import { contentProblem, lengthProblem, writeTrust } from "./guard.ts";
import { buildNote } from "./recall.ts";
import { reflect } from "./reflect.ts";
import { LearnStore } from "./store.ts";
import { cleanBehavior } from "./text.ts";
import { detectTriggers, looksLikeCorrection, turnWentBadly } from "./triggers.ts";
import type { Item, LearnHooks, ReflectionResult, Trigger, TurnSummary } from "./types.ts";

export interface LearnEvent {
  at: number;
  type: "lesson" | "skill" | "user_model" | "refused" | "skipped" | "error" | "outcome" | "injected" | "demoted";
  detail: string;
  key?: string;
  action?: string;
}

/** Explicit feedback on one reply (thumbs, emoji 👍/👎, or a Report). Written straight to the store: the user already judged it, no reflection call is needed. */
export interface ReplyFeedback { rating: "up" | "down"; reply: string; comment?: string; reason?: string; report?: boolean }

export interface Learning extends LearnHooks {
  /** Files the user's verdict on a reply as a lesson (down = failure, up = win). Returns whether a lesson was written or reinforced. Never throws. */
  feedback(f: ReplyFeedback): Promise<boolean>;
  readonly store: LearnStore;
  readonly events: LearnEvent[];
  readonly stats: { reflections: number; injections: number; cost: number };
}

export interface LearningDeps {
  client: MindClient;
  provider: Provider;
  cfg: Config;                       // models.cheap is the reflection model (MINDCLAW_CHEAP_MODEL)
  learn: LearnConfig;
  tier: "public" | "staff" | "admin";
  onCost?: (usd: number) => void;    // so the hosted daily cap sees reflection spend
  now?: () => Date;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(undefined); });
  });
}

export function createLearning(d: LearningDeps): Learning {
  const store = new LearnStore(d.client, d.learn, { clientNames: d.cfg.clientNames, now: d.now });
  const events: LearnEvent[] = [];
  const stats = { reflections: 0, injections: 0, cost: 0 };
  const inflight = new Set<Promise<void>>();
  const history: string[] = [];
  // Items shown on the previous turn and whether their outcome is settled yet.
  let pending: { keys: string[]; settled: boolean } | undefined;
  const log = (e: Omit<LearnEvent, "at">) => { events.push({ at: Date.now(), ...e }); if (events.length > 500) events.splice(0, 100); };

  function settle(keys: string[], good: boolean): void {
    for (const k of keys) {
      const before = store.get(k)?.status;
      store.recordOutcome(k, good);
      log({ type: "outcome", key: k, detail: good ? "helped" : "hurt" });
      const after = store.get(k)?.status;
      if (before && after && before !== after) log({ type: "demoted", key: k, detail: `${before} -> ${after}` });
    }
  }

  async function beforeTurn(userMessage: string): Promise<string | undefined> {
    try {
      // The user's reply to the previous turn is the verdict on whatever we injected there.
      if (pending && !pending.settled && pending.keys.length) {
        settle(pending.keys, !looksLikeCorrection(userMessage, history));
      }
      pending = undefined;
      history.push(userMessage);

      const retrieval = Promise.all([store.search(userMessage), store.loadUserModel()]).then(() => undefined);
      await withTimeout(retrieval, d.learn.beforeTurnTimeoutMs);
      const { note, cited } = buildNote({
        message: userMessage, items: store.all(), userModel: store.currentUserModel(),
        cfg: d.learn, clientNames: d.cfg.clientNames, now: d.now?.(),
      });
      if (!note) return undefined;
      for (const it of cited) store.recordUse(it.key);
      pending = { keys: cited.map((c: Item) => c.key), settled: false };
      stats.injections++;
      log({ type: "injected", detail: cited.map((c) => `${c.type === "lesson" ? "L" : "S"}-${c.key}`).join(",") || "user model" });
      return note;
    } catch (e) {
      log({ type: "error", detail: `beforeTurn: ${String((e as Error)?.message ?? e).slice(0, 160)}` });
      return undefined;
    }
  }

  function afterTurn(t: TurnSummary): void {
    try {
      // Immediate failure inside a turn that had items injected = they were in play when it broke.
      if (pending && !pending.settled && pending.keys.length && turnWentBadly(t)) {
        settle(pending.keys, false);
        pending.settled = true;
      }
      if (!d.learn.enabled) return;
      const trust = writeTrust(d.tier, t.calls);
      const triggers = detectTriggers(t);
      if (!triggers.length) return;
      if (!trust.ok) { log({ type: "refused", detail: `no learning from this turn: ${trust.why}` }); return; }
      if (stats.reflections >= d.learn.maxReflectionsPerSession) { log({ type: "skipped", detail: "reflection budget for this session used" }); return; }
      if (inflight.size > 0) { log({ type: "skipped", detail: "a reflection is already running" }); return; }
      stats.reflections++;
      const p = (async () => {
        try {
          const res = await reflect(t, triggers, { provider: d.provider, model: d.cfg.models.cheap, onCost: (usd) => { stats.cost += usd; d.onCost?.(usd); } });
          await apply(res, triggers);
        } catch (e) {
          log({ type: "error", detail: `reflection: ${String((e as Error)?.message ?? e).slice(0, 160)}` });
        }
      })();
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    } catch (e) {
      log({ type: "error", detail: `afterTurn: ${String((e as Error)?.message ?? e).slice(0, 160)}` });
    }
  }

  async function apply(res: ReflectionResult, triggers: Trigger[]): Promise<void> {
    const kinds = new Set(triggers.map((x) => x.kind));
    const negative = kinds.has("kernel_block") || kinds.has("tool_failure") || kinds.has("user_correction");
    const co = { clientNames: d.cfg.clientNames };

    if (res.lesson) {
      const l = res.lesson;
      const problem =
        lengthProblem(l)
        ?? contentProblem(`${l.trigger} ${l.behavior} ${l.rule} ${l.evidence}`, co)
        ?? (!cleanBehavior(l.behavior) ? "behavior name is empty" : null)
        ?? (l.kind === "win" && !kinds.has("multi_step_success") ? "a win lesson needs a successful multi-step turn" : null)
        ?? (l.kind === "failure" && !negative ? "a failure lesson needs a kernel block, tool failure or user correction" : null);
      if (problem) log({ type: "refused", detail: `lesson: ${problem}` });
      else {
        const r = await store.upsertLesson(l);
        log({ type: "lesson", action: r.action, key: r.item?.key, detail: r.why ?? r.item?.title ?? "" });
      }
    }
    if (res.skill) {
      const s = res.skill;
      const problem =
        contentProblem(`${s.name} ${s.description} ${s.preconditions.join(" ")} ${s.steps.join(" ")} ${s.tools.join(" ")}`, co)
        ?? (!kinds.has("multi_step_success") ? "a skill needs a successful multi-step turn" : null)
        ?? (negative ? "a skill is only stored from a turn with no failure or correction" : null);
      if (problem) log({ type: "refused", detail: `skill: ${problem}` });
      else {
        const r = await store.upsertSkill(s);
        log({ type: "skill", action: r.action, key: r.item?.key, detail: r.why ?? r.item?.title ?? "" });
      }
    }
    if (res.userPrefs?.length) {
      if (!kinds.has("user_correction")) log({ type: "refused", detail: "user model: preferences are only learned from corrections" });
      else {
        const r = await store.updateUserModel(res.userPrefs);
        log({ type: "user_model", action: r.written ? "updated" : "unchanged", detail: r.why ?? `${r.model?.prefs.length ?? 0} preferences` });
      }
    }
  }

  async function feedback(f: ReplyFeedback): Promise<boolean> {
    try {
      if (!d.learn.enabled) return false;
      const co = { clientNames: d.cfg.clientNames };
      const clean = (t: string | undefined, max: number): string => {
        const x = (t ?? "").replace(/\s+/g, " ").trim().slice(0, max);
        return x && !contentProblem(x, co) ? x : "";
      };
      const comment = clean(f.comment, 140), reason = clean(f.reason, 60), gist = clean(f.reply, 100);
      const down = f.rating === "down";
      const behavior = down ? (f.report ? "Reply reported wrong" : "Reply rated down") : "Reply rated up";
      const trigger = down
        ? `The user ${f.report ? "reported" : "gave a thumbs down to"} a reply${reason ? ` (${reason})` : ""}${gist ? `: "${gist}"` : ""}`
        : `The user gave a thumbs up to a reply${gist ? `: "${gist}"` : ""}`;
      const rule = down
        ? (comment ? `Do not repeat this. The user said: ${comment}` : "Do not repeat this kind of reply; when unsure why it missed, ask the user what was wrong before trying again.")
        : (comment ? `Keep doing this. The user said: ${comment}` : "Keep this approach: the user liked a reply like this one.");
      const evidence = comment || reason || (down ? "thumbs down" : "thumbs up");
      const lesson = { kind: down ? "failure" as const : "win" as const, trigger: trigger.slice(0, 180), behavior, rule: rule.slice(0, 260), evidence: evidence.slice(0, 220) };
      const problem = lengthProblem(lesson) ?? contentProblem(`${lesson.trigger} ${lesson.rule}`, co);
      if (problem) { log({ type: "refused", detail: `feedback: ${problem}` }); return false; }
      const r = await store.upsertLesson(lesson);
      log({ type: "lesson", action: r.action, key: r.item?.key, detail: r.why ?? r.item?.title ?? "" });
      return r.action !== "rejected";
    } catch (e) {
      log({ type: "error", detail: `feedback: ${String((e as Error)?.message ?? e).slice(0, 160)}` });
      return false;
    }
  }

  async function idle(): Promise<void> {
    while (inflight.size) await Promise.allSettled([...inflight]);
  }

  async function close(): Promise<void> {
    try {
      await withTimeout((async () => { await idle(); await store.flush(); })(), d.learn.closeTimeoutMs);
    } catch { /* best effort */ }
  }

  return { beforeTurn, afterTurn, idle, close, feedback, store, events, stats };
}
