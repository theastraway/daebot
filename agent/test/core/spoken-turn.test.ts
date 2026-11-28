import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession, SPOKEN_TOOL_ROUNDS } from "../../src/loop.ts";
import { baseCfg, call, FakeKernel, FakeProvider, FakeSync, fakeTool } from "./helpers.ts";

async function run(caps: string[]) {
  // The model keeps searching; it would go on for every round it is offered tools.
  const rounds = Array.from({ length: 8 }, (_, i) => ({ calls: [call(`c${i}`, "mind_query", { query: `q${i}` })] }));
  const provider = new FakeProvider([...rounds, { text: "Two things need you: the Ilyven tiers and Andrew's reply." }]);
  // A real model can still emit a call when offered none; the loop must drop it. Script: always a call, plus answer text when offered no tools.
  const inner = provider.stream.bind(provider);
  provider.stream = async function* (req: any) {
    if (!req.tools.length) { provider.requests.push(req); yield { type: "text", delta: "Two things need you: the Ilyven tiers and Andrew's reply." }; yield { type: "toolCall", call: call("x", "mind_query", {}) }; yield { type: "done", usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 }, finishReason: "tool_calls" }; return; }
    yield* inner(req);
  } as any;
  const tool = fakeTool("mind_query", "read", "result", "mind");
  const s = createAgentSession({ id: "s1", surface: "web", provider, kernel: new FakeKernel() as any, tools: [tool], sync: new FakeSync(), cfg: baseCfg(), cwd: "/", systemPrompt: "SYS", bootContext: "booted" });
  const evs: any[] = [];
  for await (const ev of s.send("What's on my plate today?", { capabilities: caps } as any)) { evs.push(ev); if (ev.type === "done") break; }
  return { provider, tool, evs };
}

test(`a spoken turn gets ${SPOKEN_TOOL_ROUNDS} rounds of lookups, then must answer with no tools; typed turns are not capped`, async () => {
  const spoken = await run(["spoken"]);
  assert.equal(spoken.tool.calls.length, SPOKEN_TOOL_ROUNDS);
  const last = spoken.provider.requests.at(-1)!;
  assert.deepEqual(last.tools, [], "no tools on the forced answer");
  assert.match(String(last.messages.at(-1)!.content), /Voice call: the user is waiting\. Answer now/);
  const done = spoken.evs.find((e) => e.type === "done");
  assert.ok(done.finalText.length > 0);
  const typed = await run([]);
  assert.ok(typed.tool.calls.length > SPOKEN_TOOL_ROUNDS, "typed turns keep their tools");
});
