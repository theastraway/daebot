// Working out where a saved session really lives. A session made before environments existed (or pushed by a device that did not tag it)
// has no home recorded. The sync store still holds evidence, strongest first:
//   1. the device that pushed it (a session new to the server, pushed by a computer, was made there)
//   2. a tool result in its own history: a tool daebot.live cannot run (bash, files, screen, computer...) that RETURNED OK ran on a computer
//   3. a bot thread whose bot runs on a computer through Remote
//   4. surface "desktop", unless a tool in the thread refused for being on the hosted side
// Nothing in the record says MIND Cloud, so a record with none of these stays MIND Cloud (what it was shown as before): only evidence moves it.
import { CLOUD_ENV } from "../env.ts";
import type { EnvGroup, EnvTag } from "../env.ts";
import { hostedToolAllowed } from "../hosted.ts";
import type { StoredSession } from "../persist.ts";

export type HomeWhy = "has-home" | "pushed-by-device" | "local-tool" | "bot-remote" | "surface-desktop" | "no-evidence";
export interface HomeCtx {
  /** The owner's computers and servers, duplicate registrations already merged. */
  groups: readonly EnvGroup[];
  /** The computer a bot (by its id on this side) runs on through Remote, if it runs on one. */
  botHome?(botId: string): EnvTag | undefined;
  /** The device that is pushing this record to the server right now, when the record is new to the server. */
  pusher?: EnvTag;
}
export interface HomeGuess { env: EnvTag; why: HomeWhy }

const HOSTED_REFUSAL = /daebot desktop app|hosted|not available (?:here|on this|in this)/i;

interface Evidence { localTool: boolean; hostedRefusal: boolean }
export function readEvidence(rec: Pick<StoredSession, "history">): Evidence {
  let localTool = false, hostedRefusal = false;
  for (const e of rec.history as unknown as { type?: string; tool?: string; ok?: boolean; preview?: string }[]) {
    if (e?.type !== "toolEnd" || typeof e.tool !== "string" || hostedToolAllowed(e.tool)) continue;
    if (e.ok === true) localTool = true;
    else if (typeof e.preview === "string" && HOSTED_REFUSAL.test(e.preview)) hostedRefusal = true;
  }
  return { localTool, hostedRefusal };
}

/** When the evidence says "a computer" but not which: the machine this owner has registered most often (their main one), then the one seen last. */
export function pickComputer(groups: readonly EnvGroup[]): EnvTag | undefined {
  const ms = groups.filter((g) => g.kind === "machine");
  const pool = ms.length ? ms : groups.filter((g) => g.kind === "server");
  const best = [...pool].sort((a, b) => b.members.length - a.members.length || b.lastSeen - a.lastSeen)[0];
  return best ? { id: best.id, kind: best.kind, name: best.name } : undefined;
}

/** A session stamped MIND Cloud is re-read (start-up pass) and moved only when its record says a computer: a local tool that ran, or surface desktop that no hosted refusal contradicts. */
export function movesOffCloud(rec: StoredSession): boolean {
  const ev = readEvidence(rec);
  return ev.localTool || (rec.surface === "desktop" && !ev.hostedRefusal);
}

export function inferHome(rec: StoredSession, ctx: HomeCtx): HomeGuess {
  if (rec.env) return { env: rec.env, why: "has-home" };
  if (ctx.pusher && ctx.pusher.kind !== "cloud") return { env: ctx.pusher, why: "pushed-by-device" };
  const ev = readEvidence(rec);
  const botId = rec.bot ?? (rec.peer && rec.peer !== "main" ? rec.peer : undefined);
  const botEnv = botId ? ctx.botHome?.(botId) : undefined;
  if (ev.localTool) { const env = botEnv ?? pickComputer(ctx.groups); if (env) return { env, why: "local-tool" }; }
  if (rec.bot && botEnv) return { env: botEnv, why: "bot-remote" };
  if (rec.surface === "desktop" && !ev.hostedRefusal) { const env = pickComputer(ctx.groups); if (env) return { env, why: "surface-desktop" }; }
  return { env: CLOUD_ENV, why: "no-evidence" };
}
