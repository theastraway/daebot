// Routines, gateway side: the runner's wiring to sessions (a durable server-owned turn in the bot's thread), the webhook endpoint
// /hooks/<routineId>/<secret>, and the REST under /bots/<id>/routines for the Routines section of the bot settings.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { routineView } from "../bots/manage-tool.ts";
import type { BotManageHooks } from "../bots/manage-tool.ts";
import type { Principal } from "../auth/users.ts";
import type { AgentEvent } from "../types.ts";
import { TurnRateLimiter } from "./agent-api.ts";
import { RunRegistry } from "./runs.ts";
import type { SessionManager } from "./sessions.ts";
import { checkFilter, describeTiming, filterWords, nextRuns, parseTiming, summarizeTiming, TimingError, validTz } from "../routines/clock.ts";
import { RoutineRunner } from "../routines/runner.ts";
import type { FireResult, TurnResult } from "../routines/runner.ts";
import { RoutineError, RoutineHub, secretMatches } from "../routines/store.ts";
import { catalogFor } from "../routines/triggers.ts";
import { pollSource } from "../routines/poll.ts";
import type { MindCall } from "../routines/poll.ts";
import { LocalSources } from "../routines/watchers.ts";
import type { ScreenFeed } from "../screen/feed.ts";

export const WEBHOOK_MAX_BODY = 64 * 1024;

export interface RoutineGatewayDeps {
  hub: RoutineHub;
  manager: SessionManager;
  runs: RunRegistry;
  broadcast(id: string, ev: AgentEvent): void;
  principalOf(owner: string): Principal | undefined;
  /** Folder name -> owner id (hosted: a stored user or the owner login; local: the single owner). */
  ownerOk(seg: string): string | undefined;
  enforceModel(me: Principal, id: string): Promise<string | undefined>;
  /** Where webhook URLs point, e.g. https://daebot.live (undefined = take it from the request). */
  publicBase(): string | undefined;
  readBody(req: IncomingMessage, limit: number): Promise<Buffer>;
  readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  clientIp(req: IncomingMessage): string;
  /** Reads one MIND list with the owner's own key (the polled triggers). Absent = polled triggers are not offered. */
  mindCall?: MindCall;
  /** The gateway runs on the user's own computer (desktop app): folder, wake, app-open and screen triggers exist. */
  desktop?: boolean;
  screen?: ScreenFeed;
  runner?: { tickMs?: number; scanMs?: number; jitterMs?: number; runTimeoutMs?: number; maxRunsPerOwnerHour?: number; now?: () => number };
}

const threadIdOf = (owner: string, botId: string, thread: string): string => "rt_" + createHash("sha256").update(`${owner}|${botId}|${thread}`).digest("hex").slice(0, 32);

export function createRoutineGateway(d: RoutineGatewayDeps) {
  const { manager, runs } = d;
  const hookLimit = new TurnRateLimiter({ max: 12, windowMs: 60_000 });   // per routine
  const ipLimit = new TurnRateLimiter({ max: 60, windowMs: 60_000 });     // per caller address, any routine
  const nudges = new Map<string, { n: number; at: number }>();

  async function pump(id: string, text: string, signal: AbortSignal | undefined, origin: "user" | "bot"): Promise<{ final: string; failed: string }> {
    const run = runs.start(id, text);
    let final = "", failed = "";
    try {
      await manager.turn(id, text, (ev) => {
        run.publish(ev);
        d.broadcast(id, ev);
        if (ev.type === "done") final = ev.finalText;
        else if (ev.type === "notice" && /^Turn failed/.test(ev.text)) failed = ev.text;
      }, signal, origin);
    } catch (e) {
      failed = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200);
      run.publish({ type: "notice", level: "warn", text: failed });
    } finally { run.finish(); }
    return { final, failed };
  }

  async function runTurn(a: { owner: string; botId: string; thread: string; text: string; signal: AbortSignal }): Promise<TurnResult> {
    const p = d.principalOf(a.owner);
    const id = threadIdOf(a.owner, a.botId, a.thread);
    const bad = (error: string): TurnResult => ({ ok: false, threadId: "", finalText: "", error });
    if (!p) return bad("this account is not signed in any more");
    let ls;
    try { ls = await manager.open({ surface: "routine", title: a.thread.slice(0, 120), resumeId: id, owner: a.owner, bot: a.botId }); }
    catch (e) { return bad(String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200)); }
    if (ls.busy) return bad("the thread is busy with another turn");
    const note = await d.enforceModel(p, id).catch(() => undefined);
    void note;
    const r = await pump(id, a.text, a.signal, "bot");
    return r.failed ? { ok: false, threadId: id, finalText: r.final, error: r.failed } : { ok: true, threadId: id, finalText: r.final };
  }

  d.hub.caps.desktop = d.desktop === true;
  const local = d.desktop ? new LocalSources({ fire: (owner, botId, id, text) => runner.fireRoutine(owner, botId, id, text), screen: d.screen }) : undefined;
  const runner: RoutineRunner = new RoutineRunner({
    hub: d.hub,
    desktop: d.desktop === true,
    local,
    poll: d.mindCall ? (owner, _botId, trigger, now, signal) => pollSource(d.mindCall!, owner, trigger, now, signal) : undefined,
    runTurn,
    ownerOk: d.ownerOk,
    state(owner, botId) {
      const rt = manager.runtimeOf(owner);
      if (!rt.bots) return { threads: [], board: [] };           // the account's sign-in lapsed: the run itself will say so
      if (!rt.bots.get(botId)) return undefined;
      const threads = rt.listSessions().filter((s) => s.bot === botId).map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, surface: s.surface, peer: s.peer }));
      const board = (rt.botBoardRows?.(botId) ?? []).map((b) => ({ sessionId: b.sessionId, id: b.id, title: b.title, status: b.status, question: b.question, updatedAt: b.updatedAt }));
      return { threads, board };
    },
    ...d.runner,
  });

  // Folder and screen watches follow the routines at once (the runner also re-checks them every tick).
  if (local) d.hub.onChange(() => { try { local.sync(d.hub.all()); } catch { /* the next tick tries again */ } });
  // A user message in a bot's thread fires thread_message routines (once per message).
  manager.onUserMessage = (ls, text) => { if (ls.bot) runner.trigger(ls.owner, ls.bot, "thread_message", { text }); };
  // A finished (or failed) reply in a bot's thread fires turn_done routines. Routine threads never do, so a routine cannot start itself.
  manager.onTurnDone = (ls, r) => { if (ls.bot) runner.trigger(ls.owner, ls.bot, "turn_done", { text: r.text.slice(0, 2000) || (r.ok ? "(no reply)" : "the turn failed"), ok: r.ok }); };

  /** The hooks the runtime lends bot_manage and bot_self. */
  const hooks: Pick<BotManageHooks, "runRoutine" | "continueThread" | "publicBase"> = {
    publicBase: () => d.publicBase(),
    async runRoutine(owner, botId, routineId) {
      const f = runner.runNow(owner, botId, routineId);
      if (!f.ok) return { ok: false, message: f.error };
      await Promise.race([f.done, new Promise((r) => setTimeout(r, 20_000))]);
      const last = d.hub.book(owner, botId).get(routineId)?.runs?.at(-1);
      if (!last || runner.isRunning(routineId)) return { ok: true, message: "Started. It is still running; the result lands in the routine's thread." };
      return { ok: last.status !== "error", message: last.model ? `Ran (${last.status}): ${last.result ?? ""}` : `No model call: ${last.result ?? "nothing to do"}` };
    },
    async continueThread(owner, botId, tid, note) {
      const key = `${owner}:${botId}`, now = Date.now();
      const n = nudges.get(key);
      if (n && now - n.at < 10 * 60_000 && n.n >= 3) throw new Error("already resumed 3 threads in this review");
      nudges.set(key, n && now - n.at < 10 * 60_000 ? { n: n.n + 1, at: n.at } : { n: 1, at: now });
      const ls = await manager.open({ surface: "web", resumeId: tid, owner, bot: botId });
      if (ls.busy) return "that thread is busy right now; leave it";
      void pump(tid, `[Check-in from your Heartbeat] ${note}`, undefined, "bot");
      return "resumed: the thread is working on it now";
    },
  };

  // ---------------------------------------------------------------- webhook
  async function webhook(req: IncomingMessage, res: ServerResponse, routineId: string, secret: string): Promise<void> {
    if ((req.method ?? "GET") !== "POST") return d.sendJson(res, 405, { error: "use POST" });
    const wait = ipLimit.take(d.clientIp(req));
    if (wait > 0) { res.setHeader("retry-after", String(wait)); return d.sendJson(res, 429, { error: "too many requests" }); }
    let hit = d.hub.find(routineId);
    if (!hit && Date.now() - d.hub.scannedAt > 5000) { d.hub.scan(d.ownerOk); hit = d.hub.find(routineId); }
    // Unknown id and wrong secret look the same.
    if (!hit || hit.routine.trigger?.type !== "webhook" || !secretMatches(hit.routine.secret, secret)) return d.sendJson(res, 404, { error: "not found" });
    const w2 = hookLimit.take(routineId);
    if (w2 > 0) { res.setHeader("retry-after", String(w2)); return d.sendJson(res, 429, { error: "this routine is being called too fast" }); }
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > WEBHOOK_MAX_BODY) return d.sendJson(res, 413, { error: "body too large (64 KB max)" });
    let body: Buffer;
    try { body = await d.readBody(req, WEBHOOK_MAX_BODY); } catch { return d.sendJson(res, 413, { error: "body too large (64 KB max)" }); }
    const f = runner.webhook(routineId, body.toString("utf8"));
    if (!f.ok) return d.sendJson(res, f.code, { error: f.error });
    return d.sendJson(res, 202, { ok: true, routine: routineId, status: "started" });
  }

  // ---------------------------------------------------------------- REST: /bots/:id/routines...
  const base = (req: IncomingMessage): string => {
    const b = d.publicBase();
    if (b) return b;
    const h = String(req.headers.host ?? "localhost");
    return `${/^(localhost|127\.|\[::1\])/.test(h) ? "http" : "https"}://${h}`;
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string, method: string, me: Principal): Promise<boolean> {
    const rt = manager.runtimeOf(me.id);
    if (path === "/routines/triggers") {
      if (method !== "GET") return d.sendJson(res, 405, { error: "method not allowed" }), true;
      return d.sendJson(res, 200, { triggers: catalogFor({ desktop: d.desktop === true }).filter((t) => !t.poll || !!d.mindCall).map((t) => ({ ...t, desktopOnly: t.desktopOnly === true })), desktop: d.desktop === true }), true;
    }
    if (path === "/routines/preview") {
      if (method !== "POST") return d.sendJson(res, 405, { error: "method not allowed" }), true;
      const b = await d.readJson(req);
      try {
        const tz = typeof b.tz === "string" && b.tz ? b.tz : "America/New_York";
        if (!validTz(tz)) return d.sendJson(res, 200, { ok: false, error: `"${String(tz).slice(0, 40)}" is not a time zone name` }), true;
        const spec = parseTiming(b.expression);
        const filter = checkFilter(b.filter);
        return d.sendJson(res, 200, {
          ok: true, expression: spec.text, tz, filter: filter ?? null,
          human: describeTiming(spec.text, tz) + filterWords(filter), summary: summarizeTiming(spec.text, filter),
          next: nextRuns(spec, tz, Date.now(), 3, filter),
        }), true;
      } catch (e) {
        return d.sendJson(res, 200, { ok: false, error: e instanceof TimingError ? e.message : "bad timing" }), true;
      }
    }
    const m = /^\/bots\/([^/]+)\/routines(?:\/(r_[0-9a-f]{12})(?:\/(run|rotate))?)?$/.exec(path);
    if (!m) return false;
    const bots = rt.bots;
    if (!bots) return d.sendJson(res, 404, { error: "bots are not enabled on this deployment" }), true;
    let botId: string;
    try { botId = decodeURIComponent(m[1]); } catch { return d.sendJson(res, 400, { error: "bad bot id" }), true; }
    if (!bots.get(botId)) return d.sendJson(res, 404, { error: "not_found", message: "no such bot" }), true;
    const book = d.hub.book(me.id, botId);
    const view = (rid: string) => routineView(book.get(rid)!, base(req));
    try {
      if (!m[2]) {
        if (method === "GET") return d.sendJson(res, 200, { routines: book.list().map((r) => routineView(r, base(req))), running: book.list().filter((r) => runner.isRunning(r.id)).map((r) => r.id) }), true;
        if (method === "POST") {
          const b = await d.readJson(req);
          const r = book.add(b);
          return d.sendJson(res, 200, { routine: view(r.id) }), true;
        }
        return d.sendJson(res, 405, { error: "method not allowed" }), true;
      }
      const rid = m[2];
      if (!book.get(rid)) return d.sendJson(res, 404, { error: "not_found", message: "no such routine" }), true;
      if (m[3] === "run") {
        if (method !== "POST") return d.sendJson(res, 405, { error: "method not allowed" }), true;
        const f: FireResult = runner.runNow(me.id, botId, rid);
        if (!f.ok) return d.sendJson(res, f.code, { error: f.error }), true;
        await Promise.race([f.done, new Promise((r) => setTimeout(r, 6000))]);
        return d.sendJson(res, 200, { ok: true, running: runner.isRunning(rid), routine: view(rid) }), true;
      }
      if (m[3] === "rotate") {
        if (method !== "POST") return d.sendJson(res, 405, { error: "method not allowed" }), true;
        book.rotateSecret(rid);
        return d.sendJson(res, 200, { routine: view(rid) }), true;
      }
      if (method === "PATCH") { const b = await d.readJson(req); book.update(rid, b); return d.sendJson(res, 200, { routine: view(rid) }), true; }
      if (method === "DELETE") { book.remove(rid); return d.sendJson(res, 200, { ok: true }), true; }
      if (method === "GET") return d.sendJson(res, 200, { routine: view(rid), runs: book.get(rid)!.runs ?? [] }), true;
      return d.sendJson(res, 405, { error: "method not allowed" }), true;
    } catch (e) {
      if (e instanceof RoutineError) return d.sendJson(res, e.status, { error: "routine", message: e.message }), true;
      throw e;
    }
  }

  return { runner, hooks, webhook, api };
}
