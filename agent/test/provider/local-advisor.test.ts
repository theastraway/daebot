import { test } from "node:test";
import assert from "node:assert/strict";
import { createOllamaProvider, detectOllama, isLocalModel, localModelName, ollamaBase, pickLocalModel, withLocal } from "../../src/provider/local.ts";
import { TierBudget, classifyTurn, frontierBudgetUsd, nextDigest, routeTurn } from "../../src/provider/router.ts";
import { DEFAULT_POLICY } from "../../src/provider/policy.ts";
import { createAdvisorTool } from "../../src/tools/advisor.ts";
import type { Provider, StreamEvent } from "../../src/types.ts";
import { baseCfg } from "../core/helpers.ts";

test("local: base url, model ids, detection and the pick", async () => {
  assert.equal(ollamaBase({}), "http://127.0.0.1:11434");
  assert.equal(ollamaBase({ OLLAMA_HOST: "0.0.0.0:11434" }), "http://0.0.0.0:11434");
  assert.equal(localModelName("ollama/qwen3.8-flash-next:125b-mlx"), "qwen3.8-flash-next:125b-mlx");
  assert.equal(isLocalModel("qwen/qwen3.8-flash"), false);
  const up = (async () => new Response(JSON.stringify({ models: [{ name: "llama3:8b" }, { name: "qwen3.8-flash-next:125b-mlx" }] }), { status: 200 })) as unknown as typeof fetch;
  const r = await detectOllama({ fetchImpl: up });
  assert.deepEqual(r!.models, ["llama3:8b", "qwen3.8-flash-next:125b-mlx"]);
  assert.equal(pickLocalModel(r!.models, "ollama/qwen3.8-flash-next:125b-mlx"), "ollama/qwen3.8-flash-next:125b-mlx");
  assert.equal(pickLocalModel(r!.models), "ollama/llama3:8b");
  assert.equal(pickLocalModel([]), undefined);
  const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  assert.equal(await detectOllama({ fetchImpl: down }), undefined);
});

test("withLocal routes ollama/ models to the local provider with the prefix stripped; the rest go to the main one", async () => {
  const seen: string[] = [];
  let url = "";
  const main: Provider = { name: "main", async *stream(req): AsyncIterable<StreamEvent> { seen.push(`main:${req.model}`); yield { type: "done", usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 }, finishReason: "stop" }; } };
  let body: any;
  const f = (async (u: string, init: any) => { url = u; body = JSON.parse(init.body); return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", { status: 200 }); }) as unknown as typeof fetch;
  const p = withLocal(main, createOllamaProvider(baseCfg(), f, "http://127.0.0.1:11434"));
  for await (const _ of p.stream({ model: "ollama/llama3:8b", messages: [{ role: "user", content: "x" }], tools: [] })) { /* drain */ }
  assert.equal(url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(body.model, "llama3:8b");
  for await (const _ of p.stream({ model: "qwen/qwen3.8-flash", messages: [], tools: [] })) { /* drain */ }
  assert.deepEqual(seen, ["main:qwen/qwen3.8-flash"]);
});

test("router: a local model takes light work, a handoff hint is the floor, a spent frontier budget lowers the ceiling, a plan's go downshifts", () => {
  const light = routeTurn({ message: "what's the weather", mode: "enforce", localModel: "ollama/llama3:8b", policy: DEFAULT_POLICY })!;
  assert.equal(light.tier, "local");
  assert.equal(light.model, "ollama/llama3:8b");
  const big = routeTurn({ message: "build the billing subsystem end to end", canBuild: true, mode: "enforce", localModel: "ollama/llama3:8b", policy: DEFAULT_POLICY })!;
  assert.equal(big.tier, "frontier", "a local model never takes frontier work");
  const hinted = routeTurn({ message: "hi", mode: "enforce", hint: "coder", policy: DEFAULT_POLICY })!;
  assert.equal(hinted.tier, "coder");
  assert.match(hinted.reason, /handoff card/);
  const capped = routeTurn({ message: "build the billing subsystem end to end", canBuild: true, mode: "enforce", ceiling: "reasoner", ceilingReason: "the frontier budget for today ($5.00) is spent", policy: DEFAULT_POLICY })!;
  assert.equal(capped.tier, "reasoner");
  assert.match(capped.reason, /budget for today/);
  const d = nextDigest(undefined, { failedCalls: 0, blocks: 0, unverified: false, repeatHits: 0, lastTier: "frontier" });
  const go = classifyTurn({ message: "go ahead and build it", canBuild: true, digest: d });
  assert.equal(go.tier, "reasoner");
  assert.match(go.reason, /downshift/);
  const again = classifyTurn({ message: "build the billing subsystem end to end", canBuild: true, digest: d });
  assert.equal(again.tier, "frontier", "a new large ask is not an approval");
  const b = new TierBudget(1);
  b.add(0.6); assert.equal(b.exceeded(), false); b.add(0.5); assert.equal(b.exceeded(), true);
  assert.equal(new TierBudget(0).exceeded(), false, "0 = no budget");
  assert.equal(frontierBudgetUsd({}), 5);
  assert.equal(frontierBudgetUsd({ DAEBOT_FRONTIER_DAILY_USD: "2.5" }), 2.5);
});

test("advisor: calls the frontier model once, reports cost, redacts what it is told, and caps per session", async () => {
  let sent: any;
  const f = (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: "1. cause\n2. next step" } }], usage: { cost: 0.02, prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 }); }) as unknown as typeof fetch;
  const t = createAdvisorTool({ endpoint: () => ({ url: "https://x/llm", via: "openrouter", headers: () => ({}) }), model: () => ({ model: "anthropic/claude-fable-5.2", effort: "medium" }), fetchImpl: f, cap: { calls: 2, windowMs: 60_000 } });
  const ctx = { cwd: "/", sessionId: "s1" };
  const r = await t.run({ goal: "make the test pass", tried: "ran it, got sk-or-abcdefghijklmnop1234 in the log", question: "why" }, ctx);
  assert.equal(r.ok, true);
  assert.equal(sent.model, "anthropic/claude-fable-5.2");
  assert.equal(sent.reasoning.effort, "medium");
  assert.ok(!JSON.stringify(sent).includes("sk-or-abcdefghijklmnop1234"), "what the model is told is redacted");
  assert.equal(r.meta!.costUsd, 0.02);
  assert.match(r.output, /verify before you act/);
  await t.run({ goal: "g", tried: "t", question: "q" }, ctx);
  const third = await t.run({ goal: "g", tried: "t", question: "q" }, ctx);
  assert.equal(third.ok, false);
  assert.match(third.output, /2 calls/);
  assert.equal((await t.run({ goal: "", tried: "t", question: "q" }, ctx)).ok, false);
});
