// Where a saved session lives. The standard is MIND Cloud, always: a session or bot runs on a computer only when the PERSON turned that on
// ("Run on a computer"), and that choice is recorded (`envBy: "user"`, `envAt`). Nothing is ever put on a computer by inference any more: an earlier
// build guessed a computer from the device that pushed a record, from a tool that had run, or from `surface: desktop`, and that is how sessions and
// bots ended up on a Mac nobody chose (and went quiet when it slept). What is left here:
//   - inferHome: a record with no home at all is MIND Cloud.
//   - migrationDecision: the one-time pass that puts those auto-stamped computers back on MIND Cloud, keeping every choice the person made.
import { CLOUD_ENV, isLocalHome } from "../env.ts";
import type { EnvGroup, EnvTag } from "../env.ts";
import { hostedToolAllowed } from "../hosted.ts";
import type { StoredSession } from "../persist.ts";
import type { BotRecord } from "../bots/types.ts";

export type HomeWhy = "has-home" | "default";
export interface HomeCtx {
  /** The owner's computers and servers, duplicate registrations already merged. */
  groups: readonly EnvGroup[];
  /** The computer a bot (by its id on this side) runs on through Remote, if it runs on one. */
  botHome?(botId: string): EnvTag | undefined;
}
export interface HomeGuess { env: EnvTag; why: HomeWhy }

/** A record with a home keeps it; one with none is MIND Cloud (the standard). Never a computer. */
export function inferHome(rec: Pick<StoredSession, "env">, _ctx?: HomeCtx): HomeGuess {
  return rec.env ? { env: rec.env, why: "has-home" } : { env: CLOUD_ENV, why: "default" };
}

interface Evidence { localTool: boolean; hostedRefusal: boolean }
/** What a saved thread shows about where it ran: a tool daebot.live cannot run that RETURNED OK ran on a computer. Only used to protect a legacy thread of a Remote bot. */
export function readEvidence(rec: Pick<StoredSession, "history">): Evidence {
  const HOSTED_REFUSAL = /daebot desktop app|hosted|not available (?:here|on this|in this)/i;
  let localTool = false, hostedRefusal = false;
  for (const e of rec.history as unknown as { type?: string; tool?: string; ok?: boolean; preview?: string }[]) {
    if (e?.type !== "toolEnd" || typeof e.tool !== "string" || hostedToolAllowed(e.tool)) continue;
    if (e.ok === true) localTool = true;
    else if (typeof e.preview === "string" && HOSTED_REFUSAL.test(e.preview)) hostedRefusal = true;
  }
  return { localTool, hostedRefusal };
}

export type MigrateWhy = "cloud" | "no-home" | "server" | "user-chose-local" | "bot-remote-by-user" | "bot-remote-needs-local-tools" | "auto-stamped";
export interface MigrateVerdict { move: boolean; why: MigrateWhy }

/** The last change of a bot's Remote switch: who made it ("user" / "auto"), or undefined when there is no record of one. */
export const remoteBy = (b: Pick<BotRecord, "remoteLog">): "user" | "auto" | undefined => b.remoteLog?.length ? b.remoteLog[b.remoteLog.length - 1].by : undefined;

/**
 * One-time migration of a bot: Remote turned on by the person stays. Remote that was turned on AUTOMATICALLY (a message arrived while it was off) goes
 * off: nobody chose it. Remote on with no record at all stays only when a thread of the bot shows a computer-only tool that ran (it needs the computer).
 */
export function botMigration(b: Pick<BotRecord, "remote" | "remoteLog">, threads: readonly Pick<StoredSession, "history">[]): { off: boolean; why: "not-remote" | "by-user" | "by-auto" | "no-record-needs-local-tools" | "no-record" } {
  if (!b.remote) return { off: false, why: "not-remote" };
  const by = remoteBy(b);
  if (by === "user") return { off: false, why: "by-user" };
  if (by === "auto") return { off: true, why: "by-auto" };
  return threads.some((t) => readEvidence(t).localTool) ? { off: false, why: "no-record-needs-local-tools" } : { off: true, why: "no-record" };
}

/**
 * One-time migration of a session. A home the person chose (envBy user) stays; a server stays (deploying a gateway there was the choice); a thread of a
 * bot that still runs on a computer (Remote on, by the person or needing local tools) follows its bot. Everything else that sits on a computer was
 * stamped, not chosen: it goes to MIND Cloud. `bot` is the bot as it is AFTER the bot pass.
 */
export function migrationDecision(rec: StoredSession, bot: Pick<BotRecord, "remote" | "remoteLog"> | undefined): MigrateVerdict {
  if (!rec.env) return { move: false, why: "no-home" };
  if (!isLocalHome(rec.env)) return { move: false, why: "cloud" };
  if (rec.env.kind === "server") return { move: false, why: "server" };
  if (rec.envBy === "user") return { move: false, why: "user-chose-local" };
  if (rec.bot && bot?.remote) {
    if (remoteBy(bot) === "user") return { move: false, why: "bot-remote-by-user" };
    if (readEvidence(rec).localTool) return { move: false, why: "bot-remote-needs-local-tools" };
  }
  return { move: true, why: "auto-stamped" };
}
