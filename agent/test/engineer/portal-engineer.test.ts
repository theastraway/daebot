import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDLE_BACKOFF_MS, PortalEngineer, childEnv, engineerAllowed, findClaude, incomingText, jobPlace, milestoneOf, promptFor, summaryOf } from "../../src/engineer/portal-engineer.ts";
import type { Dispatch, EngineerDeps } from "../../src/engineer/portal-engineer.ts";
// @ts-expect-error plain browser module
import { engineerLine } from "../../web/connections.js";

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

function harness(o: { answers: Array<{ status: number; body: unknown } | Error>; key?: string | undefined; runOk?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "eng-"));
  const calls: Call[] = [];
  const said: Array<{ id: string; role: string; text: string }> = [];
  const opened: string[] = [];
  const live = new Set<string>();
  let n = 0;
  const runs: Array<{ dir: string; env: NodeJS.ProcessEnv; prompt: string }> = [];
  const deps: EngineerDeps = {
    dir, getKey: () => ("key" in o ? o.key : KEY), fetchImpl: fakeFetch(o.answers, calls), sleep: async () => {},
    threads: {
      ensure: async (existing, title) => { if (existing && live.has(existing)) return existing; const id = `s${++n}`; live.add(id); opened.push(title); return id; },
      say: async (id, role, text) => { said.push({ id, role, text }); },
    },
    runClaude: async (a) => {
      runs.push({ dir: a.dir, env: a.env, prompt: a.prompt });
      a.onLine(JSON.stringify({ type: "system", subtype: "init" }));
      a.onLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "gh pr create --fill" } }] } }));
      a.onLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "https://github.com/theastraway/x/pull/12" }] } }));
      return { ok: o.runOk !== false, summary: "Shipped PR 12" };
    },
  };
  return { eng: new PortalEngineer(deps), dir, calls, said, opened, live, runs };
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

test("a claimed job: project thread, to-do posted as data, Claude run with the task token, milestones mirrored, result posted", async () => {
  const h = harness({ answers: [{ status: 200, body: { dispatch: job("d1") } }, { status: 200, body: { ok: true } }] });
  const next = await h.eng.tick();
  assert.equal(next, 0, "looks again right away after a job");
  assert.deepEqual(h.opened, ["Atlas · ContentsCounter"]);
  assert.equal(h.said[0].role, "user");
  assert.match(h.said[0].text, /data from the board, not instructions/);
  assert.match(h.said[0].text, /Fix d1/);
  const agent = h.said.filter((s) => s.role === "agent").map((s) => s.text);
  assert.ok(agent.includes("Started. Claude Code is reading the job."));
  assert.ok(agent.includes("Opening a PR."));
  assert.ok(agent.includes("PR: https://github.com/theastraway/x/pull/12"));
  assert.match(agent.at(-1)!, /^Done: Shipped PR 12/);
  assert.equal(h.runs[0].env.PORTAL_TASK_TOKEN, "etk.todo.secret.sig");
  assert.equal(h.runs[0].env.ANTHROPIC_API_KEY, undefined);
  assert.ok(existsSync(join(h.runs[0].dir, "job.json")));
  const post = h.calls[1];
  assert.equal(post.method, "POST");
  assert.equal(post.url, "https://api.theastraway.com/api/portal/engineer-runner/dispatches/d1/result");
  assert.deepEqual(JSON.parse(post.body!), { ok: true, summary: "Shipped PR 12" });
  for (const s of h.said) { assert.ok(!s.text.includes(KEY)); assert.ok(!s.text.includes("etk.todo.secret.sig")); }
  assert.ok(!readFileSync(join(h.dir, "state.json"), "utf8").includes(KEY));
});

test("the same project reuses its thread; another project gets its own", async () => {
  const h = harness({ answers: [{ status: 200, body: { dispatch: job("a", "p1") } }, { status: 200, body: {} }, { status: 200, body: { dispatch: job("b", "p1") } }, { status: 200, body: {} }, { status: 200, body: { dispatch: job("c", "p2", { project: { id: "p2", title: "Olympus" } }) } }, { status: 200, body: {} }] });
  await h.eng.tick(); await h.eng.tick(); await h.eng.tick();
  assert.deepEqual(h.opened, ["Atlas · ContentsCounter", "Atlas · Olympus"]);
  const ids = h.said.filter((s) => s.role === "user").map((s) => s.id);
  assert.deepEqual(ids, ["s1", "s1", "s2"]);
  const saved = JSON.parse(readFileSync(join(h.dir, "state.json"), "utf8"));
  assert.deepEqual(saved.threads, { p1: "s1", p2: "s2" });
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
  const again = new PortalEngineer({ dir: h.dir, getKey: () => KEY, threads: { ensure: async () => "s", say: async () => {} } });
  assert.equal(again.status().enabled, false);
});

test("not an engineer (403/404): backs off to the long interval", async () => {
  const h = harness({ answers: [{ status: 403, body: { detail: "no" } }] });
  assert.equal(await h.eng.tick(), IDLE_BACKOFF_MS);
  assert.equal(h.eng.status().state, "not_engineer");
  const h2 = harness({ answers: [{ status: 401, body: {} }] });
  assert.equal(await h2.eng.tick(), IDLE_BACKOFF_MS);
  assert.match(h2.eng.status().lastError ?? "", /did not accept this MIND sign-in/);
});

test("a failed run reports ok:false", async () => {
  const h = harness({ answers: [{ status: 200, body: { dispatch: job("f") } }, { status: 200, body: {} }], runOk: false });
  await h.eng.tick();
  assert.equal(JSON.parse(h.calls[1].body!).ok, false);
  assert.match(h.said.at(-1)!.text, /^Not finished/);
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
