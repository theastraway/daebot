// Live token streaming with honest retraction (text streams as it arrives; a gate-withheld draft is retracted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession, UNVERIFIED_FOOTER } from "../../src/loop.ts";
import { HistoryRecorder, visibleText } from "../../src/events.ts";
import type { AgentEvent, GateVerdict, Provider, StreamEvent } from "../../src/types.ts";
import { FakeKernel, FakeSync, baseCfg, call, collect, fakeTool, usage } from "./helpers.ts";

const block = (gate: string, reason: string): GateVerdict => ({ gate, action: "block", reason });

// A provider that streams each round as several small deltas.
function chunkedProvider(rounds: { chunks?: string[]; calls?: ReturnType<typeof call>[] }[]): Provider & { requests: number } {
  let i = 0;
  const p = {
    name: "chunked",
    requests: 0,
    async *stream(): AsyncIterable<StreamEvent> {
      p.requests++;
      const r = rounds[Math.min(i++, rounds.length - 1)];
      for (const c of r.chunks ?? []) yield { type: "text", delta: c };
      for (const c of r.calls ?? []) yield { type: "toolCall", call: c };
      yield { type: "done", usage: usage(), finishReason: r.calls?.length ? "tool_calls" : "stop" };
    },
  };
  return p;
}

function make(provider: Provider, kernel = new FakeKernel(), over: Record<string, unknown> = {}) {
  const session = createAgentSession({
    id: "s1", surface: "web", provider, kernel, tools: [fakeTool("mind_query", "read", "ok", "mind")], sync: new FakeSync(),
    cfg: baseCfg(over as any), cwd: process.cwd(), systemPrompt: "SYS", bootContext: "BOOT",
  });
  return session;
}

test("deltas reach the client as they arrive, before the turn is over", async () => {
  const session = make(chunkedProvider([{ chunks: ["Hel", "lo ", "there"] }]));
  const seen: string[] = [];
  for await (const ev of session.send("hi")) seen.push(ev.type === "text" ? `t:${ev.delta}` : ev.type);
  assert.deepEqual(seen.slice(0, 3), ["t:Hel", "t:lo ", "t:there"]);
  assert.equal(seen.at(-1), "done");
  assert.ok(!seen.includes("retract"));
});

test("a blocked final draft streams, is retracted with the gate's reason, then the rewrite streams", async () => {
  const k = new FakeKernel();
  k.hooks.preAnswer = (_s, d) => (d.includes("BAD") ? [block("receipt", "cite a MIND✓ receipt")] : []);
  const ev = await collect(make(chunkedProvider([{ chunks: ["BA", "D claim"] }, { chunks: ["good ", "claim"] }]), k).send("q"));
  const kinds = ev.map((e) => e.type);
  assert.deepEqual(kinds.filter((t) => t !== "usage"), ["text", "text", "retract", "gate", "text", "text", "done"]);
  assert.equal((ev.find((e) => e.type === "retract") as any).reason, "cite a MIND✓ receipt");
  assert.equal(visibleText(ev), "good claim", "a retracted draft counts as not shown");
  assert.equal((ev.at(-1) as any).finalText, "good claim");
});

test("blocked narration beside a tool call is retracted too; the call still runs", async () => {
  const k = new FakeKernel();
  k.hooks.preAnswer = (_s, d) => (d.includes("andrew@ysf.org") ? [block("receipt", "no receipt for that email")] : []);
  const ev = await collect(make(chunkedProvider([
    { chunks: ["The contact is ", "andrew@ysf.org."], calls: [call("c1", "mind_query", {})] },
    { chunks: ["Looked it up."] },
  ]), k).send("who"));
  const kinds = ev.map((e) => e.type);
  assert.ok(kinds.indexOf("retract") > kinds.lastIndexOf("text", kinds.indexOf("retract")), "retract after the streamed narration");
  assert.ok(kinds.indexOf("retract") < kinds.indexOf("toolStart"), "retract before the tool runs");
  assert.ok(ev.some((e) => e.type === "toolEnd" && (e as any).ok));
  assert.ok(!visibleText(ev).includes("andrew@ysf.org"));
  assert.ok(visibleText(ev).includes("Looked it up."));
});

test("shadow mode never retracts: the gate event is logged and the text stays", async () => {
  const k = new FakeKernel();
  k.hooks.preAnswer = () => [block("receipt", "needs receipt")];
  const ev = await collect(make(chunkedProvider([{ chunks: ["claim"] }]), k, { shadow: true }).send("q"));
  assert.ok(!ev.some((e) => e.type === "retract"));
  assert.equal(visibleText(ev), "claim");
  assert.ok(ev.some((e) => e.type === "gate" && (e as any).enforced === false));
});

test("out of regenerations: the draft is retracted, then the whole answer ships marked unverified", async () => {
  const k = new FakeKernel();
  k.hooks.preAnswer = () => [block("receipt", "needs receipt")];
  const ev = await collect(make(chunkedProvider([{ chunks: ["claim"] }]), k).send("q"));
  assert.equal(ev.filter((e) => e.type === "retract").length, 3);
  const vis = visibleText(ev);
  assert.ok(vis.startsWith("claim") && vis.endsWith(UNVERIFIED_FOOTER), vis);
});

test("usage events carry the model that answered", async () => {
  const ev = await collect(make(chunkedProvider([{ chunks: ["x"] }])).send("q"));
  assert.equal((ev.find((e) => e.type === "usage") as any).model, "m/default");
});

test("visibleText: usage and notices do not end a block; tool boundaries do", () => {
  const evs: AgentEvent[] = [
    { type: "text", delta: "a" }, { type: "usage", usage: usage(), totalCostUsd: 0 }, { type: "text", delta: "b" }, { type: "retract", reason: "r" },
    { type: "text", delta: "c" }, { type: "toolStart", receiptId: "c1", tool: "t", args: {} }, { type: "text", delta: "d" }, { type: "done", finalText: "" },
  ];
  assert.equal(visibleText(evs), "c\nd");
});

test("HistoryRecorder coalesces deltas, keeps user messages and caps its size", () => {
  const r = new HistoryRecorder([], 5);
  r.user("hi");
  r.push({ type: "text", delta: "he" }); r.push({ type: "text", delta: "llo" });
  r.push({ type: "retract", reason: "x" });
  assert.deepEqual(r.events(), [{ type: "user", text: "hi" }, { type: "text", delta: "hello" }, { type: "retract", reason: "x" }]);
  for (let i = 0; i < 10; i++) r.push({ type: "notice", level: "info", text: String(i) });
  assert.equal(r.events().length, 5);
});
