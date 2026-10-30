// Routines, gateway side: the runner's wiring to sessions (a durable server-owned turn in the bot's thread), the webhook endpoint
// /hooks/<routineId>/<secret>, and the REST under /bots/<id>/routines for the Routines section of the bot settings.
import { createHash, randomUUID } from "node:crypto";
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
import { DEFS, catalogFor, checkTrigger, isGithub } from "../routines/triggers.ts";
import { checkSetup } from "../routines/setup.ts";
import type { SetupApp, SetupReport } from "../routines/setup.ts";
import { githubEvent, githubWants, sampleGithub, signGithub, verifyGithubSignature } from "../routines/github.ts";
import { pollSource } from "../routines/poll.ts";
import type { MindCall } from "../routines/poll.ts";
import { LocalSources } from "../routines/watchers.ts";
import type { ScreenFeed } from "../screen/feed.ts";

export const WEBHOOK_MAX_BODY = 64 * 1024;
export const GITHUB_MAX_BODY = 1024 * 1024;
const APPS_TTL_MS = 15_000;

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
  /** The user's MIND apps (Gmail connected? GitHub?), asked with the owner's own key. Absent or undefined = could not be asked. */
  integrations?: (owner: string) => Promise<SetupApp[] | undefined>;
  /** Does this owner have a MIND key of their own (the owner access-code login has none)? */
  hasKey?: (owner: string) => boolean;
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
  const hooks: Pick<BotManageHooks, "runRoutine" | "continueThread" | "publicBase" | "setup"> = {
    publicBase: () => d.publicBase(),
    setup: (owner, trigger, o) => setupFor(owner, trigger, o ?? {}),
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

  // ---------------------------------------------------------------- set up: what a trigger needs, checked live
  const appsCache = new Map<string, { at: number; apps: SetupApp[] }>();
  async function appsFor(owner: string, fresh: boolean): Promise<SetupApp[] | undefined> {
    const hit = appsCache.get(owner);
    if (hit && !fresh && Date.now() - hit.at < APPS_TTL_MS) return hit.apps;
    let apps: SetupApp[] | undefined;
    try { apps = await d.integrations?.(owner); } catch { apps = undefined; }
    if (apps) appsCache.set(owner, { at: Date.now(), apps });
    return apps ?? (hit && Date.now() - hit.at < 5 * 60_000 ? hit.apps : undefined);
  }
  /** True when the trigger is well-formed (a bad value is answered with its own 400 by the store, before any setup talk). */
  const wellFormed = (t: unknown): boolean => { try { checkTrigger(t, d.hub.caps); return true; } catch { return false; } };
  async function setupFor(owner: string, trigger: unknown, o: { routineId?: string; botId?: string; fresh?: boolean } = {}): Promise<SetupReport> {
    const type = trigger && typeof trigger === "object" ? (trigger as Record<string, unknown>).type : undefined;
    const needs = typeof type === "string" ? DEFS.get(type as never)?.needs ?? [] : [];
    const routine = o.routineId && o.botId ? d.hub.book(owner, o.botId).get(o.routineId) : undefined;
    return checkSetup(trigger, {
      hasKey: d.hasKey ? d.hasKey(owner) : !!d.mindCall,
      apps: needs.includes("mail") || needs.includes("github") ? await appsFor(owner, o.fresh === true) : undefined,
      screen: d.screen?.state(),
      saved: !!routine,
      lastDeliveryAt: routine?.health?.deliveredAt,
    });
  }

  // ---------------------------------------------------------------- GitHub: pushed to us, signed with the routine's secret
  const ghIpLimit = new TurnRateLimiter({ max: 600, windowMs: 60_000 });   // GitHub's few sending addresses serve every user: generous
  const ghLimit = new TurnRateLimiter({ max: 60, windowMs: 60_000 });     // per routine
  const lastBadSig = new Map<string, number>();

  /** One GitHub delivery (a real one, or the Send test event button: both go through here, signature check included). */
  async function deliverGithub(a: { routineId: string; event: string; delivery: string; signature: string | undefined; body: Buffer }): Promise<{ status: number; body: Record<string, unknown> }> {
    let hit = d.hub.find(a.routineId);
    if (!hit && Date.now() - d.hub.scannedAt > 5000) { d.hub.scan(d.ownerOk); hit = d.hub.find(a.routineId); }
    if (!hit || !isGithub(hit.routine.trigger?.type)) return { status: 404, body: { error: "not found" } };
    const { book, routine } = hit;
    const now = Date.now();
    if (!verifyGithubSignature(routine.secret, a.body, a.signature)) {
      if (now - (lastBadSig.get(routine.id) ?? 0) > 60_000) {   // one disk write a minute, however hard it is hammered
        lastBadSig.set(routine.id, now);
        book.noteHealth(routine.id, { checkedAt: now, error: a.signature ? "A delivery with a wrong signature was refused. The secret in GitHub must be the one shown here." : "A delivery without a signature was refused. Set the secret in GitHub's webhook settings." });
      }
      return { status: 401, body: { error: "bad signature" } };
    }
    book.noteHealth(routine.id, { checkedAt: now, deliveredAt: now, error: null });
    if (a.event === "ping") return { status: 200, body: { ok: true, pong: true } };
    const w = ghLimit.take(routine.id);
    if (w > 0) return { status: 429, body: { error: "this routine is being called too fast" } };
    let payload: unknown;
    try { payload = JSON.parse(a.body.toString("utf8")); } catch { return { status: 400, body: { error: "the body is not JSON (set the content type to application/json)" } }; }
    const ev = githubEvent(a.event, payload);
    if (!ev) return { status: 202, body: { ok: true, ignored: "GitHub event not used by any trigger" } };
    if (!githubWants(routine.trigger!, ev)) return { status: 202, body: { ok: true, ignored: "not this routine's event, repository or branch" } };
    if (!routine.enabled) return { status: 409, body: { error: "this routine is turned off" } };
    if (a.delivery && !book.markDelivery(routine.id, a.delivery)) return { status: 200, body: { ok: true, duplicate: true } };
    const ran = runner.fireRoutine(book.owner, book.botId, routine.id, ev.text);
    return { status: 202, body: { ok: true, routine: routine.id, status: ran ? "started" : "not run", ...(ran ? {} : { why: "outside this routine's weekdays and active hours, or rate limited" }) } };
  }

  async function github(req: IncomingMessage, res: ServerResponse, routineId: string): Promise<void> {
    if ((req.method ?? "GET") !== "POST") return d.sendJson(res, 405, { error: "use POST" });
    const wait = ghIpLimit.take(d.clientIp(req));
    if (wait > 0) { res.setHeader("retry-after", String(wait)); return d.sendJson(res, 429, { error: "too many requests" }); }
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > GITHUB_MAX_BODY) return d.sendJson(res, 413, { error: "body too large (1 MB max)" });
    let body: Buffer;
    try { body = await d.readBody(req, GITHUB_MAX_BODY); } catch { return d.sendJson(res, 413, { error: "body too large (1 MB max)" }); }
    const h = (k: string): string => { const v = req.headers[k]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
    const r = await deliverGithub({ routineId, event: h("x-github-event").slice(0, 60), delivery: h("x-github-delivery").slice(0, 80), signature: h("x-hub-signature-256") || undefined, body });
    return d.sendJson(res, r.status, r.body);
  }

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
    const m = /^\/bots\/([^/]+)\/routines(?:\/(r_[0-9a-f]{12})(?:\/(run|rotate|test))?|\/(setup))?$/.exec(path);
    if (!m) return false;
    const bots = rt.bots;
    if (!bots) return d.sendJson(res, 404, { error: "bots are not enabled on this deployment" }), true;
    let botId: string;
    try { botId = decodeURIComponent(m[1]); } catch { return d.sendJson(res, 400, { error: "bad bot id" }), true; }
    if (!bots.get(botId)) return d.sendJson(res, 404, { error: "not_found", message: "no such bot" }), true;
    const book = d.hub.book(me.id, botId);
    const view = async (rid: string, fresh = false) => { const r = book.get(rid)!; return routineView(r, base(req), r.kind === "trigger" && !r.builtin ? await setupFor(me.id, r.trigger, { routineId: rid, botId, fresh }) : undefined); };
    const needsSetup = (setup: SetupReport) => d.sendJson(res, 409, { error: "needs_setup", message: `It is not ready to turn on yet. ${setup.missing.join(" ")}`, setup });
    try {
      if (m[4] === "setup") {
        if (method !== "POST") return d.sendJson(res, 405, { error: "method not allowed" }), true;
        const b = await d.readJson(req);
        const rid = typeof b.routineId === "string" && /^r_[0-9a-f]{12}$/.test(b.routineId) && book.get(b.routineId) ? b.routineId : undefined;
        const setup = await setupFor(me.id, b.trigger, { routineId: rid, botId, fresh: b.fresh === true });
        return d.sendJson(res, 200, { ...setup, ...(rid ? { routine: await view(rid) } : {}) }), true;
      }
      if (!m[2]) {
        if (method === "GET") {
          const rows = await Promise.all(book.list().map(async (r) => routineView(r, base(req), r.kind === "trigger" && !r.builtin ? await setupFor(me.id, r.trigger, { routineId: r.id, botId }) : undefined)));
          return d.sendJson(res, 200, { routines: rows, running: book.list().filter((r) => runner.isRunning(r.id)).map((r) => r.id) }), true;
        }
        if (method === "POST") {
          const b = await d.readJson(req);
          // A trigger that is not set up yet can be saved, but only turned off.
          if (b.kind === "trigger" && b.enabled !== false && wellFormed(b.trigger)) { const setup = await setupFor(me.id, b.trigger, { botId, fresh: true }); if (!setup.ready) return needsSetup(setup), true; }
          const r = book.add(b);
          return d.sendJson(res, 200, { routine: await view(r.id) }), true;
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
        return d.sendJson(res, 200, { ok: true, running: runner.isRunning(rid), routine: await view(rid) }), true;
      }
      if (m[3] === "rotate") {
        if (method !== "POST") return d.sendJson(res, 405, { error: "method not allowed" }), true;
        book.rotateSecret(rid);
        return d.sendJson(res, 200, { routine: await view(rid) }), true;
      }
      if (m[3] === "test") {
        if (method !== "POST") return d.sendJson(res, 405, { error: "method not allowed" }), true;
        const r = book.get(rid)!;
        const type = r.trigger?.type;
        if (r.kind !== "trigger" || !type || !(type === "webhook" || isGithub(type))) return d.sendJson(res, 400, { error: "no_test", message: "Only a webhook or GitHub routine has a test event. Use Run now for the others." }), true;
        if (!r.enabled) return d.sendJson(res, 409, { error: "off", message: "Turn the routine on first, then send the test event." }), true;
        let out: { status: number; body: Record<string, unknown> };
        let done: Promise<void> | undefined;
        if (type === "webhook") {
          const f = runner.webhook(rid, JSON.stringify({ test: true, note: "Test event sent from the Routines settings in Daebot." }));
          out = f.ok ? { status: 202, body: { ok: true, status: "started" } } : { status: f.code, body: { error: f.error } };
          done = f.ok ? f.done : undefined;
        } else {
          const sample = sampleGithub(type, r.trigger?.repo ?? "", r.trigger?.branch);
          const body = Buffer.from(sample.body);
          out = await deliverGithub({ routineId: rid, event: sample.event, delivery: `test-${randomUUID()}`, signature: signGithub(r.secret ?? "", body), body });
        }
        if (done) await Promise.race([done, new Promise((x) => setTimeout(x, 8000))]);
        else await new Promise((x) => setTimeout(x, 300));
        const ok = out.status >= 200 && out.status < 300;
        return d.sendJson(res, ok ? 200 : out.status, { ok, ...out.body, message: ok ? "Test event sent. The run shows in this routine's history and its thread." : String(out.body.error ?? "the test event did not run"), routine: await view(rid, true) }), true;
      }
      if (method === "PATCH") {
        const b = await d.readJson(req);
        const cur = book.get(rid)!;
        const resulting = b.enabled !== undefined ? b.enabled === true : cur.enabled;
        if (cur.kind === "trigger" && !cur.builtin && resulting && (b.enabled === true || b.trigger !== undefined) && wellFormed(b.trigger !== undefined ? b.trigger : cur.trigger)) {
          const next = b.trigger !== undefined && typeof b.trigger === "object" && b.trigger ? (cur.trigger && (b.trigger as { type?: unknown }).type === cur.trigger.type ? { ...cur.trigger, ...(b.trigger as object) } : b.trigger) : cur.trigger;
          const setup = await setupFor(me.id, next, { routineId: rid, botId, fresh: true });
          if (!setup.ready) return needsSetup(setup), true;
        }
        book.update(rid, b);
        return d.sendJson(res, 200, { routine: await view(rid) }), true;
      }
      if (method === "DELETE") { book.remove(rid); return d.sendJson(res, 200, { ok: true }), true; }
      if (method === "GET") return d.sendJson(res, 200, { routine: await view(rid), runs: book.get(rid)!.runs ?? [] }), true;
      return d.sendJson(res, 405, { error: "method not allowed" }), true;
    } catch (e) {
      if (e instanceof RoutineError) return d.sendJson(res, e.status, { error: "routine", message: e.message }), true;
      throw e;
    }
  }

  return { runner, hooks, webhook, github, api, deliverGithub, setupFor };
}
