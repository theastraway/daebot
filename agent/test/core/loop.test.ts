import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession, callSignature, UNVERIFIED_FOOTER } from "../../src/loop.ts";
import { createKernel } from "../../src/kernel/index.ts";
import type { AgentEvent, GateVerdict, TurnState } from "../../src/types.ts";
import { FakeKernel, FakeProvider, FakeSync, baseCfg, call, collect, fakeTool } from "./helpers.ts";

function make(opts: {
  rounds: ConstructorParameters<typeof FakeProvider>[0];
  tools?: ReturnType<typeof fakeTool>[];
  kernel?: any;
  cfg?: Partial<ReturnType<typeof baseCfg>>;
  bootContext?: string;
}) {
  const provider = new FakeProvider(opts.rounds);
  const kernel = opts.kernel ?? new FakeKernel();
  const sync = new FakeSync();
  const session = createAgentSession({
    id: "s1", surface: "headless", provider, kernel, tools: opts.tools ?? [], sync,
    cfg: baseCfg(opts.cfg), cwd: process.cwd(), systemPrompt: "SYS", bootContext: opts.bootContext ?? "BOOT",
  });
  return { provider, kernel, sync, session };
}
const types = (ev: AgentEvent[]) => ev.map((e) => e.type);
const block = (gate: string, reason: string): GateVerdict => ({ gate, action: "block", reason });

test("receipt ids c1,c2 increment across rounds and turns; tool results carry ids; state books calls", async () => {
  const t = fakeTool("mind_query", "read", "answer", "mind");
  let seen: TurnState | undefined;
  const k = new FakeKernel();
  k.hooks.preAnswer = (s) => { seen = s; return []; };
  const { session, provider } = make({
    kernel: k, tools: [t],
    rounds: [
      { calls: [call("a", "mind_query", { q: 1 }), call("b", "mind_query", { q: 2 })] },
      { text: "done one" },
      { calls: [call("c", "mind_query", { q: 3 })] },
      { text: "done two" },
    ],
  });
  const ev1 = await collect(session.send("first"));
  assert.deepEqual(ev1.filter((e) => e.type === "toolStart").map((e: any) => e.receiptId), ["c1", "c2"]);
  assert.equal(ev1.at(-1)?.type, "done");
  assert.equal((ev1.at(-1) as any).finalText, "done one");
  assert.equal(seen!.calls.length, 2);
  const ev2 = await collect(session.send("second"));
  assert.deepEqual(ev2.filter((e) => e.type === "toolStart").map((e: any) => e.receiptId), ["c3"]);
  assert.equal(seen!.calls.length, 1, "calls reset per user message");
  assert.deepEqual(seen!.allCalls.map((c) => c.receiptId), ["c0", "c1", "c2", "c3"]);
  assert.equal(seen!.allCalls[0].tool, "mind_context");
  assert.equal(seen!.allCalls[0].receipt, "mind");
  assert.equal(seen!.booted, true);
  assert.equal(seen!.userMessageIndex, 2);
  const toolMsgs = provider.requests[1].messages.filter((m) => m.role === "tool");
  assert.match(toolMsgs[0].content, /^\[#c1 mind_query\] answer/);
  assert.match(toolMsgs[1].content, /^\[#c2 /);
  assert.ok(ev1.some((e) => e.type === "usage" && (e as any).totalCostUsd > 0));
});

test("system prompt includes boot context; unbooted session has no c0 and booted=false", async () => {
  const a = make({ rounds: [{ text: "x" }], bootContext: "CTX-123" });
  await collect(a.session.send("hi"));
  assert.match(a.provider.requests[0].messages[0].content, /CTX-123/);
  let st: TurnState | undefined;
  const k = new FakeKernel();
  k.hooks.preAnswer = (s) => { st = s; return []; };
  const b = make({ rounds: [{ text: "x" }], bootContext: "", kernel: k });
  await collect(b.session.send("hi"));
  assert.equal(st!.booted, false);
  assert.equal(st!.allCalls.length, 0);
});

test("block verdict: reason returned as tool result, tool not run, no receipt consumed", async () => {
  const t = fakeTool("bash", "write");
  const k = new FakeKernel();
  k.hooks.preTool = () => [block("isolation", "cut a worktree first (mwt)")];
  const { session, provider } = make({ kernel: k, tools: [t], rounds: [{ calls: [call("x", "bash", { command: "rm" })] }, { text: "ok, cutting a worktree" }] });
  const ev = await collect(session.send("do it"));
  assert.equal(t.calls.length, 0);
  const g = ev.find((e) => e.type === "gate") as any;
  assert.equal(g.verdict.gate, "isolation");
  assert.equal(g.enforced, true);
  const tm = provider.requests[1].messages.find((m) => m.role === "tool")!;
  assert.match(tm.content, /blocked by isolation: cut a worktree first/);
  assert.ok(!ev.some((e) => e.type === "toolStart"));
});

test("rewrite verdict runs with rewritten args", async () => {
  const t = fakeTool("bash", "write");
  const k = new FakeKernel();
  k.hooks.preTool = () => [{ gate: "g", action: "rewrite", reason: "r", rewriteArgs: { command: "safe" } }];
  const { session } = make({ kernel: k, tools: [t], rounds: [{ calls: [call("x", "bash", { command: "bad" })] }, { text: "k" }] });
  await collect(session.send("go"));
  assert.deepEqual(t.calls, [{ command: "safe" }]);
});

test("needs-confirmation emits confirm, ends the turn with done, runs nothing", async () => {
  const t = fakeTool("send_email", "outward");
  const k = new FakeKernel();
  k.hooks.preTool = (s, c) => {
    s.confirmations.push({ forCallSignature: callSignature(c), proposedAtUserMsg: s.userMessageIndex });
    return [{ gate: "danger", action: "needs-confirmation", reason: "outward action needs your go" }];
  };
  const { session, provider, sync } = make({
    kernel: k, tools: [t],
    rounds: [{ text: "Drafting.", calls: [call("e1", "send_email", { to: "a@b.co" }), call("e2", "send_email", { to: "z@b.co" })] }],
  });
  const ev = await collect(session.send("email them"));
  const kinds = types(ev);
  assert.ok(kinds.includes("confirm"));
  assert.equal(kinds.at(-1), "done");
  assert.equal(t.calls.length, 0);
  assert.equal(provider.requests.length, 1, "no further model calls after confirm");
  const c = ev.find((e) => e.type === "confirm") as any;
  assert.equal(c.tool, "send_email");
  assert.deepEqual(c.args, { to: "a@b.co" });
  assert.equal(ev.filter((e) => e.type === "confirm").length, 1);
  assert.equal(sync.appended[0][0], "user");
});

test("confirmation end to end with the real kernel: goal approval does not grant, explicit phrase does", async () => {
  const t = fakeTool("send_email", "outward", "sent");
  const kernel = createKernel({ shadow: false, enabled: true });
  const args = { to: "a@b.co" };
  const { session } = make({
    kernel, tools: [t],
    rounds: [
      { calls: [call("e1", "send_email", args)] },        // turn 1: proposed
      { calls: [call("e2", "send_email", args)] },        // turn 2 ("yes make it his account"): still blocked
      { calls: [call("e3", "send_email", args)] },        // turn 3 ("send it"): allowed
      { text: "SURFACE✓ #c1 sent -> sent" },
    ],
  });
  const e1 = await collect(session.send("email a@b.co"));
  assert.ok(e1.some((e) => e.type === "confirm"));
  const e2 = await collect(session.send("yes, make it his account"));
  assert.equal(t.calls.length, 0, "goal approval must not grant the action");
  assert.ok(e2.some((e) => e.type === "confirm"));
  const e3 = await collect(session.send("send it"));
  assert.equal(t.calls.length, 1);
  assert.ok(e3.some((e) => e.type === "toolEnd" && (e as any).ok));
});

test("preAnswer block: draft withheld, regenerated with nudge, revised text ships", async () => {
  const k = new FakeKernel();
  let n = 0;
  k.hooks.preAnswer = (_s, d) => (d.includes("BAD") && n++ < 5 ? [block("receipt", "cite a MIND✓ receipt")] : []);
  const { session, provider } = make({ kernel: k, rounds: [{ text: "BAD claim" }, { text: "good claim" }] });
  const ev = await collect(session.send("q"));
  const texts = ev.filter((e) => e.type === "text").map((e: any) => e.delta);
  assert.deepEqual(texts, ["good claim"], "blocked draft never reaches the surface");
  assert.equal(provider.requests.length, 2);
  const nudge = provider.requests[1].messages.at(-1)!;
  assert.equal(nudge.role, "system");
  assert.match(nudge.content, /cite a MIND✓ receipt/);
  assert.equal((ev.at(-1) as any).finalText, "good claim");
});

test("preAnswer block thrice: max 2 regenerations then ship with footer and a violation on record", async () => {
  const k = new FakeKernel();
  k.hooks.preAnswer = () => [block("receipt", "needs receipt")];
  const { session, provider } = make({ kernel: k, rounds: [{ text: "claim A" }, { text: "claim B" }, { text: "claim C" }] });
  const ev = await collect(session.send("q"));
  assert.equal(provider.requests.length, 3);
  const final = (ev.at(-1) as any).finalText as string;
  assert.ok(final.startsWith("claim C"));
  assert.ok(final.endsWith(UNVERIFIED_FOOTER));
  assert.equal(final.endsWith("[unverified: receipt gate]"), true);
  const v = session.violations();
  assert.equal(v.length, 1);
  assert.equal(v[0].gate, "receipt");
  assert.equal(v[0].enforced, true);
});

test("shadow mode: verdicts surface as gate events with enforced:false and nothing is blocked", async () => {
  const t = fakeTool("bash", "write");
  const k = new FakeKernel();
  k.hooks.preTool = () => [{ gate: "isolation", action: "allow", reason: "[shadow] would block: cut a worktree" }];
  k.hooks.preAnswer = () => [{ gate: "receipt", action: "allow", reason: "[shadow] would block: no receipt" }];
  const { session } = make({ kernel: k, tools: [t], cfg: { shadow: true }, rounds: [{ calls: [call("x", "bash", {})] }, { text: "answer" }] });
  const ev = await collect(session.send("go"));
  assert.equal(t.calls.length, 1);
  const gates = ev.filter((e) => e.type === "gate") as any[];
  assert.equal(gates.length, 2);
  assert.ok(gates.every((g) => g.enforced === false));
  assert.equal((ev.at(-1) as any).finalText, "answer");
});

test("abort stops the turn and leaves message history valid", async () => {
  const ctl = new AbortController();
  const t = fakeTool("slow", "read");
  t.run = async (_a, ctx) => { ctl.abort(); return { ok: true, output: "x" }; };
  const { session, provider } = make({ tools: [t], rounds: [{ calls: [call("1", "slow"), call("2", "slow")] }, { text: "never" }] });
  const ev = await collect(session.send("go", { signal: ctl.signal }));
  assert.equal((ev.at(-1) as any).finalText, "[aborted]");
  assert.equal(provider.requests.length, 1);
  // pre-aborted signal: no model call at all
  const pre = new AbortController();
  pre.abort();
  const b = make({ rounds: [{ text: "x" }] });
  const ev2 = await collect(b.session.send("go", { signal: pre.signal }));
  assert.equal(b.provider.requests.length, 0);
  assert.equal(ev2.at(-1)?.type, "done");
});

test("provider failure ends the turn with an error notice and done, never throws", async () => {
  const { session } = make({ rounds: [() => { throw new Error("boom"); }] });
  const ev = await collect(session.send("go"));
  assert.ok(ev.some((e) => e.type === "notice" && /error: boom/.test((e as any).text)));
  assert.equal(ev.at(-1)?.type, "done");
});

test("max tool rounds stops a runaway loop", async () => {
  const t = fakeTool("r", "read");
  const { session, provider } = make({ tools: [t], cfg: { maxToolRoundsPerTurn: 3 }, rounds: [{ calls: [call("x", "r")] }] });
  const ev = await collect(session.send("go"));
  assert.equal(provider.requests.length, 3);
  assert.ok(ev.some((e) => e.type === "notice" && /tool rounds/.test((e as any).text)));
});

test("pending MIND replies surface as notices and reach the model; turn appends to sync; close forwards summary", async () => {
  const { session, sync, provider } = make({ rounds: [{ text: "answer" }] });
  sync.replies = ["do the thing"];
  const ev = await collect(session.send("hello"));
  assert.ok(ev.some((e) => e.type === "notice" && /do the thing/.test((e as any).text)));
  assert.match(provider.requests[0].messages.at(-1)!.content, /do the thing[\s\S]*hello/);
  assert.deepEqual(sync.appended, [["user", "hello"], ["assistant", "answer"]]);
  await session.close("sum");
  assert.equal(sync.closed, "sum");
});

test("unknown tool and invalid JSON args return errors without running anything", async () => {
  const t = fakeTool("r", "read");
  const { session, provider } = make({
    tools: [t],
    rounds: [{ calls: [call("a", "nope"), call("b", "r", { _invalidJson: "{bad" })] }, { text: "fine" }],
  });
  await collect(session.send("go"));
  assert.equal(t.calls.length, 0);
  const tm = provider.requests[1].messages.filter((m) => m.role === "tool");
  assert.match(tm[0].content, /unknown tool/);
  assert.match(tm[1].content, /not valid JSON/);
});
