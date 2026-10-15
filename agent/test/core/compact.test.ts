// Context compaction: older turns -> one summary note; last 8 turns and all receipt lines kept; never fails the chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SUMMARY_TAG, clipToolOutputs, compactMessages, estimateTokens, needsCompaction, receiptLines } from "../../src/compact.ts";
import { createAgentSession } from "../../src/loop.ts";
import type { Message, Provider, StreamEvent } from "../../src/types.ts";
import { FakeKernel, FakeSync, baseCfg, collect, usage } from "./helpers.ts";

function convo(turns: number, pad = ""): Message[] {
  const m: Message[] = [{ role: "system", content: "SYS" }];
  for (let i = 1; i <= turns; i++) {
    m.push({ role: "user", content: `question ${i} ${pad}` });
    m.push({ role: "assistant", content: `MIND✓ #c${i} asked thing ${i} -> got ${i}\nanswer ${i} ${pad}` });
  }
  return m;
}

function summarizer(text: string | (() => never)) {
  const seen: { model: string; tools: number; messages: Message[] }[] = [];
  const p: Provider = {
    name: "sum",
    async *stream(req): AsyncIterable<StreamEvent> {
      seen.push({ model: req.model, tools: req.tools.length, messages: req.messages });
      if (typeof text === "function") text();
      else yield { type: "text", delta: text as string };
      yield { type: "done", usage: usage(0.002), finishReason: "stop" };
    },
  };
  return { p, seen };
}

test("estimateTokens is chars/4 and needsCompaction uses the ratio", () => {
  const m = convo(2, "x".repeat(400));
  assert.ok(estimateTokens(m) > 200);
  assert.equal(needsCompaction(m, 100_000, 0.6), false);
  assert.equal(needsCompaction(m, 300, 0.6), true);
});

test("keeps the last 8 turns verbatim, summarizes the rest with the cheap model, no tools offered", async () => {
  const { p, seen } = summarizer("The user asked ten things; all were answered.");
  const msgs = convo(12);
  const r = await compactMessages(msgs, { provider: p, model: "m/cheap" });
  assert.ok(r);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, "m/cheap");
  assert.equal(seen[0].tools, 0);
  assert.equal(r!.messages[0].content, "SYS");
  assert.equal(r!.messages[1].role, "system");
  assert.ok(r!.messages[1].content.startsWith(SUMMARY_TAG));
  assert.ok(r!.messages[1].content.includes("The user asked ten things"));
  const tail = r!.messages.slice(2);
  assert.equal(tail.filter((m) => m.role === "user").length, 8);
  assert.deepEqual(tail, msgs.slice(-16));
  assert.equal(r!.compacted, 8);
  assert.equal(r!.mechanical, false);
});

test("every receipt line of the compacted turns survives word for word", async () => {
  const { p } = summarizer("summary");
  const r = await compactMessages(convo(12), { provider: p, model: "c" });
  const note = r!.messages[1].content;
  for (let i = 1; i <= 4; i++) assert.ok(note.includes(`MIND✓ #c${i} asked thing ${i} -> got ${i}`), `receipt ${i} kept`);
  assert.ok(receiptLines(r!.messages).length >= 4);
});

test("a second compaction keeps the receipts the first one carried", async () => {
  const { p } = summarizer("s2");
  const first = await compactMessages(convo(12), { provider: p, model: "c" });
  const grown = [...first!.messages];
  for (let i = 13; i <= 24; i++) grown.push({ role: "user", content: `question ${i}` }, { role: "assistant", content: `MIND✓ #c${i} t -> r\nanswer` });
  const second = await compactMessages(grown, { provider: p, model: "c" });
  const note = second!.messages[1].content;
  assert.ok(note.includes("MIND✓ #c1 asked thing 1 -> got 1"));
  assert.ok(note.includes("MIND✓ #c13 t -> r"));
  assert.equal(second!.messages.filter((m) => m.content.startsWith(SUMMARY_TAG)).length, 1, "one summary note, not a pile");
});

test("nothing to compact when there are 8 turns or fewer", async () => {
  const { p, seen } = summarizer("x");
  assert.equal(await compactMessages(convo(8), { provider: p, model: "c" }), undefined);
  assert.equal(seen.length, 0);
});

test("tool-call/result pairs are never split (cut lands on a user message)", async () => {
  const { p } = summarizer("s");
  const m: Message[] = [{ role: "system", content: "SYS" }];
  for (let i = 1; i <= 10; i++) {
    m.push({ role: "user", content: `q${i}` });
    m.push({ role: "assistant", content: "", toolCalls: [{ id: `t${i}`, name: "mind_query", args: {} }] });
    m.push({ role: "tool", toolCallId: `t${i}`, name: "mind_query", content: `[#c${i} mind_query] out` });
    m.push({ role: "assistant", content: `a${i}` });
  }
  const r = await compactMessages(m, { provider: p, model: "c" });
  const tail = r!.messages.slice(2);
  assert.equal(tail[0].role, "user");
  for (const x of tail) if (x.role === "tool") assert.ok(tail.some((a) => a.toolCalls?.some((c) => c.id === x.toolCallId)));
});

test("if the summary model fails, a plain digest is used and the chat does not fail", async () => {
  const { p } = summarizer(() => { throw new Error("502 upstream"); });
  const r = await compactMessages(convo(12), { provider: p, model: "c" });
  assert.equal(r!.mechanical, true);
  assert.ok(r!.messages[1].content.includes("question 1"));
  assert.ok(r!.messages[1].content.includes("MIND✓ #c1 asked thing 1 -> got 1"));
});

test("clipToolOutputs clips old oversized tool results only", () => {
  const m: Message[] = [{ role: "system", content: "S" }, { role: "tool", toolCallId: "a", content: "x".repeat(9000) }];
  for (let i = 0; i < 8; i++) m.push({ role: "user", content: "u" });
  m.push({ role: "tool", toolCallId: "b", content: "y".repeat(9000) });
  assert.equal(clipToolOutputs(m, 4000, 6), 1);
  assert.ok(m[1].content.length < 4100);
  assert.equal(m.at(-1)!.content.length, 9000, "the newest messages are protected");
});

test("loop: past the threshold the session compacts, tells the user, and keeps answering", async () => {
  const requests: { model: string; tools: number }[] = [];
  const provider: Provider = {
    name: "p",
    async *stream(req): AsyncIterable<StreamEvent> {
      requests.push({ model: req.model, tools: req.tools.length });
      yield { type: "text", delta: req.model === "m/cheap" ? "SUMMARY OF OLD TURNS" : "ok" };
      yield { type: "done", usage: usage(0.001), finishReason: "stop" };
    },
  };
  const session = createAgentSession({
    id: "s", surface: "web", provider, kernel: new FakeKernel(), tools: [], sync: new FakeSync(),
    cfg: baseCfg({ contextWindow: 1000, compactAt: 0.6 }), cwd: process.cwd(), systemPrompt: "SYS", bootContext: "",
  });
  const pad = "z".repeat(300);
  let notices = 0;
  for (let i = 0; i < 12; i++) {
    const ev = await collect(session.send(`message ${i} ${pad}`));
    notices += ev.filter((e) => e.type === "notice" && /Compacted/.test((e as any).text)).length;
    assert.ok((ev.at(-1) as any).finalText.length > 0, "every turn still answers");
  }
  assert.ok(notices >= 1, "user was told about compaction");
  assert.ok(requests.some((r) => r.model === "m/cheap"), "the cheap model summarized");
  const state = session.exportState!();
  assert.ok(state.messages.some((m) => m.role === "system" && m.content.startsWith(SUMMARY_TAG)));
  assert.ok(state.messages.filter((m) => m.role === "user").length <= 9, "history stays bounded");
});
