// Regression (2026-10-20, daedalus_e4d8e2): a paid turn was billed and the user got an EMPTY reply because the owner gate
// refused a write and the model then said nothing. A refused write must refuse only that write, never blank the reply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession, emptyReplyFallback } from "../../src/loop.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { OWNER_FAIL } from "../../src/kernel/owner.ts";
import { visibleText } from "../../src/events.ts";
import { FakeProvider, FakeSync, baseCfg, call, collect, fakeTool } from "./helpers.ts";

function rig(rounds: ConstructorParameters<typeof FakeProvider>[0]) {
  const write = fakeTool("mind_remember", "write", "saved", "mind");
  const provider = new FakeProvider(rounds);
  const session = createAgentSession({
    id: "s1", surface: "headless", provider, kernel: createKernel({ shadow: false, enabled: true }), tools: [write], sync: new FakeSync(),
    cfg: baseCfg(), cwd: process.cwd(), systemPrompt: "SYS", bootContext: "BOOT",
  });
  return { write, provider, session };
}

// The model parrots the literal template as its owner_check (what the old tool description and failure text invited).
const PARROT = "<material> belongs to <entity A>; pat asked about <entity B>; A == B";

test("owner gate refuses the write, the model goes silent: the user still gets a plain, non-empty reply", async () => {
  const { write, session } = rig([
    { calls: [call("a", "mind_remember", { type: "entry", title: "t", content: "c", owner_check: PARROT })] },
    { text: "" },
  ]);
  const ev = await collect(session.send("remember that I like tea"));
  assert.equal(write.calls.length, 0, "the refused write must not run");
  const gate = ev.find((e) => e.type === "gate") as any;
  assert.equal(gate.verdict.gate, "owner");
  const done = ev.at(-1) as any;
  assert.equal(done.type, "done");
  assert.ok(done.finalText.trim().length > 0, "finalText must not be blank");
  assert.match(done.finalText, /ownership check did not pass/);
  assert.match(visibleText(ev), /nothing was written/);
});

test("owner gate refuses one write; the model's own plain reply is kept and no fallback is added", async () => {
  const { session } = rig([
    { calls: [call("a", "mind_remember", { type: "entry", title: "t", content: "c", owner_check: "nope" })] },
    { text: "I could not save that note. Whose notes are these?" },
  ]);
  const ev = await collect(session.send("remember that"));
  assert.equal((ev.at(-1) as any).finalText, "I could not save that note. Whose notes are these?");
});

test("a refused write can be retried with real names in the same turn", async () => {
  const { write, session } = rig([
    { calls: [call("a", "mind_remember", { type: "entry", title: "t", content: "c", owner_check: PARROT })] },
    { calls: [call("b", "mind_remember", { type: "entry", title: "t", content: "c", owner_check: "tea note belongs to Pat; pat asked about Pat; Pat == Pat" })] },
    { text: "Saved your note." },
  ]);
  const ev = await collect(session.send("remember that I like tea"));
  assert.equal(write.calls.length, 1);
  assert.equal((ev.at(-1) as any).finalText, "Saved your note.");
});

test("the failure text and the fallback carry no literal template placeholders a model could parrot", () => {
  assert.ok(!/<[^>]*>/.test(OWNER_FAIL), OWNER_FAIL);
  assert.ok(/^owner check failed/.test(OWNER_FAIL));
  assert.ok(emptyReplyFallback([]).trim().length > 0);
  assert.ok(!/<[^>]*>/.test(emptyReplyFallback([{ tool: "mind_remember", gate: "owner" }])));
});
