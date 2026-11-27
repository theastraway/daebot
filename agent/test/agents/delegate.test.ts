import { test } from "node:test";
import assert from "node:assert/strict";
import { HELPER_TOOLS, createDelegateTool, helperMessage, parseTasks, pool } from "../../src/agents/delegate.ts";
import type { HelperRun, SpawnHelper } from "../../src/agents/delegate.ts";

const ctx = { cwd: "/repo", sessionId: "s1" };
const ok = (text: string, extra: Partial<HelperRun> = {}): HelperRun => ({ ok: true, text, calls: [{ tool: "grep", receiptId: "c1", ok: true }], costUsd: 0.01, model: "m/x", ...extra });

test("pool keeps order and never runs more than n at once", async () => {
  let live = 0, peak = 0;
  const out = await pool([30, 10, 20, 5, 15], 2, async (ms, i) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, ms));
    live--;
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});

test("parseTasks: validation, default kind, cap", () => {
  assert.match(parseTasks([], 6).problem!, /non-empty/);
  assert.match(parseTasks([{ title: "a", prompt: "short" }], 6).problem!, /needs a prompt/);
  assert.match(parseTasks(Array.from({ length: 7 }, () => ({ prompt: "find the thing in the code please" })), 6).problem!, /at most 6/);
  const r = parseTasks([{ title: "Auth", prompt: "Find where sessions are created", kind: "bogus" }, "Research the three best queue libraries"], 6);
  assert.equal(r.problem, undefined);
  assert.deepEqual(r.tasks.map((t) => [t.title, t.kind]), [["Auth", "explore"], ["Helper 2", "explore"]]);
});

test("helperMessage tells the helper its piece, its limits and the report shape", () => {
  const m = helperMessage({ title: "Auth", prompt: "Where are sessions created?", kind: "review" }, 1, 3);
  assert.match(m, /helper 2 of 3/);
  assert.match(m, /Where are sessions created\?/);
  assert.match(m, /read-only tools/);
  assert.match(m, /Zero findings is a valid answer/);
  assert.match(m, /SURFACE✓ #cN or MIND✓ #cN/);
});

test("helpers never get write, shell, outward or delegate tools", () => {
  for (const t of ["write_file", "edit_file", "bash", "process", "terminal", "browser", "computer", "delegate", "bot_talk", "mind_remember", "claude_code", "mcp_connect", "task_board"]) assert.equal(HELPER_TOOLS.has(t), false, t);
  for (const t of ["read_file", "grep", "glob", "code_map", "mind_query", "web_fetch"]) assert.equal(HELPER_TOOLS.has(t), true, t);
});

test("delegate runs helpers in parallel and returns every report in order, with the cost", async () => {
  let live = 0, peak = 0;
  const spawn: SpawnHelper = async (task, o) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 20));
    live--;
    assert.equal(o.total, 4);
    assert.equal(o.parentSessionId, "s1");
    assert.equal(o.cwd, "/repo");
    return ok(`report for ${task.title}`);
  };
  const tool = createDelegateTool({ spawn, parallel: 3 });
  assert.equal(tool.class, "read");
  const r = await tool.run({ tasks: ["A", "B", "C", "D"].map((t) => ({ title: t, prompt: `Investigate part ${t} of the system` })) }, ctx);
  assert.equal(r.ok, true);
  assert.equal(peak, 3);
  assert.match(r.output, /^4 of 4 helper\(s\) finished/);
  const order = [...r.output.matchAll(/### Helper (\d): (\w)/g)].map((m) => m[1] + m[2]);
  assert.deepEqual(order, ["1A", "2B", "3C", "4D"]);
  assert.match(r.output, /report for C/);
  assert.match(r.output, /not your receipts/);
  assert.equal((r.meta as any).costUsd.toFixed(2), "0.04");
});

test("delegate: a failed or timed-out helper is reported, the rest still come back (partial)", async () => {
  const spawn: SpawnHelper = async (task, o) => {
    if (task.title === "boom") throw new Error("provider down");
    if (task.title === "slow") { await new Promise((r) => o.signal.addEventListener("abort", r)); return ok("half a report"); }
    return ok("fine");
  };
  const tool = createDelegateTool({ spawn, timeoutMs: 30 });
  const r = await tool.run({ tasks: [{ title: "good", prompt: "do the good thing please" }, { title: "boom", prompt: "do the failing thing" }, { title: "slow", prompt: "do the slow thing please" }] }, ctx);
  assert.equal(r.ok, true);
  assert.equal((r.meta as any).contract.status, "partial");
  assert.match(r.output, /1 of 3 helper/);
  assert.match(r.output, /boom.*did not finish: provider down/);
  assert.match(r.output, /slow.*did not finish: timed out/);
  assert.match(r.output, /half a report/);
});

test("delegate: all helpers failing is a failed result with a stop rule", async () => {
  const tool = createDelegateTool({ spawn: async () => ({ ok: false, text: "", calls: [], costUsd: 0, error: "no model" }) });
  const r = await tool.run({ tasks: [{ title: "x", prompt: "find the thing please" }] }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /no helper finished/);
  assert.match(r.output, /stop: after one retry/);
});

test("delegate: the caller's stop reaches every helper", async () => {
  const ctrl = new AbortController();
  let aborted = 0;
  const spawn: SpawnHelper = async (_t, o) => { await new Promise((r) => o.signal.addEventListener("abort", () => { aborted++; r(undefined); })); return { ok: false, text: "", calls: [], costUsd: 0, error: "stopped" }; };
  const tool = createDelegateTool({ spawn, parallel: 2 });
  const p = tool.run({ tasks: [{ title: "a", prompt: "find the thing please" }, { title: "b", prompt: "find the other thing" }] }, { ...ctx, signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 10);
  const r = await p;
  assert.equal(aborted, 2);
  assert.equal(r.ok, false);
});

test("delegate: a peer bot's turn cannot spawn helpers; the per-session cap holds", async () => {
  const tool = createDelegateTool({ spawn: async () => ok("x"), cap: { calls: 2, windowMs: 60_000 } });
  const tasks = [{ title: "a", prompt: "find the thing please" }];
  assert.equal((await tool.run({ tasks }, { ...ctx, origin: "bot" })).ok, false);
  assert.equal((await tool.run({ tasks }, ctx)).ok, true);
  assert.equal((await tool.run({ tasks }, ctx)).ok, true);
  const third = await tool.run({ tasks }, ctx);
  assert.equal(third.ok, false);
  assert.match(third.output, /2 delegate calls/);
  assert.equal((await tool.run({ tasks }, { ...ctx, sessionId: "other" })).ok, true, "per session");
});

test("delegate: secrets in a helper report are redacted", async () => {
  const tool = createDelegateTool({ spawn: async () => ok("the key is sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef") });
  const r = await tool.run({ tasks: [{ title: "a", prompt: "find the thing please" }] }, ctx);
  assert.ok(!r.output.includes("0123456789abcdef0123456789abcdef"), r.output);
});

test("helperSafeTools: a helper's non-read call (code_map sync) is refused; reads and worktree tools pass", async () => {
  const { helperSafeTools } = await import("../../src/agents/delegate.ts");
  const ran: string[] = [];
  const mk = (name: string, classFor?: (a: Record<string, unknown>) => "read" | "write") => ({
    class: "read" as const, spec: { name, description: "", parameters: { type: "object", properties: {} } },
    ...(classFor ? { classFor } : {}),
    async run(a: Record<string, unknown>) { ran.push(`${name}:${String(a.action ?? "")}`); return { ok: true, output: "ran" }; },
  });
  const [map, bash, grep] = helperSafeTools([mk("code_map", (a) => (a.action === "sync" ? "write" : "read")), mk("bash", () => "write"), mk("grep")] as any);
  const sync = await map!.run({ action: "sync" }, {} as any);
  assert.equal(sync.ok, false);
  assert.match(sync.output, /only reads/);
  assert.equal((await map!.run({ action: "impact" }, {} as any)).ok, true);
  assert.equal((await bash!.run({ action: "x" }, {} as any)).ok, true, "a build helper's shell is its worktree work");
  assert.equal((await grep!.run({}, {} as any)).ok, true);
  assert.deepEqual(ran, ["code_map:impact", "bash:x", "grep:"]);
});
