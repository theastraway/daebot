// The inner voice: think blocks and reasoning deltas become "thinking" stream events; the answer text never contains them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ThinkFilter } from "../../src/provider/think-filter.ts";
import { createOpenRouterProvider } from "../../src/provider/openrouter.ts";
import type { StreamEvent } from "../../src/types.ts";
import { baseCfg } from "../core/helpers.ts";

test("ThinkFilter hands the inside of a think block to onThink, split tags included, and keeps the answer clean", () => {
  const thoughts: string[] = [];
  const f = new ThinkFilter((d) => thoughts.push(d));
  let out = f.push("<thi");
  out += f.push("nk>I should check the file first.</th");
  out += f.push("ink>Here is the answer.");
  out += f.flush();
  assert.equal(out, "Here is the answer.");
  assert.equal(thoughts.join(""), "I should check the file first.");
  const g = new ThinkFilter((d) => thoughts.push(d));
  assert.equal(g.push("<think>unfinished"), "");
  assert.equal(g.flush(), "");
  assert.ok(thoughts.join("").includes("unfinished"));
  assert.equal(new ThinkFilter().push("<think>dropped</think>kept"), "kept", "without a listener the block is simply dropped");
});

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("openrouter: reasoning deltas and <think> blocks stream as thinking events; effort is sent as reasoning.effort", async () => {
  let sent: any;
  const fetchImpl = (async (_u: string, init: any) => {
    sent = JSON.parse(init.body);
    return sse([
      { choices: [{ delta: { reasoning: "Let me think. " } }] },
      { choices: [{ delta: { reasoning_content: "The user wants X." } }] },
      { choices: [{ delta: { content: "<think>inner</think>Answer " } }] },
      { choices: [{ delta: { content: "done." }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0.001 } },
    ]);
  }) as unknown as typeof fetch;
  const p = createOpenRouterProvider(baseCfg(), fetchImpl);
  const events: StreamEvent[] = [];
  for await (const ev of p.stream({ model: "m/default", messages: [{ role: "user", content: "hi" }], tools: [], effort: "high" })) events.push(ev);
  assert.equal(sent.reasoning.effort, "high");
  const thinking = events.filter((e) => e.type === "thinking").map((e) => (e as any).delta).join("");
  const text = events.filter((e) => e.type === "text").map((e) => (e as any).delta).join("");
  assert.equal(thinking, "Let me think. The user wants X.inner");
  assert.equal(text, "Answer done.");
  const noEffort = createOpenRouterProvider(baseCfg(), (async (_u: string, init: any) => { sent = JSON.parse(init.body); return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]); }) as unknown as typeof fetch);
  for await (const _ of noEffort.stream({ model: "m/default", messages: [], tools: [] })) { /* drain */ }
  assert.equal("reasoning" in sent, false);
});
