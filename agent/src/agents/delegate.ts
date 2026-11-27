// delegate: helpers in parallel. Daebot splits a job into pieces and hands each to a helper agent that runs at the same time,
// in its own short-lived session, with the SAME MIND context as the caller (the boot is shared, so every helper starts from the
// user's memory). The kernel runs on every helper call exactly as on the caller's, and helpers never delegate again.
//
// Two sorts of helper:
//  - readers (explore, research, review, plan): read-only tools (read, search, the code map, the web, MIND reads);
//  - builders (build): the file tools and the shell too, but each in its OWN git worktree on its own branch (agents/worktree.ts),
//    so builders working at the same time never collide and the user's checkout is untouched. The caller gets the branch back and
//    reviews and merges it. Nobody watches a helper's turn, so an outward or irreversible action inside one stops at the gate.
// Every helper is recorded live in the HelperHub (agents/hub.ts): Daebot Studio shows them working.
import type { Tool, ToolResult } from "../types.ts";
import { done, failed } from "../tools/contract.ts";
import { redactSecrets } from "../learn/guard.ts";
import type { HelperHub } from "./hub.ts";
import type { WorktreeOps } from "./worktree.ts";

/** Tools a reading helper may have (when the caller has them). Everything else is withheld. */
export const HELPER_TOOLS: ReadonlySet<string> = new Set([
  "read_file", "glob", "grep", "code_map", "web_fetch", "web_search", "read_document", "view_photo",
  "mind_query", "mind_context", "mind_profile", "mind_folders_read", "mind_sessions",
]);
/** A build helper adds these, inside its own worktree. */
export const BUILD_TOOLS: ReadonlySet<string> = new Set([...HELPER_TOOLS, "write_file", "edit_file", "bash"]);

/** The file tools and the shell: a build helper's own work, inside its worktree. */
const WORKTREE_WRITES: ReadonlySet<string> = new Set(["write_file", "edit_file", "bash"]);

/**
 * Helpers never write anywhere but their own worktree: a helper tool whose class for THIS call is not "read" (code_map sync files
 * a MIND document) is refused, except the file tools and the shell a build helper was given. Other tools pass through unchanged.
 */
export function helperSafeTools(tools: readonly Tool[]): Tool[] {
  return tools.map((t) => {
    if (WORKTREE_WRITES.has(t.spec.name) || !t.classFor) return t;
    const inner = t;
    return {
      ...inner,
      async run(args, ctx): Promise<ToolResult> {
        const cls = inner.classFor!(args);
        if (cls !== "read") return failed(`${inner.spec.name}: a helper only reads. This call (${cls}) is for the main chat; report what you found instead.`);
        return inner.run(args, ctx);
      },
    };
  });
}

/** Kinds the model may ask for. "grade" and "draft" are internal to the loop (agents/loop.ts). */
export const HELPER_KINDS = ["explore", "research", "review", "plan", "build"] as const;
export type HelperKind = (typeof HELPER_KINDS)[number] | "grade" | "draft";

export const KIND_BRIEF: Record<HelperKind, string> = {
  explore: "Find where things are and how they work in the code: name files, functions and line numbers; use code_map, grep and read_file.",
  research: "Gather facts from the web and from MIND; name every source (URL, MIND item) next to the fact it supports.",
  review: "Look for concrete problems (a bug, a missing test, a risky change): each finding with file, line and the failure it causes. Zero findings is a valid answer. Default to doubting a finding until the code proves it.",
  plan: "Work out the smallest safe sequence of steps for the change: files to touch (use code_map impact), tests to run, risks. Do not make the change.",
  build: "Make the change in this checkout (it is your own git worktree; nobody else edits it). Read before you edit (code_map impact on the files you touch), keep the change small, then run the checks that prove it (tests, type check) and report their result lines. Do not commit, push or switch branches: Daebot collects your work from this worktree.",
  draft: "Produce the artifact itself, complete and ready to use. Study what you need first (MIND, the repo, the web), then write it.",
  grade: "Grade the work like a tough editor: never inflate, a 9 means you would ship it as is. Check claims against the files and the check output yourself.",
};

export interface HelperTask { title: string; prompt: string; kind: HelperKind }
export interface HelperRun {
  ok: boolean;
  text: string;
  /** Tool calls the helper made: name, receipt id, ok. */
  calls: { tool: string; receiptId: string; ok: boolean }[];
  costUsd: number;
  model?: string;
  error?: string;
}
export interface SpawnOpts {
  index: number; total: number; signal: AbortSignal; parentSessionId: string;
  /** Where the helper works: the caller's folder, or the build helper's worktree. */
  cwd: string;
  /** Called as the helper starts each tool (the hub shows it). */
  onTool?: (tool: string) => void;
}
export type SpawnHelper = (task: HelperTask, o: SpawnOpts) => Promise<HelperRun>;

export interface DelegateOptions {
  spawn: SpawnHelper;
  /** Present when this session can build (file tools, local runtime): build helpers get worktrees from it. */
  worktrees?: WorktreeOps;
  hub?: HelperHub;
  /** Helpers per call (default 6) and at the same time (default 3). */
  maxTasks?: number;
  parallel?: number;
  /** Per helper, in ms (default 5 minutes; build helpers get twice that): the helper is stopped and reported as timed out. */
  timeoutMs?: number;
  /** delegate calls per session in a rolling window (default 8 per 10 minutes): a loop cannot spawn without end. */
  cap?: { calls: number; windowMs: number };
  now?: () => number;
}

const one = (v: unknown, n: number): string => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim().slice(0, n);
const REPORT_CAP = 12_000;

/** Runs `fn` over `items` with at most `n` in flight; results keep the input order. */
export async function pool<T, R>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

export function parseTasks(raw: unknown, max: number): { tasks: HelperTask[]; problem?: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { tasks: [], problem: "tasks must be a non-empty list of {title, prompt, kind?}" };
  if (raw.length > max) return { tasks: [], problem: `at most ${max} helpers per call (got ${raw.length}); merge pieces or call again after these finish` };
  const tasks: HelperTask[] = [];
  for (const [i, t] of raw.entries()) {
    const o = (t && typeof t === "object" ? t : { prompt: t }) as Record<string, unknown>;
    const prompt = one(o.prompt, 6000);
    if (prompt.length < 10) return { tasks: [], problem: `task ${i + 1} needs a prompt that says exactly what to find out (at least a sentence)` };
    const kind = (HELPER_KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as HelperKind) : "explore";
    tasks.push({ title: one(o.title, 80) || `Helper ${i + 1}`, prompt, kind });
  }
  return { tasks };
}

/** The message a helper receives: its piece, how to work, and how to report. */
export function helperMessage(t: HelperTask, i: number, n: number, where?: string): string {
  const build = t.kind === "build";
  return [
    `You are helper ${i + 1} of ${n}, working for Daebot on one piece of a larger job. Piece: ${t.title}.`,
    "",
    t.prompt,
    "",
    `How to work: ${KIND_BRIEF[t.kind]}`,
    ...(build && where ? [`Your checkout: ${where}. Work only inside it; never write to any other folder.`] : []),
    build
      ? "You may edit files and run commands in your checkout. Do not ask questions back: nobody can answer them. If something blocks you, say what and stop."
      : "You have read-only tools. Do not ask questions back: nobody can answer them. If something is missing, say what and continue with what you can establish.",
    `Report in at most 30 lines: ${build ? "what you changed (files), the checks you ran with their result lines, and what is left" : "the answer first, then the evidence (file:line, URLs, MIND items) and what you could not verify"}. Put a receipt line (SURFACE✓ #cN or MIND✓ #cN) under each claim you checked.`,
  ].join("\n");
}

export interface RunHelpersOptions {
  spawn: SpawnHelper;
  worktrees?: WorktreeOps;
  hub?: HelperHub;
  parallel: number;
  timeoutMs: number;
  sessionId: string;
  cwd: string;
  signal?: AbortSignal;
  /** Loop bookkeeping for the hub. */
  loop?: { id: string; cycle: number };
}

export interface HelperOutcome extends HelperRun {
  task: HelperTask;
  /** Build helpers: what landed on their branch. */
  branch?: string; files?: string[]; stat?: string;
}

/** Runs helpers (with worktrees for build helpers, the hub, timeouts and the caller's stop). Shared by delegate and loop. */
export async function runHelpers(tasks: readonly HelperTask[], o: RunHelpersOptions, total = tasks.length, offset = 0): Promise<HelperOutcome[]> {
  return pool(tasks, o.parallel, async (task, i): Promise<HelperOutcome> => {
    if (o.signal?.aborted) return { task, ok: false, text: "", calls: [], costUsd: 0, error: "stopped before it started" };
    let wt: ReturnType<WorktreeOps["prepare"]> | undefined;
    if (task.kind === "build") {
      if (!o.worktrees) return { task, ok: false, text: "", calls: [], costUsd: 0, error: "build helpers are not available here (no file tools in this session, or a hosted deployment)" };
      wt = o.worktrees.prepare(o.cwd, task.title);
      if ("error" in wt) return { task, ok: false, text: "", calls: [], costUsd: 0, error: wt.error };
    }
    const tree = wt && !("error" in wt) ? wt : undefined;
    const hid = o.hub?.start({ session: o.sessionId, title: task.title, kind: task.kind, ...(o.loop ? { loop: o.loop.id, cycle: o.loop.cycle } : {}) });
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const limit = task.kind === "build" ? o.timeoutMs * 2 : o.timeoutMs;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, limit);
    let out: HelperOutcome;
    try {
      const r = await o.spawn(task, { index: offset + i, total, signal: ctrl.signal, parentSessionId: o.sessionId, cwd: tree?.cwd ?? o.cwd, onTool: (t) => { if (hid) o.hub?.tool(hid, t); } });
      out = timedOut ? { ...r, task, ok: false, error: `timed out after ${Math.round(limit / 1000)} s${r.text ? " (partial report below)" : ""}` } : { ...r, task };
    } catch (e) {
      out = { task, ok: false, text: "", calls: [], costUsd: 0, error: timedOut ? `timed out after ${Math.round(limit / 1000)} s` : String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200) };
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    }
    if (tree && o.worktrees) {
      const fin = o.worktrees.finish(tree, `Daebot helper: ${task.title}`);
      if (fin.changed) { out.branch = fin.branch; out.files = fin.files; out.stat = fin.stat; }
      if (fin.error) out.error = out.error ? `${out.error}; ${fin.error}` : fin.error;
    }
    if (hid) o.hub?.finish(hid, { ok: out.ok, ...(out.branch ? { branch: out.branch, files: out.files?.length } : {}), ...(out.error ? { note: out.error } : {}) });
    return out;
  });
}

/** One helper's block in a tool result. */
export function reportBlock(r: HelperOutcome, i: number, cap: number): string {
  const calls = r.calls.length ? r.calls.map((c) => `${c.tool}${c.ok ? "" : " (failed)"}`).join(", ") : "no tool calls";
  const body = redactSecrets(r.text.trim() || "(no report)");
  return [
    `### Helper ${i + 1}: ${r.task.title} [${r.task.kind}] ${r.ok ? "finished" : `did not finish: ${r.error ?? "unknown error"}`}`,
    `Tools used: ${calls}${r.model ? ` · model ${r.model}` : ""}`,
    ...(r.task.kind === "build" ? [r.branch ? `Branch: ${r.branch} (${r.stat || `${r.files?.length ?? 0} files`}): ${(r.files ?? []).slice(0, 12).join(", ")}${(r.files?.length ?? 0) > 12 ? ", …" : ""}` : "Branch: none (no file changed)"] : []),
    body.length > cap ? `${body.slice(0, cap)}\n… (report cut)` : body,
  ].join("\n");
}

export function createDelegateTool(o: DelegateOptions): Tool {
  const maxTasks = o.maxTasks ?? 6;
  const parallel = o.parallel ?? 3;
  const timeoutMs = o.timeoutMs ?? 5 * 60_000;
  const cap = o.cap ?? { calls: 8, windowMs: 10 * 60_000 };
  const now = o.now ?? Date.now;
  const used = new Map<string, number[]>();
  const kinds = o.worktrees ? [...HELPER_KINDS] : HELPER_KINDS.filter((k) => k !== "build");
  return {
    class: "read",
    // Build helpers edit files (in their own worktrees): a call with one is a local write, like edit_file.
    classFor: (a) => (Array.isArray(a.tasks) && a.tasks.some((t) => t && typeof t === "object" && (t as Record<string, unknown>).kind === "build") ? "write" : "read"),
    spec: {
      name: "delegate",
      description:
        `Run up to ${maxTasks} helper agents in parallel (${parallel} at a time), each on one piece of a bigger job, and get their reports back. ` +
        "Every helper starts with the same MIND context as you and never delegates. Readers (explore, research, review, plan) have read-only tools (read_file, glob, grep, code_map, web, MIND reads). " +
        (o.worktrees ? "Builders (build) also edit files and run commands, each in its OWN git worktree on its own branch, so several can change the code at once without colliding; you get each branch back to review and merge (git merge <branch>). " : "") +
        "Use it when a job splits into independent pieces: explore several parts of a codebase, research several options, review a change from different angles, plan while you explore" + (o.worktrees ? ", or build independent changes in parallel" : "") + ". " +
        "Each prompt must stand on its own (the helper does not see this chat).",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description: "One entry per helper",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Short name of the piece (shown to the user in Daebot Studio)" },
                prompt: { type: "string", description: "Everything the helper needs: the question or change, where to look, what a good answer contains" },
                kind: { type: "string", enum: kinds },
              },
              required: ["title", "prompt"],
              additionalProperties: false,
            },
          },
        },
        required: ["tasks"],
        additionalProperties: false,
      },
    },
    async run(args, ctx): Promise<ToolResult> {
      if (ctx.origin === "bot") return failed("delegate is for turns the person started, not for a message from another agent", { retry: "pointless" });
      const parsed = parseTasks(args.tasks, maxTasks);
      if (parsed.problem) return failed(parsed.problem, { retry: "pointless" });
      if (!o.worktrees && parsed.tasks.some((t) => t.kind === "build")) return failed("build helpers are not available in this session (no file tools here, or a hosted deployment)", { retry: "pointless", next: "use explore, research, review or plan helpers, and make the change yourself" });
      const t0 = now();
      const hist = (used.get(ctx.sessionId) ?? []).filter((x) => t0 - x < cap.windowMs);
      if (hist.length >= cap.calls) return failed(`${cap.calls} delegate calls in the last ${Math.round(cap.windowMs / 60_000)} minutes already`, { retry: "pointless", next: "work with the reports you have" });
      hist.push(t0); used.set(ctx.sessionId, hist);
      const tasks = parsed.tasks;
      const runs = await runHelpers(tasks, { spawn: o.spawn, worktrees: o.worktrees, hub: o.hub, parallel, timeoutMs, sessionId: ctx.sessionId, cwd: ctx.cwd, signal: ctx.signal });
      const okCount = runs.filter((r) => r.ok).length;
      const cost = runs.reduce((s, r) => s + (Number.isFinite(r.costUsd) ? r.costUsd : 0), 0);
      const per = Math.floor(REPORT_CAP / tasks.length);
      const blocks = runs.map((r, i) => reportBlock(r, i, per));
      const branches = runs.filter((r) => r.branch).map((r) => r.branch!);
      const header = "Helper reports are their own reading, not your receipts: before you state one of their facts as checked, confirm it yourself with one call (or say it comes from a helper)." +
        (branches.length ? ` Build branches to review (git diff HEAD...<branch>) and merge (git merge --no-ff <branch>): ${branches.join(", ")}. Run the checks again after merging.` : "");
      const summary = `${okCount} of ${tasks.length} helper(s) finished${branches.length ? `, ${branches.length} branch(es) with changes` : ""}`;
      const meta = { helpers: tasks.length, finished: okCount, ...(branches.length ? { branches } : {}), ...(cost > 0 ? { costUsd: cost, model: "delegate helpers" } : {}) };
      if (okCount === 0 && !branches.length) return failed(`no helper finished (${runs.map((r) => r.error ?? "no report").join("; ").slice(0, 300)})`, { retry: "safe", stop: "after one retry, do the work yourself", output: blocks.join("\n\n"), meta });
      return done(summary, { output: [header, "", ...blocks].join("\n\n"), partial: okCount < tasks.length, artifacts: branches, meta });
    },
  };
}
