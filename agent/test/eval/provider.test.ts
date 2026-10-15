import { test } from "node:test";
import assert from "node:assert/strict";
import { ScriptedProvider, blockedSignal, fillTemplate, latestReceiptId } from "../../src/eval/provider.ts";
import type { Message, StreamEvent } from "../../src/types.ts";
import type { Step } from "../../src/eval/types.ts";

async function pull(p: ScriptedProvider, messages: Message[]): Promise<{ text: string; calls: { name: string; args: Record<string, unknown> }[] }> {
  let text = "";
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  for await (const ev of p.stream({ model: "m", messages, tools: [] }) as AsyncIterable<StreamEvent>) {
    if (ev.type === "text") text += ev.delta;
    if (ev.type === "toolCall") calls.push({ name: ev.call.name, args: ev.call.args });
  }
  return { text, calls };
}

const user: Message = { role: "user", content: "hi" };
const asst: Message = { role: "assistant", content: "x" };

test("scripted provider plays steps in order", async () => {
  const p = new ScriptedProvider();
  p.setTurn([{ calls: [{ name: "a", args: { k: 1 } }] }, { text: "final" }]);
  assert.deepEqual((await pull(p, [user])).calls, [{ name: "a", args: { k: 1 } }]);
  assert.equal((await pull(p, [user])).text, "final");
  assert.equal(p.requests, 2);
});

test("exhausted script repeats the last TEXT (stubborn) and never repeats tool calls", async () => {
  const p = new ScriptedProvider();
  p.setTurn([{ text: "claim", calls: [{ name: "a", args: {} }] }]);
  await pull(p, [user]);
  const again = await pull(p, [user]);
  assert.equal(again.text, "claim");
  assert.equal(again.calls.length, 0);
});

test("blockedSignal: tool block, not-executed, kernel nudge; but not stale ones before an assistant message", () => {
  assert.equal(blockedSignal([user, asst, { role: "tool", content: "blocked by boot: x", name: "t" }]), true);
  assert.equal(blockedSignal([user, asst, { role: "tool", content: "not executed: needs go", name: "t" }]), true);
  assert.equal(blockedSignal([user, asst, { role: "system", content: "[kernel:receipt] Your draft was withheld." }]), true);
  assert.equal(blockedSignal([user, asst, { role: "tool", content: "[#c1 t] fine", name: "t" }]), false);
  assert.equal(blockedSignal([{ role: "tool", content: "blocked by x", name: "t" }, asst, user]), false);
});

test("onBlocked alternates replace the remaining script when the previous output was refused", async () => {
  const p = new ScriptedProvider();
  const steps: Step[] = [
    { calls: [{ name: "bad", args: {} }], onBlocked: [{ calls: [{ name: "good", args: {} }] }, { text: "recovered" }] },
    { text: "never reached on the corrected path" },
  ];
  p.setTurn(steps);
  assert.equal((await pull(p, [user])).calls[0].name, "bad");
  const blocked: Message[] = [user, asst, { role: "tool", content: "blocked by feed: no", name: "bad" }];
  assert.equal((await pull(p, blocked)).calls[0].name, "good");
  assert.equal((await pull(p, [user, asst, { role: "tool", content: "[#c1 good] ok", name: "good" }])).text, "recovered");
  assert.equal(p.branches, 1);
});

test("without onBlocked the model is stubborn: continues with the main script", async () => {
  const p = new ScriptedProvider();
  p.setTurn([{ calls: [{ name: "bad", args: {} }] }, { text: "main next" }]);
  await pull(p, [user]);
  const r = await pull(p, [user, asst, { role: "tool", content: "blocked by x: y", name: "bad" }]);
  assert.equal(r.text, "main next");
  assert.equal(p.branches, 0);
});

test("withheld-draft nudge triggers the text step's onBlocked", async () => {
  const p = new ScriptedProvider();
  p.setTurn([{ text: "bad draft", onBlocked: [{ text: "good draft" }] }]);
  assert.equal((await pull(p, [user])).text, "bad draft");
  assert.equal((await pull(p, [user, asst, { role: "system", content: "[kernel:receipt] Your draft was withheld. x" }])).text, "good draft");
});

test("templates resolve the latest receipt id of a tool within the current turn only", () => {
  const msgs: Message[] = [
    { role: "tool", content: "[#c1 mind_query] old", name: "mind_query" },
    user,
    { role: "tool", content: "[#c4 mind_query] a", name: "mind_query" },
    { role: "tool", content: "[#c5 web_fetch] b", name: "web_fetch" },
    { role: "tool", content: "[#c6 mind_query] c", name: "mind_query" },
  ];
  assert.equal(latestReceiptId(msgs, "mind_query"), "c6");
  assert.equal(latestReceiptId(msgs, "web_fetch"), "c5");
  assert.equal(latestReceiptId(msgs, "bash"), "c?");
  assert.equal(latestReceiptId([{ role: "tool", content: "[#c1 mind_query] old", name: "mind_query" }, user], "mind_query"), "c?");
  assert.equal(fillTemplate("MIND✓ #{{id:mind_query}} x", msgs), "MIND✓ #c6 x");
});

test("template ids also fill inside tool-call args", async () => {
  const p = new ScriptedProvider();
  p.setTurn([{ calls: [{ name: "t", args: { ref: "{{id:mind_query}}", nested: { r: ["{{id:mind_query}}"] } } }] }]);
  const r = await pull(p, [user, { role: "tool", content: "[#c2 mind_query] a", name: "mind_query" }]);
  assert.deepEqual(r.calls[0].args, { ref: "c2", nested: { r: ["c2"] } });
});
