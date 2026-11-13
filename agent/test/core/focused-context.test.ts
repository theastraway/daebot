// DAEBOT_FOCUSED_CONTEXT: what reaches the model for four representative messages, before (flag 0) and after (flag on).
// Prints total prompt + tool chars for each so a regression in size is visible in the test log.
import { test } from "node:test";
process.env.DAEBOT_BOTS_ENABLED = "1";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { FakeProvider, baseCfg, collect } from "./helpers.ts";
import { capBoot, computeFocus, isAutomatedMessage, isTrivialMessage, selectRelevant } from "../../src/focus.ts";
import { mistakeBriefFor } from "../../src/gateway/mistakes.ts";

const rnd = () => randomBytes(18).toString("hex");

const SOUL = "SOUL: I am Dae. ".padEnd(900, "s");
const RULES = "## house rules\n" + Array.from({ length: 400 }, (_, i) => `Rule ${i}: never guess a number, name or id.`).join("\n");
const PRIORITIES = "PRIORITY-MARKER Colosseum graphics; OpenRouter attribution; Google verification; Kerner Law Group. " + "p".repeat(2500);
const RECENT = "RECENT-MARKER ILYVEN $1.50 regression re-run; Needs your answer; PROOF-2; Graph Automations. " + "r".repeat(2500);

function mistakeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "focus-mistakes-"));
  mkdirSync(join(dir, "admin"), { recursive: true });
  const types: Record<string, unknown> = {
    m1: { id: "m1", name: "Agent sessions first", prevention: "Check agent sessions before answering anything about agents." },
    m2: { id: "m2", name: "Claimed done without proof", prevention: "Never say done without a receipt." },
    m3: { id: "m3", name: "Wrong board count", prevention: "Count the task board from the live board, never from memory." },
  };
  const occ = ["m1", "m1", "m2", "m3"].map((t) => ({ type_id: t, when: "2026-11-10T00:00:00Z" }));
  writeFileSync(join(dir, "admin", "mistake-log.json"), JSON.stringify({ v: 1, types, occurrences: occ }));
  return dir;
}

async function promptFor(message: string, focused: boolean): Promise<{ system: string; tools: string[]; toolChars: number; all: string; msgs: { role: string; content: string }[] }> {
  const old = process.env.DAEBOT_FOCUSED_CONTEXT;
  process.env.DAEBOT_FOCUSED_CONTEXT = focused ? "1" : "0";
  const key = "mind_" + rnd();
  const fake = await startFakeMind({ [key]: "pat" });
  fake.contextText = { soul: SOUL, user: "USER: Anthony", rules: RULES, priorities: PRIORITIES, recent: RECENT };
  fake.queryAnswer = (q) => (/task board/i.test(q)
    ? "The task board lists multi-step work: ILYVEN regression is red, Sarah NJ retainers is yellow.\n\nUnrelated paragraph about lunch."
    : "I don't have information about that in MIND.");
  const dir = mkdtempSync(join(tmpdir(), "focus-rt-"));
  const provider = new FakeProvider([{ text: "ok" }]);
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: key });
  try {
    const rt = createRuntime(cfg, { provider, store: createFileStore(dir), owner: "u_pat", bots: { dir, bus: {} }, mistakeDir: mistakeDir(), hosted: { dailyUsdCap: 50, username: "pat", exempt: true } });
    const s = await rt.openSession({ surface: "web", identity: "admin" });
    await collect(s.send(message));
    const req = provider.requests[0];
    const system = String(req.messages[0].content);
    const extra = req.messages.slice(1).filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
    const toolChars = JSON.stringify(req.tools).length;
    return { system, tools: req.tools.map((t) => t.name), toolChars, all: system + "\n" + extra, msgs: req.messages as any };
  } finally {
    await fake.close();
    if (old === undefined) delete process.env.DAEBOT_FOCUSED_CONTEXT; else process.env.DAEBOT_FOCUSED_CONTEXT = old;
  }
}

const CASES = {
  a: "Hello, how are you?",
  b: "open the github link in safari",
  c: "create a bot that summarizes leads every monday",
  d: "what's on my task board",
};

const sizes: Record<string, { before: number; after: number }> = {};
async function both(k: keyof typeof CASES) {
  const before = await promptFor(CASES[k], false);
  const after = await promptFor(CASES[k], true);
  sizes[k] = { before: before.all.length + before.toolChars, after: after.all.length + after.toolChars };
  console.log(`[focused-context] ${k} ${JSON.stringify(CASES[k])}: prompt+tools chars before=${sizes[k].before} after=${sizes[k].after} (tools ${before.tools.length} -> ${after.tools.length})`);
  return { before, after };
}

test("(a) a greeting carries no priorities, recent, lessons, mistakes or skill text beyond the index", async () => {
  const { before, after } = await both("a");
  assert.match(before.all, /PRIORITY-MARKER/, "the old boot did dump priorities");
  assert.doesNotMatch(after.all, /PRIORITY-MARKER|RECENT-MARKER/);
  assert.doesNotMatch(after.all, /\[learned\]|Relevant from MIND|repeat failures|Agent sessions first/);
  for (const heading of ["## Creating a Daebot", "## Managing bots", "## Task board", "## Deciding on a task", "## Your Grok bots", "## Photos", "## Work in the background first", "## Connecting MCP servers", "## Documents"]) {
    assert.ok(!after.all.includes(heading), `${heading} must not be in a greeting prompt`);
  }
  assert.match(after.all, /## Skills \(index/);
  assert.ok(!after.tools.includes("bot_manage") && !after.tools.includes("task_board") && !after.tools.includes("computer"));
  for (const core of ["mind_query", "mind_remember", "web_search", "web_fetch", "bot_talk"]) assert.ok(after.tools.includes(core), `core tool ${core}`);
  assert.ok(after.all.length < before.all.length && after.toolChars < before.toolChars);
  // the boot is soul + rules only and capped
  assert.match(after.all, /SOUL: I am Dae/);
  assert.ok(after.system.indexOf("## MIND context (booted this session)") > 0);
  const bootBlock = after.system.slice(after.system.indexOf("## MIND context (booted this session)"));
  assert.ok(bootBlock.length < 6_400, `boot block ${bootBlock.length}`);
  // the date line is last: the stable prefix is identical turn to turn
  assert.match(after.system.trimEnd().split("\n").pop()!, /^Surface: web\..*Date: /);
});

test("(b) opening a link brings the screen tools and the routing skill, not bots or the board", async () => {
  const { after } = await both("b");
  assert.match(after.all, /## Work in the background first/);
  assert.ok(!after.tools.includes("bot_manage") && !after.tools.includes("task_board"));
  assert.doesNotMatch(after.all, /PRIORITY-MARKER|RECENT-MARKER|Relevant from MIND/);
});

test("(c) creating a bot includes the bot skill and bot_manage", async () => {
  const { after } = await both("c");
  assert.ok(after.tools.includes("bot_manage"));
  assert.match(after.all, /## Creating a Daebot/);
  assert.match(after.all, /## Managing bots/);
  assert.doesNotMatch(after.all, /PRIORITY-MARKER|RECENT-MARKER/);
  assert.doesNotMatch(after.all, /Relevant from MIND/, "a generic MIND answer injects nothing");
});

test("(d) the task board question includes the board skill, its tools and the relevant MIND items only", async () => {
  const { after } = await both("d");
  assert.ok(after.tools.includes("task_board"));
  assert.match(after.all, /## Task board/);
  assert.match(after.all, /Relevant from MIND for this message/);
  assert.match(after.all, /ILYVEN regression is red/);
  assert.doesNotMatch(after.all, /Unrelated paragraph about lunch/);
  assert.match(after.all, /Wrong board count/, "a matching mistake rides along");
  assert.doesNotMatch(after.all, /Agent sessions first|Claimed done without proof/, "non-matching mistakes do not");
  assert.doesNotMatch(after.all, /PRIORITY-MARKER|RECENT-MARKER/);
  assert.ok(!after.tools.includes("bot_manage"));
});

test("sizes summary", () => {
  console.log("[focused-context] summary " + JSON.stringify(sizes));
});

// ---------------------------------------------------------------- unit
test("trivial messages", () => {
  for (const m of ["Hello, how are you?", "yes", "ok thanks", "hi dae", "go", "send it", "continue", "good morning", "how are you doing today", "do it", "thanks!"]) assert.ok(isTrivialMessage(m), m);
  for (const m of ["what's on my task board", "open the github link in safari", "yes send the email to bob", "hello can you check my calendar", "go to render and check the deploy", "status of the ILYVEN fix"]) assert.ok(!isTrivialMessage(m), m);
});

test("automated turns are recognised", () => {
  assert.ok(isAutomatedMessage('[Routine "Heartbeat" started by its timer at 2026-11-13T17:15:07Z]'));
  assert.ok(isAutomatedMessage("[Check-in from your Heartbeat] status?"));
  assert.ok(!isAutomatedMessage("check in with the team"));
});

test("selectRelevant: empty, generic and low-overlap answers inject nothing; a real hit is capped", () => {
  assert.equal(selectRelevant("what is the plan for the leads report", ""), undefined);
  assert.equal(selectRelevant("what is the plan for the leads report", "I don't have information about that."), undefined);
  assert.equal(selectRelevant("what is the plan for the leads report", "The weather in Paris is mild today and the museum opens early."), undefined);
  assert.equal(selectRelevant("leads", "leads report weekly summary every Monday morning for the sales team"), undefined, "one meaningful term is not enough");
  const many = Array.from({ length: 8 }, (_, i) => `Leads report ${i}: weekly summary of leads for the sales team ${"x".repeat(1200)}`).join("\n\n");
  const out = selectRelevant("summarize the weekly leads report", many)!;
  assert.ok(out.length <= 3_100, `length ${out.length}`);
  assert.ok((out.match(/^- /gm) ?? []).length <= 3);
});

test("computeFocus: connect/use-n8n exposes connector tools, mid-use tools are kept, MCP is capped at 40", () => {
  const mk = (name: string, server?: string): any => ({ spec: { name, description: `${name} tool` }, class: "read", ...(server ? { mcp: { server, host: "h", tool: name } } : {}), run: async () => ({ ok: true, output: "" }) });
  const mcp = Array.from({ length: 70 }, (_, i) => mk(`n8n__tool_${i}`, "n8n"));
  const all = [mk("mind_query"), mk("bot_manage"), mk("mcp_connect"), mk("task_board"), mk("github__search", "github"), ...mcp];
  const n8n = computeFocus(all, "use n8n to list my workflows", []);
  assert.ok(n8n.toolNames.has("n8n__tool_0") && !n8n.toolNames.has("github__search") && !n8n.toolNames.has("bot_manage"));
  assert.equal([...n8n.toolNames].filter((n) => n.startsWith("n8n__")).length, 40);
  const open = computeFocus([...all, mk("computer"), mk("app"), mk("screen")], "open the github link in safari", []);
  assert.ok(open.toolNames.has("computer") && open.toolNames.has("app") && !open.toolNames.has("bot_manage"));
  assert.ok(!computeFocus([...all, mk("computer")], "Hello, how are you?", []).toolNames.has("computer"));
  const conn = computeFocus(all, "connect Linear", []);
  assert.ok(conn.toolNames.has("mcp_connect") && conn.groups.has("connect"));
  const mid = computeFocus(all, "ok", [["bot_manage"], ["mind_query"]]);
  assert.ok(mid.toolNames.has("bot_manage"), "a tool used in the last 3 rounds stays");
  const gone = computeFocus(all, "ok", [["bot_manage"], ["mind_query"], ["mind_query"], ["mind_query"]]);
  assert.ok(!gone.toolNames.has("bot_manage"));
});

test("capBoot gives each section a share and says what it cut", () => {
  const c = capBoot("## SOUL\n" + "s".repeat(1000) + "\n\n## RULES\n" + "r\n".repeat(20_000));
  assert.ok(c.truncated && c.text.length <= 6_200, `len ${c.text.length}`);
  assert.match(c.text, /## SOUL\ns{1000}/);
  assert.match(c.text, /digest/);
});

test("mistakeBriefFor: at most 3, only matching, none on trivial", () => {
  const dir = mistakeDir();
  assert.equal(mistakeBriefFor(dir, "Hello, how are you?"), "");
  assert.equal(mistakeBriefFor(dir, "plan my holiday in spain"), "");
  const b = mistakeBriefFor(dir, "tell me what is on the task board and say when it is done, with a receipt");
  assert.match(b, /Wrong board count/);
  assert.ok((b.match(/^\d\. /gm) ?? []).length <= 3);
});

// ---------------------------------------------------------------- learned recall
import { rank, buildNote } from "../../src/learn/recall.ts";
import { DEFAULTS } from "../../src/learn/config.ts";

const lesson = (key: string, trigger: string, rule: string): any => ({
  type: "lesson", key, rev: 1, kind: "behavior", status: "active", title: "Lesson - Behavior - Test", trigger, behavior: "Test", rule, evidence: [], created: "2026-11-01", updated: "2026-11-01", uses: 0, helped: 0, hurt: 0,
});
const LCFG = { enabled: true, user: "anthony", ...DEFAULTS };

test("learned recall needs two shared terms (the one-word rule is gone) and the user model only rides along when it matches", () => {
  const agentSessions = lesson("a1b2c3", "agent sessions", "Check agent sessions first.");
  assert.equal(rank("sessions", [agentSessions], LCFG).length, 0, "one shared word of a short message is not enough");
  assert.equal(rank("hello sessions", [agentSessions], LCFG).length, 0);
  assert.equal(rank("show the agent sessions list", [agentSessions], LCFG).length, 1, "two shared stems is");
  const um: any = { user: "anthony", prefs: [{ area: "register", statement: "caveman-short replies" }, { area: "email", statement: "plain-text prose emails" }] };
  const none = buildNote({ message: "open the github link in safari", items: [], userModel: um, cfg: LCFG });
  assert.equal(none.note, undefined, "an unrelated message gets no user model");
  const some = buildNote({ message: "draft an email to bob", items: [], userModel: um, cfg: LCFG });
  assert.match(some.note ?? "", /plain-text prose emails/);
  assert.doesNotMatch(some.note ?? "", /caveman/);
});
