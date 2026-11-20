import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDLE_BACKOFF_MS, PortalEngineer, childEnv, engineerAllowed, findClaude, incomingText, jobPlace, milestoneOf, promptFor, readDesktopAccounts, summaryOf } from "../../src/engineer/portal-engineer.ts";
import type { Dispatch, EngineerAccount, EngineerDeps } from "../../src/engineer/portal-engineer.ts";
import { ClaudeJobs, createClaudeCodeTool } from "../../src/engineer/claude-code.ts";
import { writeFileSync } from "node:fs";
// @ts-expect-error plain browser module
import { engineerLine, engineerAccountsLine } from "../../web/connections.js";

const KEY = "mind_testkey_abcdefghijklmnop";
const job = (id: string, projectId = "p1", extra: Record<string, unknown> = {}): Dispatch => ({
  id, kind: "todo", ref_id: "t-" + id,
  payload: { event: "todo.created", instruction: "Do it.", protocol: "1. boot", portal: { api_base: "https://api.theastraway.com", task_token: "etk.todo.secret.sig" }, todo: { id: "t-" + id, project_id: projectId, text: `Fix ${id}` }, project: { id: projectId, title: "ContentsCounter" }, client: { id: "c1", name: "Atlas" }, ...extra },
});

interface Call { method: string; url: string; headers: Record<string, string>; body?: string }
function fakeFetch(answers: Array<{ status: number; body: unknown } | Error>, calls: Call[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url: String(url), headers: init.headers as Record<string, string>, body: init.body as string | undefined });
    const a = answers.length > 1 ? answers.shift()! : answers[0];
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function harness(o: { answers: Array<{ status: number; body: unknown } | Error>; key?: string | undefined; runOk?: boolean; accounts?: EngineerAccount[]; now?: () => number; wakeStartsClaude?: boolean; taskStatus?: string; gate?: Promise<void> }) {
  const dir = mkdtempSync(join(tmpdir(), "eng-"));
  const calls: Call[] = [];
  const said: Array<{ id: string; role: string; text: string }> = [];
  const turns: Array<{ id: string; text: string }> = [];
  const cards: Array<{ id: string; task: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const live = new Set<string>();
  let n = 0;
  const runs: Array<{ dir: string; env: NodeJS.ProcessEnv; prompt: string }> = [];
  const jobs = new ClaudeJobs({ run: async (a) => {
    runs.push({ dir: a.dir, env: a.env, prompt: a.prompt });
    if (o.gate) await o.gate;
    a.onLine(JSON.stringify({ type: "system", subtype: "init" }));
    a.onLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "gh pr create --fill" } }] } }));
    a.onLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "https://github.com/theastraway/x/pull/12" }] } }));
    return { ok: o.runOk !== false, summary: "Shipped PR 12" };
  } });
  const milestones: string[] = [];
  jobs.onMilestone = (_sid, _job, line) => { milestones.push(line); };
  const portalFetch = fakeFetch(o.answers, calls);
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith("/api/portal/engineer/task")) return new Response(JSON.stringify({ todo: { status: o.taskStatus ?? "ready_to_test" } }), { status: 200 });
    return portalFetch(url, init);
  }) as unknown as typeof fetch;
  const deps: EngineerDeps = {
    dir, now: o.now, jobs, getAccounts: () => o.accounts ?? (("key" in o ? o.key : KEY) ? [{ account: "anthonyjconti", key: ("key" in o ? o.key : KEY)!, active: true }] : []), fetchImpl, sleep: async () => {},
    threads: {
      ensure: async (existing, title) => { if (existing && live.has(existing)) return existing; const id = `s${++n}`; live.add(id); opened.push(title); return id; },
      say: async (id, role, text) => { said.push({ id, role, text }); },
      turn: async (id, text) => {
        turns.push({ id, text });
        if (o.wakeStartsClaude !== false && text.startsWith("[Portal work order]")) { const r = jobs.start(id, "Build it", dir); if (typeof r === "string") throw new Error(r); }
        return { ok: true, finalText: text.startsWith("[Claude Code finished") ? "Live at https://example.com" : "Handed to Claude Code." };
      },
      card: async (id, task) => { cards.push({ id, task: task as Record<string, unknown> }); return true; },
    },
  };
  return { eng: new PortalEngineer(deps), dir, calls, said, opened, live, runs, turns, cards, jobs, milestones };
}

test("engineerAllowed: never on the hosted gateway; DAEBOT_ENGINEER=off turns it off", () => {
  assert.equal(engineerAllowed({ hosted: true, env: {} }), false);
  assert.equal(engineerAllowed({ hosted: false, env: {} }), true);
  assert.equal(engineerAllowed({ hosted: false, env: { DAEBOT_ENGINEER: "off" } }), false);
});

test("poll with no job: one GET with the MIND key header, idle, nothing run", async () => {
  const h = harness({ answers: [{ status: 200, body: { dispatch: null } }] });
  const next = await h.eng.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "GET");
  assert.equal(h.calls[0].url, "https://api.theastraway.com/api/portal/engineer-runner/next");
  assert.equal(h.calls[0].headers["X-MIND-Key"], KEY);
  assert.equal(next, 30_000);
  assert.equal(h.runs.length, 0);
  assert.equal(h.eng.status().state, "idle");
});

test("a claimed job wakes Daebot: card not_started -> in_progress, the portal work order as a real turn, Claude Code as sub-worker, ready_to_test, follow-up turn, result", async () => {
  const h = harness({ answers: [{ status: 200, body: { dispatch: job("d1") } }, { status: 200, body: { ok: true } }] });
  const next = await h.eng.tick();
  assert.equal(next, 0, "looks again right away after a job");
  assert.deepEqual(h.opened, ["Atlas · ContentsCounter"]);
  // the card: declared with the portal link, then moved along
  assert.equal(h.cards[0].task.id, "portal-t-d1");
  assert.equal(h.cards[0].task.status, "not_started");
  assert.deepEqual(h.cards[0].task.portal, { todoId: "t-d1", dispatchId: "d1", account: "anthonyjconti" });
  assert.deepEqual(h.cards.map((c) => c.task.status).filter(Boolean), ["not_started", "in_progress", "ready_to_test"]);
  // the wake turn carries the portal's own work order; client text is fenced as data; no token
  assert.equal(h.turns.length, 2);
  assert.match(h.turns[0].text, /^\[Portal work order\]/);
  assert.match(h.turns[0].text, /Instruction from the portal: Do it\./);
  assert.match(h.turns[0].text, /<<<portal-data[\s\S]*Fix d1[\s\S]*portal-data>>>/);
  assert.ok(!h.turns[0].text.includes("etk.todo.secret.sig"), "the token never reaches the model");
  assert.match(h.turns[1].text, /^\[Claude Code finished: portal dispatch d1\]/);
  // Claude Code ran with the portal rules prepended and the token only in its env
  assert.equal(h.runs.length, 1);
  assert.match(h.runs[0].prompt, /You are Daebot Engineer/);
  assert.match(h.runs[0].prompt, /Daebot's instructions for this run:\nBuild it/);
  assert.equal(h.runs[0].env.PORTAL_TASK_TOKEN, "etk.todo.secret.sig");
  assert.equal(h.runs[0].env.ANTHROPIC_API_KEY, undefined);
  assert.ok(existsSync(join(h.runs[0].dir, "job.json")));
  assert.ok(h.milestones.includes("PR: https://github.com/theastraway/x/pull/12"));
  const post = h.calls.find((c) => c.method === "POST")!;
  assert.equal(post.url, "https://api.theastraway.com/api/portal/engineer-runner/dispatches/d1/result");
  const body = JSON.parse(post.body!);
  assert.equal(body.ok, true);
  assert.match(body.summary, /Shipped PR 12[\s\S]*Daebot: Live at https:\/\/example.com/);
  assert.ok(!readFileSync(join(h.dir, "state.json"), "utf8").includes(KEY));
  assert.equal(JSON.parse(readFileSync(join(h.dir, "state.json"), "utf8")).active, undefined, "no job left in flight");
});

test("Daebot does not start Claude Code on its own: the engineer starts it, so the job never stalls", async () => {
  const h = harness({ wakeStartsClaude: false, answers: [{ status: 200, body: { dispatch: job("d2") } }, { status: 200, body: {} }] });
  await h.eng.tick();
  assert.equal(h.runs.length, 1);
  assert.ok(h.said.some((x) => /Started Claude Code/.test(x.text)));
});

test("the portal did not move the to-do: the card is stopped with the blocker as its question, ok:false", async () => {
  const h = harness({ taskStatus: "in_progress", answers: [{ status: 200, body: { dispatch: job("d3") } }, { status: 200, body: {} }] });
  await h.eng.tick();
  const last = h.cards.at(-1)!.task;
  assert.equal(last.status, "stopped");
  assert.match(String(last.question), /Not finished \(portal status in_progress\)/);
  assert.equal(JSON.parse(h.calls.find((c) => c.method === "POST")!.body!).ok, false);
});

test("restart mid-job: the saved job is reported as interrupted, its card stopped with a question", async () => {
  const h = harness({ answers: [{ status: 200, body: {} }, { status: 200, body: { dispatch: null } }] });
  writeFileSync(join(h.dir, "state.json"), JSON.stringify({ v: 1, enabled: true, threads: {}, active: { dispatchId: "old1", account: "anthonyjconti", threadId: "s9", cardId: "portal-x", todo: "Fix old", startedAt: 1 } }));
  const eng = new PortalEngineer({ ...((h.eng as unknown as { d: EngineerDeps }).d) });
  await eng.tick();
  const post = h.calls.find((c) => c.method === "POST")!;
  assert.match(post.url, /dispatches\/old1\/result$/);
  assert.equal(JSON.parse(post.body!).ok, false);
  assert.equal(h.cards[0].task.status, "stopped");
  assert.match(String(h.cards[0].task.question), /Daebot restarted/);
  assert.equal(JSON.parse(readFileSync(join(h.dir, "state.json"), "utf8")).active, undefined);
});

test("claude_code tool: start returns at once, one job per thread, status, stop; the exit hook fires", async () => {
  let release!: (v: { ok: boolean; summary: string }) => void;
  const jobs = new ClaudeJobs({ run: () => new Promise((r) => { release = r; }) });
  const exits: string[] = [];
  jobs.onExit = (_s, j) => { exits.push(j.status); };
  const tool = createClaudeCodeTool(jobs);
  const ctx = { cwd: mkdtempSync(join(tmpdir(), "cc-")), sessionId: "sx" };
  assert.equal((await tool.run({ action: "start" }, ctx)).ok, false);
  const r = await tool.run({ action: "start", task: "Build the thing" }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /Claude Code started/);
  assert.match((await tool.run({ action: "start", task: "again" }, ctx)).output, /already working/);
  assert.match((await tool.run({ action: "status" }, ctx)).output, /running/);
  release({ ok: true, summary: "done" });
  await jobs.wait(jobs.running("sx")!.id);
  assert.deepEqual(exits, ["done"]);
  assert.equal(tool.class, "write");
});

test("the same project reuses its thread; another project gets its own", async () => {
  const h = harness({ answers: [{ status: 200, body: { dispatch: job("a", "p1") } }, { status: 200, body: {} }, { status: 200, body: { dispatch: job("b", "p1") } }, { status: 200, body: {} }, { status: 200, body: { dispatch: job("c", "p2", { project: { id: "p2", title: "Olympus" } }) } }, { status: 200, body: {} }] });
  await h.eng.tick(); await h.eng.tick(); await h.eng.tick();
  assert.deepEqual(h.opened, ["Atlas · ContentsCounter", "Atlas · Olympus"]);
  assert.deepEqual(h.turns.filter((t) => t.text.startsWith("[Portal work order]")).map((t) => t.id), ["s1", "s1", "s2"]);
  const saved = JSON.parse(readFileSync(join(h.dir, "state.json"), "utf8"));
  assert.deepEqual(saved.threads, { "anthonyjconti|p1": "s1", "anthonyjconti|p2": "s2" });
});

test("a deleted thread is replaced", async () => {
  const h = harness({ answers: [{ status: 200, body: { dispatch: job("a") } }, { status: 200, body: {} }, { status: 200, body: { dispatch: job("b") } }, { status: 200, body: {} }] });
  await h.eng.tick();
  h.live.clear();
  await h.eng.tick();
  assert.equal(h.opened.length, 2);
});

test("result posting retries on 5xx and network errors, at most 5 tries", async () => {
  const h = harness({ answers: [{ status: 200, body: { dispatch: job("r") } }, { status: 502, body: {} }, new Error("net down"), { status: 200, body: {} }] });
  await h.eng.tick();
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 3);
  const h2 = harness({ answers: [{ status: 200, body: { dispatch: job("r2") } }, { status: 503, body: {} }] });
  await h2.eng.tick();
  assert.equal(h2.calls.filter((c) => c.method === "POST").length, 5);
  assert.match(h2.eng.status().lastError ?? "", /Could not report/);
});

test("setting off, or signed out: no polls", async () => {
  const h = harness({ answers: [{ status: 200, body: { dispatch: job("x") } }] });
  h.eng.setEnabled(false);
  await h.eng.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.eng.status().state, "off");
  const h2 = harness({ answers: [{ status: 200, body: {} }], key: undefined });
  await h2.eng.tick();
  assert.equal(h2.calls.length, 0);
  assert.equal(h2.eng.status().state, "signed_out");
  // the switch persists
  const again = new PortalEngineer({ dir: h.dir, jobs: new ClaudeJobs(), getAccounts: () => [{ account: "a", key: KEY }], threads: { ensure: async () => "s", say: async () => {}, turn: async () => ({ ok: true, finalText: "" }), card: async () => true } });
  assert.equal(again.status().enabled, false);
});

test("not an engineer (403/404): backs off to the long interval", async () => {
  const h = harness({ answers: [{ status: 403, body: { detail: "no" } }] });
  await h.eng.tick(); await h.eng.tick();
  assert.equal(h.calls.length, 1, "not asked again within 15 minutes");
  assert.equal(h.eng.status().accounts![0].state, "not_engineer");
  const h2 = harness({ answers: [{ status: 401, body: {} }] });
  await h2.eng.tick(); await h2.eng.tick();
  assert.equal(h2.calls.length, 1);
  assert.equal(h2.eng.status().accounts![0].state, "rejected");
  assert.match(h2.eng.status().accounts![0].lastError ?? "", /did not accept this MIND sign-in/);
});

test("a failed run reports ok:false", async () => {
  const h = harness({ answers: [{ status: 200, body: { dispatch: job("f") } }, { status: 200, body: {} }], runOk: false });
  await h.eng.tick();
  assert.equal(JSON.parse(h.calls.find((c) => c.method === "POST")!.body!).ok, false);
  assert.equal(h.cards.at(-1)!.task.status, "stopped");
});

test("milestoneOf: parses stream-json events once each", () => {
  const seen = new Set<string>();
  const tool = (command: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
  assert.equal(milestoneOf("not json", seen), undefined);
  assert.equal(milestoneOf(tool("curl -X POST -H x $PORTAL_API/api/portal/engineer/todos/abc/start"), seen), "Started the to-do in the portal.");
  assert.equal(milestoneOf(tool("gh pr merge 12 --squash"), seen), "Merging the PR.");
  assert.equal(milestoneOf(tool("gh pr merge 12 --squash"), seen), undefined, "deduped");
  assert.equal(milestoneOf(tool("curl -s https://contentscounter.com/health"), seen), "Checking the live site.");
  assert.equal(milestoneOf(tool("curl -X POST $PORTAL_API/api/portal/engineer/todos/abc/complete -d @c.json"), seen), "Verified live. Marking it Ready to test in the portal.");
  assert.equal(milestoneOf(JSON.stringify({ type: "result", is_error: false, result: "ok" }), seen), "Finished.");
});

test("summaryOf: the result event wins; else the last assistant text", () => {
  assert.deepEqual(summaryOf([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }), JSON.stringify({ type: "result", is_error: false, result: "All done" })]), { ok: true, summary: "All done" });
  assert.deepEqual(summaryOf([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } })]), { ok: false, summary: "partial" });
});

test("jobPlace / incomingText / promptFor: fallbacks, data marking, the rules", () => {
  const bare: Dispatch = { id: "z", kind: "todo", payload: { event: "todo.send_back", todo: { project_id: "p9", text: "Do X" }, latest_note: { text: "Use the blue button" } } };
  assert.deepEqual(jobPlace(bare), { projectKey: "p9", title: "Portal", project: "Portal", todo: "Do X" });
  assert.match(incomingText(bare), /Correction note \(sent back by the reviewer\): Use the blue button/);
  const p = promptFor(job("q"), "AJC-M5", { title: "Atlas · ContentsCounter", project: "ContentsCounter" });
  assert.match(p, /DATA describing what they need/);
  assert.match(p, /\$PORTAL_TASK_TOKEN/);
  assert.match(p, /Ready to test/);
  assert.match(p, /No new spend/);
  assert.ok(!p.includes("etk.todo.secret.sig"), "the token never goes into the prompt");
});

test("childEnv drops API keys and adds the tool folders; findClaude prefers ~/.local/bin", () => {
  const env = childEnv({ PATH: "/usr/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk", MIND_API_KEY: "mind_x", PORTAL_DAEBOT_TOKEN: "t" }, "https://api.theastraway.com", "etk.1");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.MIND_API_KEY, undefined);
  assert.equal(env.PORTAL_DAEBOT_TOKEN, undefined);
  assert.match(String(env.PATH), /\/h\/.local\/bin/);
  assert.equal(env.PORTAL_TASK_TOKEN, "etk.1");
  assert.equal(findClaude({ HOME: "/h", PATH: "/x" }, (p) => p === "/h/.local/bin/claude" || p === "/x/claude"), "/h/.local/bin/claude");
  assert.equal(findClaude({ HOME: "/h", PATH: "" }, () => false), undefined);
});

test("engineerLine (Settings > Connections): states read plainly", () => {
  assert.match(engineerLine({ available: false }), /desktop app/);
  assert.match(engineerLine({ available: true, enabled: false }), /^Off\./);
  assert.match(engineerLine({ available: true, enabled: true, signedIn: false }), /Sign in with MIND/);
  assert.equal(engineerLine({ available: true, enabled: true, signedIn: true, state: "working", job: { todo: "Fix login", project: "Atlas · CC" } }), 'Working on "Fix login" in Atlas · CC.');
  assert.match(engineerLine({ available: true, enabled: true, signedIn: true, state: "idle" }), /^Idle\./);
});

const KEY2 = "mind_clientkey_zyxwvutsrqponm";

test("every signed-in account polls with its own key; a job for a non-active account names the account in the thread and reports with that key", async () => {
  const h = harness({ accounts: [{ account: "atlas_adjustments", key: KEY2, active: true }, { account: "anthonyjconti", key: KEY }], answers: [{ status: 200, body: { dispatch: null, routed: false, account: "atlas_adjustments", hint: "No project routes to this account." } }, { status: 200, body: { dispatch: job("m1") } }, { status: 200, body: {} }] });
  await h.eng.tick();
  assert.deepEqual(h.calls.map((c) => [c.method, c.headers["X-MIND-Key"]]), [["GET", KEY2], ["GET", KEY], ["POST", KEY]]);
  assert.deepEqual(h.opened, ["Atlas · ContentsCounter (anthonyjconti)"]);
  const st = h.eng.status();
  assert.deepEqual(st.accounts!.map((a) => [a.account, a.state]), [["atlas_adjustments", "not_engineer"], ["anthonyjconti", "engineer"]]);
  assert.equal(st.accounts![0].hint, "No project routes to this account.");
  assert.match(engineerAccountsLine(st), /^atlas_adjustments: not an engineer · anthonyjconti: engineer$/);
});

test("routed:false: that account is asked again only after 15 minutes; the engineer account keeps its 30 s rhythm", async () => {
  let t = 1_000_000;
  const h = harness({ now: () => t, accounts: [{ account: "client", key: KEY2, active: true }, { account: "anthonyjconti", key: KEY }], answers: [{ status: 200, body: { dispatch: null, routed: false } }, { status: 200, body: { dispatch: null, routed: true } }] });
  await h.eng.tick();
  assert.equal(h.calls.length, 2);
  t += 31_000;
  await h.eng.tick();
  assert.deepEqual(h.calls.slice(2).map((c) => c.headers["X-MIND-Key"]), [KEY], "only the engineer account is asked again");
  t += IDLE_BACKOFF_MS;
  await h.eng.tick();
  assert.deepEqual(h.calls.slice(3).map((c) => c.headers["X-MIND-Key"]), [KEY2, KEY]);
});

test("one poll loop: setEnabled(true) and start() never leave two timers; a round in flight is not re-entered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eng-t-"));
  const live = new Set<number>();
  let n = 0, fetches = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const eng = new PortalEngineer({
    dir, jobs: new ClaudeJobs(), getAccounts: () => [{ account: "a", key: KEY, active: true }], threads: { ensure: async () => "s", say: async () => {}, turn: async () => ({ ok: true, finalText: "" }), card: async () => true },
    fetchImpl: (async () => { fetches++; await gate; return new Response(JSON.stringify({ dispatch: null })); }) as unknown as typeof fetch,
    timers: { set: () => { const id = ++n; live.add(id); return id; }, clear: (id) => { live.delete(id as number); } },
  });
  eng.start();
  assert.equal(live.size, 1);
  eng.setEnabled(true); eng.setEnabled(true);
  assert.equal(live.size, 1, "the switch replaces the pending timer instead of adding one");
  const first = eng.tick();
  const second = await eng.tick();
  assert.equal(second, 30_000);
  eng.setEnabled(true);
  release();
  await first;
  assert.equal(fetches, 1, "the second round did not run while the first was in flight");
  assert.equal(live.size, 1, "exactly one timer after the round");
  eng.stop();
  assert.equal(live.size, 0);
});

test("readDesktopAccounts: every account with a mind_ key, the active one marked; no file falls back to the gateway key", () => {
  const home = mkdtempSync(join(tmpdir(), "eng-home-"));
  assert.deepEqual(readDesktopAccounts(home, { key: KEY }), [{ account: "this account", key: KEY, active: true }]);
  assert.deepEqual(readDesktopAccounts(home, {}), []);
  writeFileSync(join(home, "accounts.json"), JSON.stringify({ v: 1, active: "a_2", accounts: [{ id: "a_1", key: KEY, name: "anthonyjconti" }, { id: "a_2", key: KEY2, name: "atlas_adjustments" }, { id: "a_3", key: "nope", name: "x" }] }));
  assert.deepEqual(readDesktopAccounts(home, { key: KEY }), [{ account: "anthonyjconti", key: KEY }, { account: "atlas_adjustments", key: KEY2, active: true }]);
});

test("board: a card keeps its portal link and progress through the model's own task_board updates", async () => {
  const { checkTask } = await import("../../src/board/board.ts");
  const first = checkTask({ id: "portal-t1", title: "Portal: Fix", status: "not_started" }, 1, undefined, undefined, { portal: { todoId: "t1", dispatchId: "d1", account: "a", url: "https://theastraway.com/x" }, progress: "Opening a PR." });
  assert.ok(first.ok);
  const v = (first as { ok: true; value: import("../../src/board/board.ts").BoardTask }).value;
  assert.deepEqual(v.portal, { todoId: "t1", dispatchId: "d1", account: "a", url: "https://theastraway.com/x" });
  assert.equal(v.progress, "Opening a PR.");
  const model = checkTask({ id: "portal-t1", status: "in_progress", portal: { todoId: "evil", dispatchId: "x" } }, 2, v);
  assert.ok(model.ok);
  assert.equal((model as { ok: true; value: import("../../src/board/board.ts").BoardTask }).value.portal!.todoId, "t1", "the model cannot change the portal link");
  const bad = checkTask({ id: "p", title: "x", status: "not_started" }, 3, undefined, undefined, { portal: { todoId: "t", dispatchId: "d", url: "javascript:alert(1)" } });
  assert.equal((bad as { ok: true; value: import("../../src/board/board.ts").BoardTask }).value.portal!.url, undefined);
});

test("never claims while a job is active (working, follow-up, result): repeated ticks during a job make no /next call", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const h = harness({ gate, answers: [{ status: 200, body: { dispatch: job("busy1") } }, { status: 200, body: { dispatch: job("never") } }] });
  const first = h.eng.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.eng.busy(), true);
  for (let i = 0; i < 5; i++) await h.eng.tick();
  assert.equal(h.calls.filter((c) => c.method === "GET").length, 1, "no claim while busy");
  open();
  await first;
  assert.equal(h.eng.busy(), false);
});

test("finish-then-claim race: the job claimed right after one finishes is run, not dropped", async () => {
  const h = harness({ answers: [{ status: 200, body: { dispatch: job("r1") } }, { status: 200, body: {} }, { status: 200, body: { dispatch: job("r2", "p1") } }, { status: 200, body: {} }, { status: 200, body: { dispatch: null } }] });
  assert.equal(await h.eng.tick(), 0);
  assert.equal(await h.eng.tick(), 0, "the next round claims at once");
  const posts = h.calls.filter((c) => c.method === "POST").map((c) => c.url.split("/dispatches/")[1]);
  assert.deepEqual(posts, ["r1/result", "r2/result"]);
  assert.ok(existsSync(join(h.dir, "work", "r2", "job.json")));
  const st = JSON.parse(readFileSync(join(h.dir, "state.json"), "utf8"));
  assert.equal(st.queue, undefined);
  assert.equal(st.active, undefined);
});

test("a claimed job is persisted before it starts; a queued job (claimed while busy or before a restart) runs first, without a new claim", async () => {
  const h = harness({ answers: [{ status: 200, body: {} }, { status: 200, body: { dispatch: null } }] });
  writeFileSync(join(h.dir, "state.json"), JSON.stringify({ v: 1, enabled: true, threads: {}, queue: [{ account: "anthonyjconti", job: job("q1"), claimedAt: 1 }] }));
  const eng = new PortalEngineer({ ...((h.eng as unknown as { d: EngineerDeps }).d) });
  assert.equal(await eng.tick(), 0);
  assert.equal(h.calls[0].method, "POST", "the queued job ran before any new /next");
  assert.match(h.calls[0].url, /dispatches\/q1\/result$/);
  const st = JSON.parse(readFileSync(join(h.dir, "state.json"), "utf8"));
  assert.equal(st.queue, undefined, "dequeued once it ran");
});

test("claim while busy (a response that lands during a job): it goes to the persisted queue and runs next", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const h = harness({ gate, answers: [{ status: 200, body: { dispatch: job("b1") } }, { status: 200, body: {} }, { status: 200, body: {} }] });
  const first = h.eng.tick();
  await new Promise((r) => setTimeout(r, 20));
  // the portal hands this engineer a claim while it is busy (e.g. an in-flight poll from before)
  (h.eng as unknown as { enqueue(a: EngineerAccount, j: Dispatch): void }).enqueue({ account: "anthonyjconti", key: KEY, active: true }, job("b2"));
  assert.equal(JSON.parse(readFileSync(join(h.dir, "state.json"), "utf8")).queue[0].job.id, "b2");
  open();
  await first;
  await h.eng.tick();
  const posts = h.calls.filter((c) => c.method === "POST").map((c) => c.url.split("/dispatches/")[1]);
  assert.deepEqual(posts, ["b1/result", "b2/result"]);
});

test("every /next names the device so the portal can tell which computer claimed a job", async () => {
  const h = harness({ answers: [{ status: 200, body: { dispatch: null } }] });
  await h.eng.tick();
  assert.ok(String(h.calls[0].headers["X-Daebot-Device"] ?? "").length > 0);
});
