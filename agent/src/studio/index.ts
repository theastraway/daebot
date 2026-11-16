// Daebot Studio: the user's bots as workers in an office. This module is the pure assembler behind GET /studio: it takes what the
// runtime already knows (bots, sessions, board rows, pending permission cards, bot_talk exchanges, the router chip) and returns one
// view the web draws as an isometric floor. Nothing here reads a file or calls the network, and no text from the model is trusted:
// every string is clipped to one line. Departments are the islands (a bot's `department`, "General" when unset; the main Daebot sits
// in the Manager office). The yellow "N waiting approval" badge counts what needs the user: a stopped board row (a question or an
// awaiting-decision item) and a pending permission card, per bot and per island.
import type { BoardRow, BoardStatus } from "../board/board.ts";
import type { TurnProof } from "../types.ts";

export type BotStatus = "idle" | "working" | "blocked";
export type NeedKind = "question" | "decision" | "permission";

export interface StudioBotIn { id: string; slug: string; name: string; color?: string; face?: string; department?: string; purpose?: string }
export interface StudioSessionIn { id: string; title: string; updatedAt: number; bot?: string; peer?: string; running?: boolean }
/** A board row with the bot it belongs to (absent = a main session). */
export type StudioRowIn = BoardRow & { bot?: string };
export interface StudioPendingIn { id: string; sessionId: string; tool?: string }
export interface StudioExchangeIn { a: string; b: string; updatedAt: number; count: number; id?: string; last?: { from: string; text: string; at: number; kind: "message" | "reply" } }

export interface StudioInput {
  main: { name: string; color?: string; face?: string };
  bots: readonly StudioBotIn[];
  sessions: readonly StudioSessionIn[];
  rows: readonly StudioRowIn[];
  pending: readonly StudioPendingIn[];
  exchanges: readonly StudioExchangeIn[];
  chip: { mode: string; model: string; tier?: string };
  now: number;
}

export interface StudioTask { id: string; sessionId: string; sessionTitle: string; title: string; status: BoardStatus; question?: string; updatedAt: number; bot: string; botName: string; department: string; project?: string; peer?: boolean; inMind: boolean }
export interface StudioNeed { kind: NeedKind; sessionId: string; title: string; question?: string; bot: string; botName: string; department: string; at: number; taskId?: string; pendingId?: string }
export interface StudioBot { id: string; slug: string; name: string; color: string; face?: string; department: string; purpose: string; status: BotStatus; needs: number; task?: { id: string; sessionId: string; title: string; status: BoardStatus }; lastSeen: number; sessions: number; /** The last human turn of this bot's newest session (what ran, verified or not, the model). */ proof?: TurnProof }
/** A Life project seen on the board, with how its tasks stand (the left panel's progress bars). */
export interface StudioProject { id: string; name: string; total: number; done: number; working: number; waiting: number; next: number }
/** A bot_talk exchange for the Meeting room: who, how many messages, the last line. */
export interface StudioMeeting { id: string; a: string; b: string; aName: string; bName: string; updatedAt: number; count: number; last?: { from: string; fromName: string; text: string; at: number; kind: "message" | "reply" } }
export interface StudioDepartment { slug: string; name: string; color: string; bots: string[]; counts: { done: number; working: number; next: number; waiting: number }; needsYou: number; lead: string }
export interface StudioLink { a: string; b: string; count: number; at: number }
export interface StudioView {
  at: number;
  name: string;
  chip: { mode: string; model: string; tier?: string };
  departments: StudioDepartment[];
  bots: StudioBot[];
  tasks: StudioTask[];
  needsYou: StudioNeed[];
  links: StudioLink[];
  projects: StudioProject[];
  meetings: StudioMeeting[];
  /** The last day: tasks that became ready to test, and sessions that moved. */
  today: { completed: number; moved: number };
  brain: { bots: number; sessions: number; tasks: number; inMind: number; decisions: number; working: number; waiting: number };
}

export const MAIN_ID = "main";
export const MANAGER_DEPT = { slug: "manager-office", name: "Manager office" } as const;
export const GENERAL_DEPT = { slug: "general", name: "General" } as const;
export const MAX_DEPARTMENT = 40;
export const MAX_TASKS = 80;
export const MAX_NEEDS = 40;
export const MAX_MEETINGS = 20;
export const DAY_MS = 24 * 60 * 60 * 1000;
/** A bot with an in-progress row touched this recently counts as working even when no turn is in flight right now. */
export const WORKING_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_COLOR = "#ffd25a";
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const STATUS_ORDER: Record<BoardStatus, number> = { stopped: 0, in_progress: 1, not_started: 2, ready_to_test: 3, cancelled: 4 };

// eslint-disable-next-line no-control-regex
const oneLine = (v: unknown, max: number): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** A department name as the user typed it, clipped to one line; empty when it is blank. */
export function cleanDepartment(v: unknown): string {
  return oneLine(v, MAX_DEPARTMENT);
}

/** The island key of a department name: lower-case, dashes, never empty. */
export function departmentSlug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return s || GENERAL_DEPT.slug;
}

const safeColor = (c: unknown): string => (typeof c === "string" && COLOR_RE.test(c.trim()) ? c.trim().toLowerCase() : DEFAULT_COLOR);

/** The user's "needs you" items on the board: a stopped row is a question, or an awaiting decision when a peer raised it. */
export function needsOfRows(rows: readonly StudioRowIn[], who: (bot: string | undefined) => { bot: string; botName: string; department: string }): StudioNeed[] {
  const out: StudioNeed[] = [];
  for (const r of rows) {
    if (!r || r.status !== "stopped") continue;
    const w = who(r.bot);
    out.push({ kind: r.peer ? "decision" : "question", sessionId: r.sessionId, title: oneLine(r.title, 140), ...(r.question ? { question: oneLine(r.question, 300) } : {}), bot: w.bot, botName: w.botName, department: w.department, at: r.updatedAt, taskId: r.id });
  }
  return out;
}

/** The whole floor from the runtime's facts. Pure; the same input always gives the same view. */
export function assembleStudio(input: StudioInput): StudioView {
  const now = input.now;
  const byBot = new Map<string, StudioBotIn>();
  for (const b of input.bots) byBot.set(b.id, b);
  const deptOf = (b: StudioBotIn | undefined): { slug: string; name: string } => {
    if (!b) return MANAGER_DEPT;
    const name = cleanDepartment(b.department);
    return name ? { slug: departmentSlug(name), name } : GENERAL_DEPT;
  };
  const who = (bot: string | undefined) => {
    const b = bot ? byBot.get(bot) : undefined;
    if (bot && !b) return { bot, botName: "a deleted bot", department: GENERAL_DEPT.slug };
    return { bot: b ? b.id : MAIN_ID, botName: b ? oneLine(b.name, 80) : oneLine(input.main.name, 80) || "Daebot", department: deptOf(b).slug };
  };
  // Sessions per bot: how many, the latest touch, and whether a turn is in flight.
  const sessionsOf = new Map<string, { n: number; last: number; running: boolean }>();
  const sessionBot = new Map<string, string>();
  const sess = new Map<string, StudioSessionIn>();
  for (const s of input.sessions) {
    if (!s || typeof s.id !== "string" || s.peer) continue;
    const key = s.bot && byBot.has(s.bot) ? s.bot : s.bot ? "" : MAIN_ID;
    if (!key) continue;
    sessionBot.set(s.id, key);
    sess.set(s.id, s);
    const cur = sessionsOf.get(key) ?? { n: 0, last: 0, running: false };
    cur.n++; cur.last = Math.max(cur.last, s.updatedAt || 0); cur.running = cur.running || !!s.running;
    sessionsOf.set(key, cur);
  }
  // Tasks: every board row with its owner, newest and most urgent first.
  const tasks: StudioTask[] = [];
  const seen = new Set<string>();
  for (const r of input.rows) {
    if (!r || typeof r.sessionId !== "string" || typeof r.id !== "string") continue;
    const key = `${r.sessionId}/${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const w = who(r.bot);
    tasks.push({ id: r.id, sessionId: r.sessionId, sessionTitle: oneLine(r.sessionTitle, 120), title: oneLine(r.title, 140), status: r.status, ...(r.question ? { question: oneLine(r.question, 300) } : {}), updatedAt: r.updatedAt || 0, bot: w.bot, botName: w.botName, department: w.department, ...(r.project?.name ? { project: oneLine(r.project.name, 120) } : {}), ...(r.peer ? { peer: true } : {}), inMind: !!r.lifeId });
  }
  tasks.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt - a.updatedAt);
  // Needs you: stopped rows, then pending permission cards (attributed to the session's bot).
  const needs = needsOfRows(input.rows, who);
  for (const p of input.pending) {
    if (!p || typeof p.sessionId !== "string") continue;
    const owner = sessionBot.get(p.sessionId);
    const w = who(owner === MAIN_ID ? undefined : owner);
    needs.push({ kind: "permission", sessionId: p.sessionId, title: p.tool ? `Permission: ${oneLine(p.tool, 60)}` : "Permission to run a tool", bot: w.bot, botName: w.botName, department: w.department, at: now, pendingId: p.id });
  }
  needs.sort((a, b) => b.at - a.at);
  const needsBy = new Map<string, number>();
  for (const n of needs) needsBy.set(n.bot, (needsBy.get(n.bot) ?? 0) + 1);
  // Bots, the main Daebot first (it is the manager).
  const proofFor = (bot: string): TurnProof | undefined => {
    let best: TurnProof | undefined;
    for (const r of input.rows) { const owner = r?.bot ?? MAIN_ID; if (owner !== bot || !r.proof) continue; if (!best || r.proof.at > best.at) best = r.proof; }
    return best;
  };
  const taskFor = (bot: string): StudioBot["task"] => {
    const t = tasks.find((x) => x.bot === bot && x.status !== "cancelled");
    return t ? { id: t.id, sessionId: t.sessionId, title: t.title, status: t.status } : undefined;
  };
  const statusOf = (bot: string): BotStatus => {
    if (needsBy.get(bot)) return "blocked";
    const s = sessionsOf.get(bot);
    if (s?.running) return "working";
    if (tasks.some((t) => t.bot === bot && t.status === "in_progress" && now - t.updatedAt <= WORKING_WINDOW_MS)) return "working";
    return "idle";
  };
  const bots: StudioBot[] = [];
  const mainSessions = sessionsOf.get(MAIN_ID);
  bots.push({ id: MAIN_ID, slug: MAIN_ID, name: oneLine(input.main.name, 80) || "Daebot", color: safeColor(input.main.color), ...(input.main.face ? { face: input.main.face } : {}), department: MANAGER_DEPT.slug, purpose: "Your main Daebot: plans, builds, verifies and directs your bots.", status: statusOf(MAIN_ID), needs: needsBy.get(MAIN_ID) ?? 0, ...(taskFor(MAIN_ID) ? { task: taskFor(MAIN_ID) } : {}), lastSeen: mainSessions?.last ?? 0, sessions: mainSessions?.n ?? 0, ...(proofFor(MAIN_ID) ? { proof: proofFor(MAIN_ID) } : {}) });
  for (const b of [...input.bots].sort((x, y) => oneLine(x.name, 80).localeCompare(oneLine(y.name, 80)))) {
    const s = sessionsOf.get(b.id);
    bots.push({ id: b.id, slug: b.slug, name: oneLine(b.name, 80), color: safeColor(b.color), ...(b.face ? { face: b.face } : {}), department: deptOf(b).slug, purpose: oneLine(b.purpose, 140), status: statusOf(b.id), needs: needsBy.get(b.id) ?? 0, ...(taskFor(b.id) ? { task: taskFor(b.id) } : {}), lastSeen: s?.last ?? 0, sessions: s?.n ?? 0, ...(proofFor(b.id) ? { proof: proofFor(b.id) } : {}) });
  }
  // Departments: the Manager office first, then the user's, alphabetically; General last when it exists.
  const depts = new Map<string, StudioDepartment>();
  const dept = (slug: string, name: string, color: string): StudioDepartment => {
    let d = depts.get(slug);
    if (!d) { d = { slug, name, color, bots: [], counts: { done: 0, working: 0, next: 0, waiting: 0 }, needsYou: 0, lead: "" }; depts.set(slug, d); }
    return d;
  };
  for (const b of bots) {
    const src = b.id === MAIN_ID ? undefined : byBot.get(b.id);
    const d0 = deptOf(src);
    const d = dept(d0.slug, d0.name, b.color);
    d.bots.push(b.id);
    if (!d.lead) d.lead = b.id;
  }
  for (const t of tasks) {
    const d = depts.get(t.department) ?? dept(GENERAL_DEPT.slug, GENERAL_DEPT.name, DEFAULT_COLOR);
    if (t.status === "ready_to_test") d.counts.done++;
    else if (t.status === "in_progress") d.counts.working++;
    else if (t.status === "not_started") d.counts.next++;
  }
  for (const n of needs) { const d = depts.get(n.department) ?? dept(GENERAL_DEPT.slug, GENERAL_DEPT.name, DEFAULT_COLOR); d.counts.waiting++; d.needsYou++; }
  const order = (d: StudioDepartment): string => (d.slug === MANAGER_DEPT.slug ? "0" : d.slug === GENERAL_DEPT.slug ? "2" : "1") + d.name.toLowerCase();
  const departments = [...depts.values()].sort((a, b) => order(a).localeCompare(order(b)));
  // Links: bot_talk traffic between islands, from the exchange list (party ids are bot ids or "main").
  const linkBy = new Map<string, StudioLink>();
  for (const x of input.exchanges) {
    if (!x || typeof x.a !== "string" || typeof x.b !== "string") continue;
    const da = who(x.a === MAIN_ID ? undefined : x.a).department, db = who(x.b === MAIN_ID ? undefined : x.b).department;
    const [p, q] = da <= db ? [da, db] : [db, da];
    const key = `${p}|${q}`;
    const cur = linkBy.get(key) ?? { a: p, b: q, count: 0, at: 0 };
    cur.count += Math.max(0, x.count | 0); cur.at = Math.max(cur.at, x.updatedAt || 0);
    linkBy.set(key, cur);
  }
  const links = [...linkBy.values()].sort((a, b) => b.at - a.at).slice(0, 60);
  // Meetings: the exchanges themselves, newest first, with names (for the Meeting room and the communication log).
  const nameOf = (p: string): string => who(p === MAIN_ID ? undefined : p).botName;
  const meetings: StudioMeeting[] = input.exchanges.filter((x) => x && typeof x.id === "string" && typeof x.a === "string" && typeof x.b === "string")
    .sort((p, q) => (q.updatedAt || 0) - (p.updatedAt || 0)).slice(0, MAX_MEETINGS)
    .map((x) => ({ id: x.id!, a: x.a, b: x.b, aName: nameOf(x.a), bName: nameOf(x.b), updatedAt: x.updatedAt || 0, count: Math.max(0, x.count | 0),
      ...(x.last ? { last: { from: x.last.from, fromName: nameOf(x.last.from), text: oneLine(x.last.text, 200), at: x.last.at || 0, kind: x.last.kind === "reply" ? "reply" as const : "message" as const } } : {}) }));
  // Projects: every Life project named on the board, with its tasks' standing.
  const projBy = new Map<string, StudioProject>();
  for (const r of input.rows) {
    if (!r?.project?.id || !r.project.name || r.status === "cancelled") continue;
    const id = oneLine(r.project.id, 80);
    const p = projBy.get(id) ?? { id, name: oneLine(r.project.name, 120), total: 0, done: 0, working: 0, waiting: 0, next: 0 };
    p.total++;
    if (r.status === "ready_to_test") p.done++; else if (r.status === "in_progress") p.working++; else if (r.status === "stopped") p.waiting++; else p.next++;
    projBy.set(id, p);
  }
  const projects = [...projBy.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).slice(0, 20);
  const today = {
    completed: tasks.filter((t) => t.status === "ready_to_test" && now - t.updatedAt <= DAY_MS).length,
    moved: [...sess.values()].filter((s) => now - (s.updatedAt || 0) <= DAY_MS).length,
  };
  return {
    at: now,
    name: oneLine(input.main.name, 80) || "Daebot",
    chip: { mode: oneLine(input.chip.mode, 20), model: oneLine(input.chip.model, 120), ...(input.chip.tier ? { tier: oneLine(input.chip.tier, 20) } : {}) },
    departments, bots,
    tasks: tasks.slice(0, MAX_TASKS),
    needsYou: needs.slice(0, MAX_NEEDS),
    links, projects, meetings, today,
    brain: {
      bots: input.bots.length, sessions: sessionBot.size, tasks: tasks.filter((t) => t.status !== "cancelled").length,
      inMind: tasks.filter((t) => t.inMind).length, decisions: tasks.filter((t) => t.peer).length,
      working: bots.filter((b) => b.status === "working").length, waiting: needs.length,
    },
  };
}
