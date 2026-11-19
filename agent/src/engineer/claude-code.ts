// claude_code: Daebot hands building work to Claude Code as a VISIBLE sub-worker.
//
// The tool starts the user's own `claude -p --output-format stream-json` (their own CLI and login) in a work folder and returns at once, so
// a Daebot turn is never held open by a long build. Milestones stream into the thread (and onto a task board card) through `onMilestone`;
// when Claude Code exits, `onExit` wakes Daebot with a follow-up turn in the same thread. Both hooks are set by the gateway.
//
// A portal job registers a per-thread context first (work folder, portal rules prompt, and the task token in the CHILD's environment only):
// the token never passes through the model, the transcript or a log. Outside portal jobs the tool runs in the session's working folder.
import { mkdirSync } from "node:fs";
import type { Tool, ToolResult } from "../types.ts";
import { childEnv, findClaude, milestoneOf, spawnClaude } from "./portal-engineer.ts";
import type { ClaudeRun } from "./portal-engineer.ts";

export interface ClaudeContext {
  /** Work folder (holds job.json for a portal job). */
  dir: string;
  /** Rules prepended to every task in this thread (the portal engineer prompt). */
  preamble?: string;
  /** Extra environment for the child only (PORTAL_API, PORTAL_TASK_TOKEN). */
  env?: Record<string, string>;
  /** Task board card the job belongs to (progress is shown there). */
  cardId?: string;
}

export interface ClaudeJob {
  id: string;
  sessionId: string;
  task: string;
  startedAt: number;
  status: "running" | "done" | "failed" | "stopped";
  milestones: string[];
  result?: ClaudeRun;
  cardId?: string;
}

export type Runner = (a: { dir: string; prompt: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onLine(line: string): void }) => Promise<ClaudeRun>;

const one = (v: unknown, n: number): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const MAX_TASK = 20_000;
export const CLAUDE_JOB_TIMEOUT_MS = 120 * 60_000;

/** Every Claude Code job of this process (one running job per thread). */
export class ClaudeJobs {
  private jobs = new Map<string, ClaudeJob & { abort: AbortController; done: Promise<ClaudeRun> }>();
  private ctx = new Map<string, ClaudeContext>();
  private seq = 0;
  /** Set by the gateway: a milestone line for the thread (and its card). */
  onMilestone?: (sessionId: string, job: ClaudeJob, line: string) => void;
  /** Set by the gateway: Claude Code exited; wake Daebot in that thread. Not called for a job stopped by the app closing. */
  onExit?: (sessionId: string, job: ClaudeJob) => void;
  run: Runner;
  timeoutMs: number;
  now: () => number;

  constructor(o: { run?: Runner; timeoutMs?: number; now?: () => number } = {}) {
    this.run = o.run ?? (async (a) => {
      const bin = findClaude();
      if (!bin) return { ok: false, summary: "Claude Code is not installed on this computer (no `claude` in ~/.local/bin, Homebrew or PATH)." };
      return spawnClaude({ bin, job: { id: "claude" }, ...a });
    });
    this.timeoutMs = o.timeoutMs ?? CLAUDE_JOB_TIMEOUT_MS;
    this.now = o.now ?? Date.now;
  }

  setContext(sessionId: string, c: ClaudeContext | undefined): void { if (c) this.ctx.set(sessionId, c); else this.ctx.delete(sessionId); }
  context(sessionId: string): ClaudeContext | undefined { return this.ctx.get(sessionId); }
  running(sessionId: string): ClaudeJob | undefined { for (const j of this.jobs.values()) if (j.sessionId === sessionId && j.status === "running") return j; return undefined; }
  get(id: string): ClaudeJob | undefined { return this.jobs.get(id); }
  /** Resolves when the job ends (undefined = no such job). */
  wait(id: string): Promise<ClaudeRun> | undefined { return this.jobs.get(id)?.done; }

  start(sessionId: string, task: string, fallbackCwd: string): ClaudeJob | string {
    if (this.running(sessionId)) return "Claude Code is already working in this thread. Use action status, or stop it first.";
    const c = this.ctx.get(sessionId);
    const dir = c?.dir ?? fallbackCwd;
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists or not ours */ }
    const id = `cc${++this.seq}_${this.now().toString(36)}`;
    const abort = new AbortController();
    const job: ClaudeJob & { abort: AbortController; done: Promise<ClaudeRun> } = { id, sessionId, task: task.slice(0, MAX_TASK), startedAt: this.now(), status: "running", milestones: [], ...(c?.cardId ? { cardId: c.cardId } : {}), abort, done: Promise.resolve({ ok: false, summary: "" }) };
    const prompt = c?.preamble ? `${c.preamble}\n\nDaebot's instructions for this run:\n${job.task}` : job.task;
    const env = childEnv(process.env, c?.env?.PORTAL_API ?? "", c?.env?.PORTAL_TASK_TOKEN ?? "");
    if (!c?.env?.PORTAL_TASK_TOKEN) { delete env.PORTAL_TASK_TOKEN; if (!c?.env?.PORTAL_API) delete env.PORTAL_API; }
    const seen = new Set<string>();
    const timer = setTimeout(() => abort.abort(`timed out after ${Math.round(this.timeoutMs / 60_000)} minutes`), this.timeoutMs);
    timer.unref?.();
    job.done = this.run({ dir, prompt, env, signal: abort.signal, onLine: (l) => {
      const m = milestoneOf(l, seen);
      if (!m) return;
      job.milestones.push(m);
      if (job.milestones.length > 50) job.milestones.shift();
      try { this.onMilestone?.(sessionId, job, m); } catch { /* a display hook never breaks the job */ }
    } }).catch((e) => ({ ok: false, summary: `Claude Code failed: ${one((e as Error).message, 300)}` })).then((r) => {
      clearTimeout(timer);
      const closing = abort.signal.aborted && String(abort.signal.reason) === "Daebot is closing";
      job.status = abort.signal.aborted ? "stopped" : r.ok ? "done" : "failed";
      job.result = r;
      if (!closing) { try { this.onExit?.(sessionId, job); } catch { /* the hook reports its own errors */ } }
      return r;
    });
    this.jobs.set(id, job);
    return job;
  }

  stop(id: string, reason = "stopped by Daebot"): boolean {
    const j = this.jobs.get(id);
    if (!j || j.status !== "running") return false;
    j.abort.abort(reason);
    return true;
  }

  stopAll(reason = "Daebot is closing"): void { for (const j of this.jobs.values()) if (j.status === "running") j.abort.abort(reason); }
}

/** The process-wide registry the tool and the gateway share. */
export const claudeJobs = new ClaudeJobs();

const view = (j: ClaudeJob): string => {
  const head = `${j.id}: ${j.status}, started ${new Date(j.startedAt).toISOString()}`;
  const ms = j.milestones.length ? `\nProgress: ${j.milestones.join(" → ")}` : "";
  const res = j.result ? `\nResult: ${one(j.result.summary, 3000)}` : "";
  return head + ms + res;
};

export function createClaudeCodeTool(jobs: ClaudeJobs = claudeJobs): Tool {
  return {
    class: "write",
    receipt: "surface",
    spec: {
      name: "claude_code",
      description:
        "Hand building work to Claude Code on this computer (the user's own claude CLI and login) as a visible sub-worker. " +
        "action \"start\" with `task` (complete, self-contained instructions: what to build, the repo, how to test, merge only when tests pass, verify live) starts it in the background and returns at once; its progress appears in this thread and on the task card, and when it finishes you are woken with its result in a new turn. " +
        "action \"status\" shows the running or last job; action \"stop\" (job_id) stops it. One job per thread. In a portal job the work folder, the portal rules and the portal token are already set up: do not ask for or print the token.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "status", "stop"] },
          task: { type: "string", description: "start: the instructions for Claude Code" },
          job_id: { type: "string", description: "stop: the job to stop" },
        },
        required: ["action"],
      },
    },
    async run(args, ctx): Promise<ToolResult> {
      const action = typeof args.action === "string" ? args.action : "";
      if (action === "start") {
        const task = typeof args.task === "string" ? args.task.trim() : "";
        if (!task) return { ok: false, output: "claude_code: task is required for start" };
        const r = jobs.start(ctx.sessionId, task, ctx.cwd);
        if (typeof r === "string") return { ok: false, output: `claude_code: ${r}` };
        return { ok: true, output: `Claude Code started (${r.id}) in ${jobs.context(ctx.sessionId)?.dir ?? ctx.cwd}. Its progress shows in this thread; you will be woken with its result when it finishes. End this turn now.` };
      }
      if (action === "status") {
        const cur = jobs.running(ctx.sessionId);
        if (cur) return { ok: true, output: view(cur) };
        return { ok: true, output: "No Claude Code job is running in this thread." };
      }
      if (action === "stop") {
        const id = typeof args.job_id === "string" ? args.job_id : jobs.running(ctx.sessionId)?.id ?? "";
        const j = jobs.get(id);
        if (!j || j.sessionId !== ctx.sessionId) return { ok: false, output: "claude_code: no such job in this thread" };
        return { ok: true, output: jobs.stop(id) ? `Stopping ${id}.` : `${id} is not running.` };
      }
      return { ok: false, output: "claude_code: action must be start, status or stop" };
    },
  };
}
