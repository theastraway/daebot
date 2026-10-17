import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecideTool, DECISION_MODELS, DECISIONS_URL } from "../../src/tools/decide.ts";
import { createBuiltinTools } from "../../src/tools/index.ts";
import { createMindClient, createMindTools } from "../../src/mind/index.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { tierAllows } from "../../src/kernel/tier.ts";
import { hostedToolAllowed } from "../../src/hosted.ts";
import { composeSystemPrompt } from "../../src/runtime.ts";
import { createAgentSession } from "../../src/loop.ts";
import { cfg as mindCfg, fakeFetch, json } from "../mind/helpers.ts";
import { FakeProvider, FakeSync, baseCfg, call as scriptedCall, collect } from "./helpers.ts";
import { call, state } from "../kernel/helpers.ts";

const KEY = "sk-or-v1-SECRETSECRETSECRET0123456789";
const ctx = { cwd: "/", sessionId: "s" };
const OPTIONS = { ship: "ship it now", wait: "wait a week", cancel: "drop the feature" };
const answer = (choice: string, over: Record<string, unknown> = {}) => ({
  model: "typesafe/jev-1.13-20260917",
  answers: { decision: { type: "choice", choice, probabilities: { ship: 0.7, wait: 0.2, cancel: 0.1 }, confidence: 0.7 } },
  usage: { input_tokens: 300, output_tokens: 30, cost: 0.00002 },
  ...over,
});

function make(handler: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(handler);
  return { tool: createDecideTool({ fetchImpl: f.fetch, apiKey: KEY }), seen: f.seen };
}

test("decide: request shape is the verified decisions API call", async () => {
  const { tool, seen } = make(() => json(200, answer("ship")));
  const r = await tool.run({ question: "Ship the release today?", options: OPTIONS, context: { users: 40, deadline: "friday" } }, ctx);
  assert.ok(r.ok, r.output);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, DECISIONS_URL);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(seen[0].body, {
    model: "typesafe/jev-1.13",
    state: { users: 40, deadline: "friday" },
    questions: { decision: { type: "choice", instructions: "Ship the release today?", criteria: OPTIONS } },
  });
});

test("decide: parses choice, probabilities, confidence and reports cost in meta", async () => {
  const { tool } = make(() => json(200, answer("ship")));
  const r = await tool.run({ question: "q", options: OPTIONS }, ctx);
  assert.ok(r.ok);
  assert.match(r.output, /choice: ship/);
  assert.match(r.output, /confidence: 70%/);
  assert.match(r.output, /ship: 70%/);
  assert.match(r.output, /Advice only/);
  assert.equal(r.meta?.choice, "ship");
  assert.equal(r.meta?.confidence, 0.7);
  assert.equal(r.meta?.costUsd, 0.00002);
  assert.equal(r.meta?.fellBack, false);
  assert.ok(!r.output.includes(KEY));
});

test("decide: model decider is requested first, jev is its fallback", async () => {
  const { tool, seen } = make((req) => (req.body.model === DECISION_MODELS.decider ? { status: 404, json: { error: { message: "No endpoints found" } } } : json(200, answer("wait"))));
  const r = await tool.run({ question: "q", options: OPTIONS, model: "decider" }, ctx);
  assert.ok(r.ok);
  assert.deepEqual(seen.map((s) => s.body.model), [DECISION_MODELS.decider, DECISION_MODELS.jev]);
  assert.equal(r.meta?.fellBack, true);
});

test("decide: jev failure falls back to the decider and says so", async () => {
  const { tool, seen } = make((req) => (req.body.model === DECISION_MODELS.jev ? { status: 502, text: "bad gateway" } : json(200, answer("cancel", { model: "perplexity/pplx-decider-v1.1-27b" }))));
  const r = await tool.run({ question: "q", options: OPTIONS }, ctx);
  assert.ok(r.ok);
  assert.deepEqual(seen.map((s) => s.body.model), [DECISION_MODELS.jev, DECISION_MODELS.decider]);
  assert.match(r.output, /choice: cancel/);
  assert.match(r.output, /fallback after jev: HTTP 502/);
  assert.equal(r.meta?.fellBack, true);
});

test("decide: both models failing surfaces a clean one-line error and never the key", async () => {
  const { tool } = make(() => ({ status: 401, json: { error: { message: `Invalid key ${KEY}` } } }));
  const r = await tool.run({ question: "q", options: OPTIONS }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /could not get a decision/);
  assert.match(r.output, /jev: HTTP 401/);
  assert.match(r.output, /decider: HTTP 401/);
  assert.ok(!r.output.includes(KEY) && !r.output.includes("SECRETSECRET"));
  assert.ok(!r.output.includes("\n"));
});

test("decide: a malformed answer (choice not among the options, or no choice) is a failure, not a guess", async () => {
  const { tool } = make(() => json(200, answer("burn-it-down")));
  const r = await tool.run({ question: "q", options: OPTIONS }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /not one of the options/);
  const none = make(() => json(200, { answers: {} }));
  assert.equal((await none.tool.run({ question: "q", options: OPTIONS }, ctx)).ok, false);
});

test("decide: input validation happens before any network call", async () => {
  const { tool, seen } = make(() => json(200, answer("ship")));
  assert.equal((await tool.run({ options: OPTIONS }, ctx)).ok, false);
  assert.match((await tool.run({ question: "q", options: { only: "one" } }, ctx)).output, /at least 2 options/);
  assert.match((await tool.run({ question: "q", options: { a: "x", b: "" } }, ctx)).output, /non-empty definition/);
  assert.match((await tool.run({ question: "q", options: ["a", "b"] }, ctx)).output, /options must be an object/);
  assert.match((await tool.run({ question: "q", options: OPTIONS, model: "gpt" }, ctx)).output, /model must be/);
  assert.equal(seen.length, 0);
});

test("decide: no key configured is a clear failure with no request", async () => {
  const f = fakeFetch(() => json(200, answer("ship")));
  const tool = createDecideTool({ fetchImpl: f.fetch, apiKey: "" });
  const r = await tool.run({ question: "q", options: OPTIONS }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /no decision provider key/);
  assert.equal(f.seen.length, 0);
});

test("decide: a hung provider times out and falls through cleanly", async () => {
  const f = fakeFetch(() => "hang");
  const tool = createDecideTool({ fetchImpl: f.fetch, apiKey: KEY, timeoutMs: 20 });
  const r = await tool.run({ question: "q", options: OPTIONS }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /timed out/);
  assert.equal(f.seen.length, 2);
});

// ---------- kernel classification ----------
test("decide is a read-only tool: admin and staff may use it, public may not (it spends server money)", () => {
  const t = createDecideTool({ apiKey: KEY });
  assert.equal(t.class, "read");
  assert.equal(t.receipt, undefined); // a model's opinion is not evidence
  assert.equal(tierAllows("admin", t), true);
  assert.equal(tierAllows("staff", t), true);
  assert.equal(tierAllows("public", t), false);
  const adminKernel = createKernel({ shadow: false, enabled: true, tier: "admin" });
  assert.deepEqual(adminKernel.preTool(state(), call("decide", {}), t), []); // no confirmation: not outward, not irreversible
  const staffKernel = createKernel({ shadow: false, enabled: true, tier: "staff" });
  assert.deepEqual(staffKernel.preTool(state(), call("decide", {}), t), []);
  assert.deepEqual(staffKernel.allowedTools(state(), [t]).map((x) => x.spec.name), ["decide"]);
  const publicKernel = createKernel({ shadow: false, enabled: true, tier: "public" });
  assert.equal(publicKernel.allowedTools(state(), [t]).length, 0);
  assert.equal(publicKernel.preTool(state(), call("decide", {}), t)[0]?.action, "block");
});

test("decide runs on the hosted deployment; it is only built when a key exists", () => {
  assert.equal(hostedToolAllowed("decide"), true);
  assert.equal(hostedToolAllowed("decider"), false);
  assert.ok(!createBuiltinTools().some((t) => t.spec.name === "decide"));
  assert.ok(createBuiltinTools({ decisionKey: KEY }).some((t) => t.spec.name === "decide"));
  const hostedKernel = createKernel({ shadow: false, enabled: true, hosted: true });
  const t = createDecideTool({ apiKey: KEY });
  assert.deepEqual(hostedKernel.allowedTools(state(), [t]).map((x) => x.spec.name), ["decide"]);
});

// ---------- the turn's usage ----------
test("decide cost lands in the turn's usage events", async () => {
  const f = fakeFetch(() => json(200, answer("ship")));
  const tool = createDecideTool({ fetchImpl: f.fetch, apiKey: KEY });
  const provider = new FakeProvider([{ calls: [scriptedCall("a", "decide", { question: "q", options: OPTIONS })] }, { text: "ok" }]);
  const session = createAgentSession({
    id: "s1", surface: "headless", provider, kernel: createKernel({ shadow: false, enabled: true }), tools: [tool], sync: new FakeSync(),
    cfg: baseCfg(), cwd: process.cwd(), systemPrompt: "SYS", bootContext: "BOOT",
  });
  const ev = await collect(session.send("decide something"));
  const usages = ev.filter((e) => e.type === "usage") as any[];
  const decideUsage = usages.find((u) => u.usage.costUsd === 0.00002);
  assert.ok(decideUsage, "decide cost reported as a usage event");
  assert.equal(decideUsage.usage.promptTokens, 300);
  assert.equal(decideUsage.model, "typesafe/jev-1.13-20260917");
  assert.ok(usages.at(-1).totalCostUsd >= 0.00002);
});

// ---------- prompt ----------
test("system prompt carries the Decision Protocol", () => {
  const p = composeSystemPrompt({ bootContext: "", surface: "web", cwd: "/" });
  assert.match(p, /Decision Protocol/);
  for (const needle of [/Outcomes: 4 to 7, ranked/, /top one is the user's aim/, /at least 4/, /status quo/, /opposite/, /hybrid/, /long shot/, /hardest on the option you favour/, /call the decide tool/, /Mitigate/, /one decision sentence/, /named owner/, /mind_decision_record/, /Skip it for trivial, reversible/, /never overrides an explicit user instruction or a kernel gate/, /confidence plainly/]) {
    assert.match(p, needle);
  }
});

// ---------- mind_decision_record ----------
function recordSetup() {
  const f = fakeFetch(() => json(200, { id: "doc-9" }));
  const tools = createMindTools(createMindClient(mindCfg(), f.fetch, { retryDelayMs: 0 }));
  const tool = tools.find((t) => t.spec.name === "mind_decision_record")!;
  return { tool, seen: f.seen };
}

test("mind_decision_record: write class with owner_check required, allowed for staff, not public", () => {
  const { tool } = recordSetup();
  assert.ok(tool);
  assert.equal(tool.class, "write");
  assert.equal(tool.classFor?.({ subject: "x" }) ?? tool.class, "write");
  assert.ok((tool.spec.parameters as any).required.includes("owner_check"));
  assert.equal(tierAllows("staff", tool), true);
  assert.equal(tierAllows("public", tool), false);
});

test("mind_decision_record: kernel owner gate blocks a missing or mismatched owner_check", () => {
  const { tool } = recordSetup();
  const k = createKernel({ shadow: false, enabled: true });
  const args = { subject: "Pricing", decision: "Hold the price." };
  assert.equal(k.preTool(state(), call("mind_decision_record", args), tool)[0]?.gate, "owner");
  assert.equal(k.preTool(state(), call("mind_decision_record", { ...args, owner_check: "pricing belongs to Astra AI; Anthony asked about Atlas; A == B" }), tool)[0]?.gate, "owner");
  assert.deepEqual(k.preTool(state(), call("mind_decision_record", { ...args, owner_check: "pricing belongs to Astra AI; Anthony asked about Astra AI; A == B" }), tool), []);
});

test("mind_decision_record: files a PRIVATE document through the existing client path", async () => {
  const { tool, seen } = recordSetup();
  const r = await tool.run({
    owner_check: "decision belongs to Astra AI; Anthony asked about Astra AI; A == B",
    subject: "Ship v2 (now/later)",
    date: "2026-10-17",
    outcomes: ["Keep trust", "Revenue"],
    options: ["ship: now", "wait: a week"],
    decision: "Ship Friday with the flag off.",
    confidence: "70% (decide tool)",
    mitigations: ["Rollback is one env flip"],
    plan: ["Merge, owner Dae", "Verify live, owner Dae"],
  }, ctx);
  assert.ok(r.ok, r.output);
  assert.match(r.output, /saved document doc-9/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.match(seen[0].url, /\/developer\/v1\/documents$/); // the private documents route, not /thoughts (public feed)
  assert.ok(!("owner_check" in seen[0].body));
  const b = seen[0].body;
  assert.equal(b.type, undefined); // the type picks the route; nothing public
  assert.equal(b.title, "Decision - Ship v2 now later - 2026-10-17");
  assert.ok(!/[\/()]/.test(b.title) && !/[–—]/.test(b.title));
  assert.match(b.content, /## Decision\nShip Friday with the flag off\./);
  assert.match(b.content, /1\. Keep trust/);
  assert.match(b.content, /Rollback is one env flip/);
  assert.match(b.content, /2\. Verify live, owner Dae/);
  assert.deepEqual(b.tags, ["decision", "oocemr"]);
});

test("mind_decision_record: defaults the date to today and rejects an empty decision", async () => {
  const { tool, seen } = recordSetup();
  const owner = "decision belongs to Astra AI; Anthony asked about Astra AI; A == B";
  const bad = await tool.run({ owner_check: owner, subject: "S", decision: " " }, ctx);
  assert.equal(bad.ok, false);
  assert.equal(seen.length, 0);
  const ok = await tool.run({ owner_check: owner, subject: "Hiring plan", decision: "Hire one." }, ctx);
  assert.ok(ok.ok);
  assert.match(seen[0].body.title, /^Decision - Hiring plan - \d{4}-\d{2}-\d{2}$/);
});
