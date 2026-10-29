// The task board: what Daebot is working on, per session, with the same traffic-light colors as the Astra AI client portal
// (red = not started, yellow = in progress, green = ready to test). In Daebot red ALSO means stopped: a question or a decision
// is waiting on the user. Two sources feed it: tasks the model declares with the task_board tool (stored with the session), and a
// card derived from run state for every session that declared none.
import type { HistoryEvent, Tool } from "../types.ts";
import { tailOf } from "../suggest/index.ts";

export type BoardStatus = "not_started" | "in_progress" | "ready_to_test" | "stopped";
export const BOARD_STATUSES: readonly BoardStatus[] = ["not_started", "in_progress", "ready_to_test", "stopped"];

export interface BoardTask { id: string; title: string; status: BoardStatus; question?: string; updatedAt: number }

/** One row of GET /board. `derived` = not declared by the model: built from the run state of a session that declared no tasks. */
export interface BoardRow extends BoardTask { sessionId: string; sessionTitle: string; derived?: boolean }

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

/** Validates one task as the model wrote it. A stopped task needs its question; any other status carries none. */
export function checkTask(raw: unknown, now: number, prev?: BoardTask): Checked<BoardTask> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "each task must be an object {id, title, status, question?}" };
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!ID_OK.test(id)) return { ok: false, error: "task id must be 1-40 letters, digits, '-', '_' or '.' (no spaces)" };
  const title = r.title === undefined && prev ? prev.title : oneLine(r.title, MAX_TITLE);
  if (!title) return { ok: false, error: `task ${id}: title is required` };
  const status = r.status === undefined && prev ? prev.status : r.status;
  if (typeof status !== "string" || !BOARD_STATUSES.includes(status as BoardStatus)) return { ok: false, error: `task ${id}: status must be one of ${BOARD_STATUSES.join(", ")}` };
  const out: BoardTask = { id, title, status: status as BoardStatus, updatedAt: now };
  if (status === "stopped") {
    const q = r.question === undefined && prev?.status === "stopped" ? prev.question ?? "" : multiLine(r.question, MAX_QUESTION);
    if (!q) return { ok: false, error: `task ${id}: a stopped task needs "question": the exact question or decision the user must answer` };
    out.question = q;
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
    if (seen.has(c.value.id)) return { ok: false, error: `duplicate task id ${c.value.id}` };
    seen.add(c.value.id);
    // A task the model re-lists unchanged keeps its old timestamp.
    out.push(before && before.title === c.value.title && before.status === c.value.status && before.question === c.value.question ? before : c.value);
  }
  return { ok: true, value: out };
}

/** The user answered: every stopped task goes back to in progress (the model stops it again if it still needs something). */
export function resumeStopped(tasks: BoardTask[], now: number): BoardTask[] {
  return tasks.map((t) => (t.status === "stopped" ? { id: t.id, title: t.title, status: "in_progress" as const, updatedAt: now } : t));
}

/** Reads a stored board defensively (a hand-edited or old record never breaks the listing). */
export function loadTasks(raw: unknown): BoardTask[] {
  if (!Array.isArray(raw)) return [];
  const out: BoardTask[] = [];
  for (const t of raw.slice(0, MAX_TASKS)) {
    const c = checkTask(t, Number((t as { updatedAt?: unknown })?.updatedAt) || 0);
    if (c.ok) out.push(c.value);
  }
  return out;
}

export interface BoardIO {
  get(sessionId: string): BoardTask[];
  set(sessionId: string, tasks: BoardTask[]): void;
}

export const BOARD_PROMPT = [
  "## Task board",
  "The user sees a board of your work in a side panel: one colored box per task. red = not started, yellow = in progress, green = ready to test, and red also means STOPPED (you are waiting on the user).",
  "- For any work with more than one step, call task_board first (action set) with every piece of work as its own task, then keep it current: update a task to in_progress when you start it and to ready_to_test when it is done and the user can try it.",
  "- When you need an answer or a decision from the user, mark that task stopped with `question` (the exact question) INSTEAD OF only asking in chat. Then ask it in chat too, in one line. When the user answers, the board moves stopped tasks back to in progress for you.",
  "- Task titles are short and plain (what is being done), never secrets. Do not put one-line answers or small talk on the board.",
].join("\n");

export function createTaskBoardTool(io: BoardIO): Tool {
  return {
    spec: {
      name: "task_board",
      description:
        "Keep the user's task board for THIS chat. The user sees it in a side panel as colored boxes: red = not started, yellow = in progress, green = ready to test. " +
        "Put each piece of multi-step work on the board as its own task and keep the statuses current. " +
        "When you need an answer or a decision from the user, set that task to \"stopped\" with `question` (required): it shows red as \"Waiting on you\" and the user can type the reply right there. Do that instead of only asking in chat. " +
        "action \"set\" replaces the whole board with `tasks`. action \"update\" changes one task by id (add title and status to create it). action \"get\" returns the board. " +
        "A stopped task goes back to in_progress by itself when the user replies; mark it stopped again if you still need something. Mark a task ready_to_test only when the user can try it.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set", "update", "get"] },
          tasks: {
            type: "array",
            description: "set: the full list of tasks",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "short stable id, e.g. t1 or login-page" },
                title: { type: "string", description: "what is being done, one short line" },
                status: { type: "string", enum: ["not_started", "in_progress", "ready_to_test", "stopped"] },
                question: { type: "string", description: "required when status is stopped: the question or decision the user must answer" },
              },
              required: ["id", "title", "status"],
              additionalProperties: false,
            },
          },
          id: { type: "string", description: "update: the task id" },
          title: { type: "string", description: "update: new title (required when creating)" },
          status: { type: "string", enum: ["not_started", "in_progress", "ready_to_test", "stopped"], description: "update: new status" },
          question: { type: "string", description: "update: the question (required when status is stopped)" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    class: "write", // local only: it edits this chat's own board file, reaches no third party and nothing outside this chat
    async run(args, ctx) {
      const action = typeof args.action === "string" ? args.action : "";
      const now = Date.now();
      const cur = io.get(ctx.sessionId);
      if (action === "get") return { ok: true, output: cur.length ? cur.map(line).join("\n") : "The board is empty." };
      if (ctx.origin === "bot") return { ok: false, output: "blocked: a message from another bot cannot edit the user's task board." };
      if (action === "set") {
        const c = checkTaskList(args.tasks, now, cur);
        if (!c.ok) return { ok: false, output: `task_board: ${c.error}` };
        io.set(ctx.sessionId, c.value);
        return { ok: true, output: `Board set (${c.value.length} task${c.value.length === 1 ? "" : "s"}).\n${c.value.map(line).join("\n")}` };
      }
      if (action === "update") {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const prev = cur.find((t) => t.id === id);
        if (!prev && (args.title === undefined || args.status === undefined)) return { ok: false, output: `task_board: no task ${JSON.stringify(id)} on the board. Pass title and status to create it, or action set.` };
        if (!prev && cur.length >= MAX_TASKS) return { ok: false, output: `task_board: at most ${MAX_TASKS} tasks on the board` };
        const c = checkTask({ id, title: args.title, status: args.status, question: args.question }, now, prev);
        if (!c.ok) return { ok: false, output: `task_board: ${c.error}` };
        io.set(ctx.sessionId, prev ? cur.map((t) => (t.id === id ? c.value : t)) : [...cur, c.value]);
        return { ok: true, output: `Task updated: ${line(c.value)}` };
      }
      return { ok: false, output: "task_board: action must be set, update or get" };
    },
  };
}

const line = (t: BoardTask): string => `${t.id} [${t.status}] ${t.title}${t.question ? ` -- asks: ${t.question}` : ""}`;

// ---------------------------------------------------------------- derived status

export interface DeriveInput {
  history: HistoryEvent[];
  /** The latest run mark of the session ("running" on disk with nobody running it = the server died mid-turn). */
  run?: { status: "running" | "done" | "error" | "interrupted" };
  /** A live in-process session that is running a turn right now. */
  live: boolean;
}
export interface Derived { status: BoardStatus; question?: string }

const lastParagraph = (t: string): string => {
  const parts = t.trim().split(/\n\s*\n/);
  return (parts[parts.length - 1] ?? "").replace(/\s+/g, " ").trim();
};
/** The turn handed control to the user with a real question: the final text ends with "?" (closing quotes or brackets allowed). */
export function endsWithQuestion(text: string): boolean {
  return /\?\s*[)"'”’*_`>\]]*\s*$/.test((text ?? "").trim());
}

/** A permission card with no answer yet (and the turn still running) is a turn waiting for the user's click. */
function pendingPermission(h: HistoryEvent[]): Extract<HistoryEvent, { type: "permission" }> | undefined {
  const open = new Map<string, Extract<HistoryEvent, { type: "permission" }>>();
  for (const e of h) {
    if (e.type === "permission") open.set(e.id, e);
    else if (e.type === "permissionResolved") open.delete(e.id);
  }
  return [...open.values()].pop();
}

export function deriveStatus(i: DeriveInput): Derived {
  if (!i.history.some((e) => e.type === "user")) return { status: "not_started" };
  const running = i.run?.status === "running";
  if (running && i.live) {
    const p = pendingPermission(i.history);
    if (p) return { status: "stopped", question: `Approval needed: ${oneLine(p.title, 200)}` };
    return { status: "in_progress" };
  }
  if (running || i.run?.status === "interrupted" || i.run?.status === "error") {
    return { status: "stopped", question: "The last turn did not finish (the server restarted or it failed). Reply to pick it back up." };
  }
  const tail = tailOf(i.history);
  if (tail?.endedOnConfirm) {
    const c = [...i.history].reverse().find((e) => e.type === "confirm") as Extract<HistoryEvent, { type: "confirm" }> | undefined;
    return { status: "stopped", question: oneLine(c?.reason ? `Confirm needed: ${c.reason}` : "A risky action needs your confirmation.", 300) };
  }
  if (tail && endsWithQuestion(tail.lastText)) return { status: "stopped", question: multiLine(lastParagraph(tail.lastText), MAX_QUESTION) };
  return { status: "ready_to_test" };
}

/** Rows for one session: the model's own tasks, plus a derived stopped row when the turn is waiting and no declared task says so. */
export function rowsFor(s: { id: string; title: string; updatedAt: number }, tasks: BoardTask[], input: DeriveInput): BoardRow[] {
  const d = deriveStatus(input);
  const base = { sessionId: s.id, sessionTitle: s.title || "Untitled" };
  if (tasks.length === 0) {
    return [{ ...base, id: "session", title: s.title || "Untitled", status: d.status, ...(d.question ? { question: d.question } : {}), updatedAt: s.updatedAt, derived: true }];
  }
  const rows: BoardRow[] = tasks.map((t) => ({ ...base, ...t }));
  if (d.status === "stopped" && !tasks.some((t) => t.status === "stopped")) {
    rows.push({ ...base, id: "waiting", title: "Waiting on you", status: "stopped", question: d.question, updatedAt: s.updatedAt, derived: true });
  }
  return rows;
}
