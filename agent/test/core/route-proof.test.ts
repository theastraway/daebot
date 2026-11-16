// The loop: one route event per human turn (shadow keeps the configured model; enforce picks the router's), a proof event at the
// end of every human turn, thinking events forwarded and never part of the answer or the transcript the model sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession } from "../../src/loop.ts";
import type { AgentEvent, RouteDecision, StreamEvent, Tool } from "../../src/types.ts";
import { FakeKernel, FakeProvider, FakeSync, baseCfg, collect } from "./helpers.ts";

const okTool: Tool = { spec: { name: "echo", description: "", parameters: { type: "object", properties: {} } }, class: "read", async run() { return { ok: true, output: "hi" }; } };
const badTool: Tool = { spec: { name: "boom", description: "", parameters: { type: "object", properties: {} } }, class: "read", async run() { return { ok: false, output: "failed: nope" }; } };

function session(o: { router?: (i: any) => RouteDecision | undefined; provider: FakeProvider; tools?: Tool[] }) {
  return createAgentSession({ id: "s1", surface: "web", provider: o.provider, kernel: new FakeKernel(), tools: o.tools ?? [okTool, badTool], sync: new FakeSync(), cfg: baseCfg(), cwd: "/", systemPrompt: "sys", bootContext: "", router: o.router } as any);
}

test("shadow route: a route event with applied=false, the configured model runs, and the proof carries the decision", async () => {
  const provider = new FakeProvider([{ text: "answer" }]);
  const decision: RouteDecision = { tier: "coder", model: "x/coder", reason: "small fix", source: "rules", applied: false };
  const inputs: any[] = [];
  const s = session({ provider, router: (i) => { inputs.push(i); return decision; } });
  const events = await collect(s.send("fix the typo"));
  const route = events.find((e) => e.type === "route") as Extract<AgentEvent, { type: "route" }>;
  assert.deepEqual(route.decision, decision);
  assert.equal(provider.requests[0].model, "m/default", "shadow: the configured model still runs");
  const proof = events.find((e) => e.type === "proof") as Extract<AgentEvent, { type: "proof" }>;
  assert.equal(proof.proof.model, "m/default");
  assert.equal(proof.proof.tier, "coder");
  assert.match(proof.proof.route!, /^shadow: coder/);
  assert.equal(proof.proof.verified, true);
  assert.equal(inputs[0].message, "fix the typo");
  assert.equal(inputs[0].digest, undefined, "first turn: no digest yet");
  assert.equal(inputs[0].hasPhoto, false);
});

test("enforced route picks the model for the turn; the next turn's digest reflects failed calls; a bot turn is never routed", async () => {
  const provider = new FakeProvider([{ calls: [{ id: "1", name: "boom", args: {} }] }, { text: "done" }, { text: "again" }]);
  const decisions: RouteDecision[] = [{ tier: "reasoner", model: "x/reasoner", effort: "high", reason: "debug", source: "rules", applied: true }];
  const inputs: any[] = [];
  const s = session({ provider, router: (i) => { inputs.push(i); return decisions[0]; } });
  const e1 = await collect(s.send("why is it broken"));
  assert.equal(provider.requests[0].model, "x/reasoner");
  const proof = e1.find((e) => e.type === "proof") as Extract<AgentEvent, { type: "proof" }>;
  assert.equal(proof.proof.failed, 1);
  assert.equal(proof.proof.calls, 1);
  assert.equal(proof.proof.effort, "high");
  await collect(s.send("try again"));
  assert.equal(inputs[1].digest.failedCalls, 1);
  assert.equal(inputs[1].digest.badStreak, 1);
  const before = inputs.length;
  const e3 = await collect(s.send("[message from bot]", { origin: "bot" }));
  assert.equal(inputs.length, before, "a peer turn is not routed");
  assert.ok(!e3.some((e) => e.type === "route") && !e3.some((e) => e.type === "proof"));
});

test("thinking events pass through to the client and never into the answer or the model-facing transcript", async () => {
  class Thinker extends FakeProvider {
    async *stream(req: any): AsyncIterable<StreamEvent> {
      this.requests.push({ model: req.model, messages: req.messages, tools: req.tools });
      yield { type: "thinking", delta: "hmm, " };
      yield { type: "thinking", delta: "let me see" };
      yield { type: "text", delta: "the answer" };
      yield { type: "done", usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 }, finishReason: "stop" };
    }
  }
  const provider = new Thinker([]);
  const s = session({ provider });
  const events = await collect(s.send("question"));
  assert.deepEqual(events.filter((e) => e.type === "thinking").map((e: any) => e.delta), ["hmm, ", "let me see"]);
  const done = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
  assert.equal(done.finalText, "the answer");
  const st = s.exportState!();
  assert.ok(!st.messages.some((m) => m.content.includes("let me see")));
});

test("consult before done: a reasoner-tier build that never asked the advisor gets the footer and consult=skipped; one that did gets consult=ok; small asks and bot turns are untouched", async () => {
  const advisor: Tool = { spec: { name: "advisor", description: "", parameters: { type: "object", properties: {} } }, class: "read", async run() { return { ok: true, output: "advice" }; } };
  const reasoner: RouteDecision = { tier: "reasoner", model: "x/reasoner", reason: "standard build", source: "rules", applied: false };
  const mk = (provider: FakeProvider, decision: RouteDecision) => createAgentSession({ id: "s1", surface: "web", provider, kernel: new FakeKernel(), tools: [okTool, advisor], sync: new FakeSync(), cfg: baseCfg(), cwd: "/", systemPrompt: "sys", bootContext: "", router: () => decision, consultBeforeDone: true } as any);
  const skipped = await collect(mk(new FakeProvider([{ text: "done, shipped" }]), reasoner).send("build the whole thing"));
  const p1 = skipped.find((e) => e.type === "proof") as Extract<AgentEvent, { type: "proof" }>;
  assert.equal(p1.proof.consult, "skipped");
  assert.equal(p1.proof.advised, undefined);
  const done1 = skipped.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
  assert.match(done1.finalText, /\[advisor: not consulted before done\]$/);
  assert.ok(skipped.some((e) => e.type === "text" && e.delta.includes("[advisor: not consulted before done]")), "the footer streams to the client too");
  const ok = await collect(mk(new FakeProvider([{ calls: [{ id: "1", name: "advisor", args: {} }] }, { text: "done after advice" }]), reasoner).send("build the whole thing"));
  const p2 = ok.find((e) => e.type === "proof") as Extract<AgentEvent, { type: "proof" }>;
  assert.equal(p2.proof.consult, "ok");
  assert.equal(p2.proof.advised, true);
  assert.ok(!(ok.find((e) => e.type === "done") as any).finalText.includes("[advisor:"));
  const small = await collect(mk(new FakeProvider([{ text: "fixed" }]), { ...reasoner, tier: "coder" }).send("fix the typo"));
  const p3 = small.find((e) => e.type === "proof") as Extract<AgentEvent, { type: "proof" }>;
  assert.equal(p3.proof.consult, undefined);
  assert.ok(!(small.find((e) => e.type === "done") as any).finalText.includes("[advisor:"));
});
