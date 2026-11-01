// The task board: what Daebot is actually carrying out, per session, with the same traffic-light colors as the Astra AI client portal
// (red = not started, yellow = in progress, green = ready to test). In Daebot red ALSO means stopped: a question or a decision
// is waiting on the user. A card exists only when Daebot declares a task with the task_board tool (stored with the session).
// A conversation, a question or a chat turn is never a card.
//
// Every declared task is linked to the user's own MIND: it carries a scope (Astra AI or MIND), the LIFE project it belongs to, the LIFE
// item that mirrors it, and (when a choice was involved) the OOC/EMR decision document that was written for it. See board/mind.ts.
import type { Tool } from "../types.ts";

export type BoardStatus = "not_started" | "in_progress" | "ready_to_test" | "stopped" | "cancelled";
export const BOARD_STATUSES: readonly BoardStatus[] = ["not_started", "in_progress", "ready_to_test", "stopped", "cancelled"];
/** Statuses the model may set by hand (cancelled has its own action, so a task is never cancelled by accident). */
const MODEL_STATUSES: readonly BoardStatus[] = ["not_started", "in_progress", "ready_to_test", "stopped"];

/** Which side of the business a task belongs to. Derived from the MIND Focus or Project it links to, never guessed. */
export type BoardScope = "astra" | "mind";
export const SCOPE_LABEL: Record<BoardScope, string> = { astra: "Astra AI", mind: "MIND" };

/** A peer-requested action waiting for the user, with the OOC/EMR decision receipts of both agents (MIND document ids). */
export interface PeerDecisionInfo { issuer: string; receiver: string; tool: string }
/** The MIND LIFE project a task lives under. */
export interface BoardProject { id: string; name: string; focus?: string }
/** The OOC/EMR decision written for a task: the MIND document id, what was decided and the winning option. `local` = MIND was unreachable, so the id is a local receipt. */
export interface BoardDecision { id: string; subject: string; winner: string; local?: boolean }
export interface BoardTask {
  id: string; title: string; status: BoardStatus; question?: string; updatedAt: number;
  /** set only on a red "awaiting decision" item raised by a peer request */
  peer?: PeerDecisionInfo;
  scope?: BoardScope;
  project?: BoardProject;
  /** The LIFE item (outcome) in the user's MIND that mirrors this task, and the LIFE status last pushed or seen there. */
  lifeId?: string;
  lifeStatus?: string;
  /** Why the MIND side is not in step ("Not saved to MIND: ..."), shown on the card. */
  sync?: string;
  decision?: BoardDecision;
}

/** One row of GET /board. */
export interface BoardRow extends BoardTask { sessionId: string; sessionTitle: string }

export const MAX_TASKS = 30;
const ID_OK = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_TITLE = 140;
const MAX_QUESTION = 600;

// eslint-disable-next-line no-control-regex
const oneLine = (v: unknown, max: number): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
// Questions keep their line breaks (a decision may list options) but lose control characters.
// eslint-disable-next-line no-control-regex
const multiLine = (v: unknown, max: number): string => String(v ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max);

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** The MIND link, decision and sync note of a task, read defensively from a record the runtime wrote (never from the model). */
function extrasOf(src: unknown): Partial<BoardTask> {
  if (!src || typeof src !== "object") return {};
  const r = src as Record<string, unknown>;
  const out: Partial<BoardTask> = {};
  if (r.scope === "astra" || r.scope === "mind") out.scope = r.scope;
  const p = r.project as Record<string, unknown> | undefined;
  if (p && typeof p === "object" && oneLine(p.id, 80) && oneLine(p.name, 120)) out.project = { id: oneLine(p.id, 80), name: oneLine(p.name, 120), ...(oneLine(p.focus, 120) ? { focus: oneLine(p.focus, 120) } : {}) };
  if (typeof r.lifeId === "string" && r.lifeId.trim()) out.lifeId = oneLine(r.lifeId, 80);
  if (typeof r.lifeStatus === "string" && r.lifeStatus.trim()) out.lifeStatus = oneLine(r.lifeStatus, 30);
  if (typeof r.sync === "string" && r.sync.trim()) out.sync = oneLine(r.sync, 200);
  const d = r.decision as Record<string, unknown> | undefined;
  if (d && typeof d === "object" && oneLine(d.id, 120) && oneLine(d.winner, 200)) out.decision = { id: oneLine(d.id, 120), subject: oneLine(d.subject, 120), winner: oneLine(d.winner, 200), ...(d.local === true ? { local: true } : {}) };
  return out;
}

/** Validates one task as the model wrote it. A stopped task needs its question; any other status carries none. MIND link fields are carried from `prev` (or `trusted`), never taken from the model. */
export function checkTask(raw: unknown, now: number, prev?: BoardTask, trustedPeer?: unknown, trusted?: unknown): Checked<BoardTask> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "each task must be an object {id, title, status, question?}" };
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!ID_OK.test(id)) return { ok: false, error: "task id must be 1-40 letters, digits, '-', '_' or '.' (no spaces)" };
  const title = r.title === undefined && prev ? prev.title : oneLine(r.title, MAX_TITLE);
  if (!title) return { ok: false, error: `task ${id}: title is required` };
  const status = r.status === undefined && prev ? prev.status : r.status;
  if (typeof status !== "string" || !BOARD_STATUSES.includes(status as BoardStatus)) return { ok: false, error: `task ${id}: status must be one of ${MODEL_STATUSES.join(", ")}` };
  const out: BoardTask = { id, title, status: status as BoardStatus, updatedAt: now, ...extrasOf(trusted ?? prev) };
  if (status === "stopped") {
    const q = r.question === undefined && prev?.status === "stopped" ? prev.question ?? "" : multiLine(r.question, MAX_QUESTION);
    if (!q) return { ok: false, error: `task ${id}: a stopped task needs "question": the exact question or decision the user must answer` };
    out.question = q;
  }
  // A peer "awaiting decision" item keeps its receipts (only the runtime sets them; the model's task_board tool cannot).
  const pr = (trustedPeer && typeof trustedPeer === "object" ? trustedPeer : prev?.peer) as Record<string, unknown> | undefined;
  if (pr && status === "stopped") {
    const g = (k: string) => oneLine(pr[k], 120);
    if (g("issuer") && g("receiver")) out.peer = { issuer: g("issuer"), receiver: g("receiver"), tool: g("tool") };
  }
  return { ok: true, value: out };
}

/** Replaces the whole board. Ids must be unique; at most MAX_TASKS. */
export function checkTaskList(raw: unknown, now: number, prev: BoardTask[] = []): Checked<BoardTask[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "tasks must be a list" };
  if (raw.length > MAX_TASKS) return { ok: false, error: `at most ${MAX_TASKS} tasks on the board` };
  const seen = new Set<string>();
  const out: BoardTask[] = [];
  for (const t of raw) {
    const id = t && typeof t === "object" ? String((t as Record<string, unknown>).id ?? "").trim() : "";
    const before = prev.find((p) => p.id === id);
    const c = checkTask(t, now, before);
    if (!c.ok) return c;
    if ((c.value.status === "cancelled") !== (before?.status === "cancelled")) return { ok: false, error: `task ${c.value.id}: use action cancel to cancel a task; a cancelled task is not restarted` };
    if (seen.has(c.value.id)) return { ok: false, error: `duplicate task id ${c.value.id}` };
    seen.add(c.value.id);
    // A task the model re-lists unchanged keeps its old timestamp.
    out.push(before && before.title === c.value.title && before.status === c.value.status && before.question === c.value.question ? before : c.value);
  }
  return { ok: true, value: out };
}

/** The user answered: every stopped task goes back to in progress (the model stops it again if it still needs something). */
export function resumeStopped(tasks: BoardTask[], now: number): BoardTask[] {
  return tasks.map((t) => {
    if (t.status !== "stopped") return t;
    const { question: _q, peer: _p, ...rest } = t;
    return { ...rest, status: "in_progress" as const, updatedAt: now };
  });
}

/** Reads a stored board defensively (a hand-edited or old record never breaks the listing). */
export function loadTasks(raw: unknown): BoardTask[] {
  if (!Array.isArray(raw)) return [];
  const out: BoardTask[] = [];
  for (const t of raw.slice(0, MAX_TASKS)) {
    const c = checkTask(t, Number((t as { updatedAt?: unknown })?.updatedAt) || 0, undefined, (t as { peer?: unknown })?.peer, t);
    if (c.ok) out.push(c.value);
  }
  return out;
}

// ---------------------------------------------------------------- the MIND side

/** One LIFE project of the user, with the Focus it sits under and the scope that Focus (or the project's own name) says. */
export interface ProjectLite { id: string; name: string; focusId?: string; focus?: string; scope: BoardScope }

/** What the board needs from the user's own MIND. Built per runtime from that user's own client (board/mind.ts). */
export interface BoardMind {
  /** The user's real LIFE projects. */
  projects(): Promise<ProjectLite[]>;
  /** Finds or creates a LIFE project under the Focus that matches `scope` ("Astra AI" or "MIND"; the Focus is created when missing). */
  ensureProject(name: string, scope: BoardScope): Promise<ProjectLite>;
  /** Creates the LIFE item for a task (an outcome under its project). Returns the item id and the LIFE status it was created with. */
  create(t: BoardTask): Promise<{ lifeId: string; lifeStatus: string }>;
  /** Pushes the task's title and status to its LIFE item. Returns the LIFE status now set. */
  push(t: BoardTask): Promise<string>;
  /** Cancelled in Daebot: LIFE has no cancelled status, so the item is tagged "cancelled" and parked in Thoughts. Kept in history. */
  cancel(t: BoardTask): Promise<string>;
  /** Deleted from the board: the LIFE item is deleted too. */
  remove(t: BoardTask): Promise<void>;
  /** The items under one project with their current LIFE status (for the sync back). */
  pull(projectId: string): Promise<Map<string, string>>;
  /** Writes the decision document (a PRIVATE MIND document) and returns its id. */
  saveDecision(title: string, body: string): Promise<{ id: string; local?: boolean }>;
}

export interface BoardIO {
  get(sessionId: string): BoardTask[];
  set(sessionId: string, tasks: BoardTask[]): void;
  /** The user's own MIND. Absent = the board is local only (tests, a runtime with no MIND). */
  mind?: BoardMind;
}

const errText = (e: unknown): string => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 160);
const notSynced = (e: unknown): string => `Not saved to MIND: ${errText(e)}`;

/** The projects as the model sees them: id, name, focus and scope. */
export function projectLines(ps: ProjectLite[]): string {
  return ps.length ? ps.map((p) => `- ${p.name} [id ${p.id}] scope ${SCOPE_LABEL[p.scope]}${p.focus ? `, focus ${p.focus}` : ""}`).join("\n") : "(none yet)";
}

/** Links a brand-new task to a LIFE project and mirrors it into LIFE. A MIND outage never blocks the work: the card is declared with a plain "Not saved to MIND" note. */
export async function linkTask(mind: BoardMind, t: BoardTask, a: { project?: unknown; new_project?: unknown; scope?: unknown }): Promise<Checked<BoardTask>> {
  let projects: ProjectLite[];
  try { projects = await mind.projects(); } catch (e) { return { ok: true, value: { ...t, sync: notSynced(e) } }; }
  const want = typeof a.project === "string" ? a.project.trim() : "";
  const fresh = typeof a.new_project === "string" ? oneLine(a.new_project, 120) : "";
  let p: ProjectLite | undefined;
  if (want) {
    p = projects.find((x) => x.id === want) ?? projects.find((x) => x.name.toLowerCase() === want.toLowerCase());
    if (!p) return { ok: false, error: `task ${t.id}: no LIFE project ${JSON.stringify(want.slice(0, 60))}. The user's projects:\n${projectLines(projects)}\nPass project (an id or exact name from this list), or new_project with scope if none fits.` };
  } else if (fresh) {
    const scope = a.scope === "astra" || a.scope === "mind" ? a.scope : undefined;
    if (!scope) return { ok: false, error: `task ${t.id}: new_project needs scope: "astra" for Astra AI work (the consulting firm and its clients) or "mind" for the MIND product and the user's own life and work.` };
    p = projects.find((x) => x.name.toLowerCase() === fresh.toLowerCase() && x.scope === scope);
    if (!p) { try { p = await mind.ensureProject(fresh, scope); } catch (e) { return { ok: true, value: { ...t, sync: notSynced(e) } }; } }
  } else {
    return { ok: false, error: `task ${t.id}: choose the MIND LIFE project this task belongs to (never guess). The user's projects:\n${projectLines(projects)}\nPass project (an id or exact name), or new_project with scope ("astra" or "mind") if none fits.` };
  }
  const linked: BoardTask = { ...t, scope: p.scope, project: { id: p.id, name: p.name, ...(p.focus ? { focus: p.focus } : {}) } };
  try {
    const made = await mind.create(linked);
    const { sync: _s, ...clean } = linked;
    return { ok: true, value: { ...clean, lifeId: made.lifeId, lifeStatus: made.lifeStatus } };
  } catch (e) { return { ok: true, value: { ...linked, sync: notSynced(e) } }; }
}

/** After a status or title change: push it to the task's LIFE item and record what happened. */
export async function pushTask(mind: BoardMind | undefined, t: BoardTask): Promise<BoardTask> {
  if (!mind || !t.lifeId) return t;
  try {
    const lifeStatus = await mind.push(t);
    const { sync: _s, ...clean } = t;
    return { ...clean, lifeStatus };
  } catch (e) { return { ...t, sync: notSynced(e) }; }
}

/** Cancel: the card stays (history), its LIFE item is tagged and parked. */
export async function cancelTask(mind: BoardMind | undefined, t: BoardTask, now: number): Promise<BoardTask> {
  const { question: _q, peer: _p, ...rest } = t;
  const next: BoardTask = { ...rest, status: "cancelled", updatedAt: now };
  if (!mind || !t.lifeId) return next;
  try {
    const lifeStatus = await mind.cancel(next);
    const { sync: _s, ...clean } = next;
    return { ...clean, lifeStatus };
  } catch (e) { return { ...next, sync: notSynced(e) }; }
}

/** Delete: the LIFE item goes first; a failure other than "already gone" keeps the card so nothing is half-removed. */
export async function deleteLinked(mind: BoardMind | undefined, t: BoardTask): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!mind || !t.lifeId) return { ok: true };
  try { await mind.remove(t); return { ok: true }; } catch (e) {
    if (/\b404\b|not found/i.test(errText(e))) return { ok: true };
    return { ok: false, error: `Could not delete the LIFE item in MIND (${errText(e)}). The card is still on the board.` };
  }
}

// ---------------------------------------------------------------- prompt and tool

export const BOARD_PROMPT = [
  "## Task board",
  "The task board is the list of REAL WORK you are carrying out for the user, shown in a side panel as one colored box per task: red = not started, yellow = in progress, green = ready to test, red also means STOPPED (you are waiting on the user). Each task is mirrored into the user's own MIND LIFE board under a project, and shows whether it is Astra AI work or MIND work.",
  "- A task is multi-step work you are doing (build, research, fix, send, migrate, set up). A chat turn, a question, a lookup, an explanation, small talk or one tool call is NEVER a task: answer it and put nothing on the board. The conversation itself is never a card.",
  "- Declare a task with task_board (action update with id, title, status, and the project) BEFORE you start the work, set it in_progress when you start and ready_to_test when it is done and the user can try it. Declare each separate piece of work as its own task.",
  "- Project: every new task belongs to one of the user's MIND LIFE projects. If you do not know the project, call task_board action projects, choose the one that fits, and pass project (id or exact name). Never guess. Only when none fits, pass new_project plus scope (\"astra\" = Astra AI work: the consulting firm and its clients; \"mind\" = the MIND product and the user's own work). The scope shown on the card comes from the Focus the project sits under.",
  "- When you need an answer or a decision from the user, mark that task stopped with `question` (the exact question) INSTEAD OF only asking in chat. Then ask it in chat too, in one line. When the user answers, the board moves stopped tasks back to in progress for you.",
  "- Cancel (action cancel) and delete (action delete) only when the user asks. A cancelled task is stopped work: do not continue it.",
  "- Task titles are short and plain (what is being done), never secrets.",
].join("\n");

/** The stock decision skill, in every prompt where task_decision is offered (the main Daebot and every bot). */
export const DECISION_PROMPT = [
  "## Deciding on a task (OOC/EMR)",
  "When you start work that needs a CHOICE (reasonable people could pick differently, it costs money, or it reaches someone outside), run the Decision Protocol before you act and record it with task_decision: outcomes ranked (the user's aim first), at least four options with consequences and a score out of 10, the winner (one of the options, the highest score), the mitigations, one resolve sentence with an owner per step, and the winner's cost in dollars. It is filed as a PRIVATE MIND document in the user's own MIND (never the public feed). Where you have a task board, declare the task first and pass its task_id: the task card then shows Decision with the winner and a link to the document. Skip it for routine work with no real choice. A spend or an outward action still needs the user's yes.",
].join("\n");

const SET_ITEM_PROPS = {
  id: { type: "string", description: "short stable id, e.g. t1 or login-page" },
  title: { type: "string", description: "what is being done, one short line" },
  status: { type: "string", enum: MODEL_STATUSES },
  question: { type: "string", description: "required when status is stopped: the question or decision the user must answer" },
  project: { type: "string", description: "new tasks: the MIND LIFE project (id or exact name) this task belongs to" },
  new_project: { type: "string", description: "new tasks, only when no project fits: the name of a project to create" },
  scope: { type: "string", enum: ["astra", "mind"], description: "with new_project only: astra = Astra AI work, mind = MIND work" },
} as const;

export function createTaskBoardTool(io: BoardIO): Tool {
  return {
    spec: {
      name: "task_board",
      description:
        "Keep the user's task board: the list of real multi-step work you are carrying out, shown in a side panel as colored boxes (red = not started, yellow = in progress, green = ready to test) with its Astra AI or MIND scope and LIFE project. " +
        "Declare a task for work you are DOING (build, research, fix, send, migrate), never for a chat turn, a question, a lookup or an explanation. The conversation is not a task. " +
        "Every new task is linked to one of the user's MIND LIFE projects: call action \"projects\" to list them, then pass project (id or exact name) when you create the task; only when none fits pass new_project and scope. It is mirrored into the user's MIND LIFE. " +
        "When you need an answer or a decision from the user, set that task to \"stopped\" with `question` (required): it shows red as \"Waiting on you\" and the user can type the reply right there. " +
        "action \"update\" changes one task by id (add title, status and project to create it). action \"set\" replaces the list of tasks with `tasks`. action \"get\" returns the board. action \"projects\" lists the user's LIFE projects. " +
        "action \"cancel\" (id) stops a task and keeps it in history; action \"delete\" (id) removes it from the board and from MIND. Use cancel and delete only when the user asks. " +
        "A stopped task goes back to in_progress by itself when the user replies; mark it stopped again if you still need something. Mark a task ready_to_test only when the user can try it.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set", "update", "get", "projects", "cancel", "delete"] },
          tasks: {
            type: "array",
            description: "set: the full list of tasks",
            items: { type: "object", properties: SET_ITEM_PROPS, required: ["id", "title", "status"], additionalProperties: false },
          },
          id: { type: "string", description: "update, cancel, delete: the task id" },
          title: { type: "string", description: "update: new title (required when creating)" },
          status: { type: "string", enum: MODEL_STATUSES, description: "update: new status" },
          question: { type: "string", description: "update: the question (required when status is stopped)" },
          project: SET_ITEM_PROPS.project,
          new_project: SET_ITEM_PROPS.new_project,
          scope: SET_ITEM_PROPS.scope,
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    class: "write", // this chat's own board file plus the user's own MIND LIFE (their key); it reaches nothing else
    async run(args, ctx) {
      const action = typeof args.action === "string" ? args.action : "";
      const now = Date.now();
      const cur = io.get(ctx.sessionId);
      if (action === "get") return { ok: true, output: cur.length ? cur.map(line).join("\n") : "The board is empty." };
      if (ctx.origin === "bot") return { ok: false, output: "blocked: a message from another bot cannot edit the user's task board." };
      if (action === "projects") {
        if (!io.mind) return { ok: false, output: "task_board: MIND is not connected here, so there are no LIFE projects to list." };
        try { return { ok: true, output: `The user's MIND LIFE projects:\n${projectLines(await io.mind.projects())}` }; } catch (e) { return { ok: false, output: `task_board: could not read the LIFE projects (${errText(e)}).` }; }
      }
      if (action === "set") {
        const c = checkTaskList(args.tasks, now, cur);
        if (!c.ok) return { ok: false, output: `task_board: ${c.error}` };
        const raws = args.tasks as Record<string, unknown>[];
        const out: BoardTask[] = [];
        for (const t of c.value) {
          if (cur.some((p) => p.id === t.id)) { out.push(t === cur.find((p) => p.id === t.id) ? t : await pushTask(io.mind, t)); continue; }
          if (!io.mind) { out.push(t); continue; }
          const l = await linkTask(io.mind, t, raws.find((r) => String(r?.id ?? "").trim() === t.id) ?? {});
          if (!l.ok) return { ok: false, output: `task_board: ${l.error}` };
          out.push(l.value);
        }
        // A linked task the list leaves out is kept: removing one from MIND is a deliberate delete, never a side effect of a rewrite.
        const kept = cur.filter((p) => p.lifeId && !out.some((t) => t.id === p.id));
        if (out.length + kept.length > MAX_TASKS) return { ok: false, output: `task_board: at most ${MAX_TASKS} tasks on the board` };
        const all = [...out, ...kept];
        io.set(ctx.sessionId, all);
        return { ok: true, output: `Board set (${all.length} task${all.length === 1 ? "" : "s"}).\n${all.map(line).join("\n")}${kept.length ? `\n(${kept.length} linked task${kept.length === 1 ? " was" : "s were"} kept: use action delete to remove one.)` : ""}` };
      }
      if (action === "update") {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const prev = cur.find((t) => t.id === id);
        if (prev?.status === "cancelled") return { ok: false, output: `task_board: task ${id} was cancelled. Do not continue it. Declare a new task if the user wants it again.` };
        if (!prev && (args.title === undefined || args.status === undefined)) return { ok: false, output: `task_board: no task ${JSON.stringify(id)} on the board. Pass title and status to create it, or action set.` };
        if (!prev && cur.length >= MAX_TASKS) return { ok: false, output: `task_board: at most ${MAX_TASKS} tasks on the board` };
        if (typeof args.status === "string" && !MODEL_STATUSES.includes(args.status as BoardStatus)) return { ok: false, output: `task_board: status must be one of ${MODEL_STATUSES.join(", ")} (use action cancel to cancel)` };
        const c = checkTask({ id, title: args.title, status: args.status, question: args.question }, now, prev);
        if (!c.ok) return { ok: false, output: `task_board: ${c.error}` };
        let next = c.value;
        if (io.mind) {
          if (!prev || (!prev.lifeId && (args.project !== undefined || args.new_project !== undefined))) {
            const l = await linkTask(io.mind, next, args);
            if (!l.ok) return { ok: false, output: `task_board: ${l.error}` };
            next = l.value;
          } else if (prev.title !== next.title || prev.status !== next.status) next = await pushTask(io.mind, next);
        }
        io.set(ctx.sessionId, prev ? cur.map((t) => (t.id === id ? next : t)) : [...cur, next]);
        return { ok: true, output: `Task updated: ${line(next)}` };
      }
      if (action === "cancel" || action === "delete") {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const prev = cur.find((t) => t.id === id);
        if (!prev) return { ok: false, output: `task_board: no task ${JSON.stringify(id)} on the board.` };
        if (action === "cancel") {
          const next = await cancelTask(io.mind, prev, now);
          io.set(ctx.sessionId, cur.map((t) => (t.id === id ? next : t)));
          return { ok: true, output: `Task cancelled and kept in history: ${line(next)}${next.sync ? ` (${next.sync})` : ""}` };
        }
        const d = await deleteLinked(io.mind, prev);
        if (!d.ok) return { ok: false, output: `task_board: ${d.error}` };
        io.set(ctx.sessionId, cur.filter((t) => t.id !== id));
        return { ok: true, output: `Task ${id} deleted from the board${prev.lifeId ? " and from MIND" : ""}.` };
      }
      return { ok: false, output: "task_board: action must be update, set, get, projects, cancel or delete" };
    },
  };
}

const line = (t: BoardTask): string =>
  `${t.id} [${t.status}] ${t.title}${t.scope ? ` {${SCOPE_LABEL[t.scope]}${t.project ? ` / ${t.project.name}` : ""}}` : ""}${t.question ? ` -- asks: ${t.question}` : ""}${t.decision ? ` -- decision: ${t.decision.winner}` : ""}`;

/** Rows for one session: only the tasks the model declared. A session that declared none has no row: a conversation is not a card. */
export function rowsFor(s: { id: string; title: string }, tasks: BoardTask[]): BoardRow[] {
  const base = { sessionId: s.id, sessionTitle: s.title || "Untitled" };
  return tasks.map((t) => ({ ...base, ...t }));
}
