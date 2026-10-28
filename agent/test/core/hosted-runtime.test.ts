import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../../src/runtime.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { DailyCostCap, filterHostedTools, hostedToolAllowed, parseDailyCap } from "../../src/hosted.ts";
import { createBuiltinTools } from "../../src/tools/index.ts";
import type { Provider, StreamEvent } from "../../src/types.ts";
import { FakeProvider, baseCfg, call, collect, fakeTool } from "./helpers.ts";

const offline = (async () => { throw new Error("offline"); }) as any; // no network in tests: MIND boot fails, which is fine here

test("hosted: the offered tool set is web_fetch plus mind_* only; no shell or file tools", async () => {
  const provider = new FakeProvider([{ text: "hi" }]);
  const rt = createRuntime(baseCfg(), { provider, fetchImpl: offline, hosted: { dailyUsdCap: 5 } });
  const s = await rt.openSession({ surface: "web" });
  await collect(s.send("hello"));
  const names = provider.requests[0].tools.map((t) => t.name);
  for (const banned of ["bash", "read_file", "write_file", "edit_file", "glob", "grep"]) assert.ok(!names.includes(banned), `${banned} must not be offered`);
  assert.ok(names.every((n) => n === "web_fetch" || n.startsWith("mind_")), names.join(","));
  // before boot the kernel narrows further, so assert on the pure filter too
  const all = filterHostedTools(createBuiltinTools()).map((t) => t.spec.name);
  assert.deepEqual(all, ["web_fetch", "apple_calendar"]); // apple_calendar runs on the user's device through the relay, never on this host
  // local (non hosted) runtime still offers the full set
  const p2 = new FakeProvider([{ text: "hi" }]);
  const rt2 = createRuntime(baseCfg(), { provider: p2, fetchImpl: offline });
  await collect((await rt2.openSession({ surface: "tui" })).send("hello"));
  assert.ok(createBuiltinTools().length > 1);
  await s.close();
});

test("hosted: a model that calls bash gets a clean error and nothing runs", async () => {
  const provider = new FakeProvider([
    { calls: [call("c1", "bash", { command: "printenv" })] },
    { text: "ok" },
  ]);
  const rt = createRuntime(baseCfg(), { provider, fetchImpl: offline, hosted: { dailyUsdCap: 5 } });
  const s = await rt.openSession({ surface: "web" });
  const ev = await collect(s.send("run printenv"));
  const second = provider.requests[1];
  const toolMsg = second.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "tool result was returned to the model");
  assert.match(String((toolMsg as any).content), /unknown tool "bash"/);
  assert.ok(!ev.some((e) => e.type === "toolStart" && (e as any).tool === "bash"), "bash never started");
  await s.close();
});

test("hosted kernel gate: blocks every host-level tool name even if it slipped into the list", () => {
  const k = createKernel({ shadow: false, enabled: true, hosted: true });
  const state: any = { sessionId: "s", booted: true, calls: [], userMessages: [], userMsgIndex: 1, confirmations: [], shadow: false };
  for (const name of ["bash", "read_file", "write_file", "edit_file", "glob", "grep"]) {
    const v = k.preTool(state, call("x", name, {}), fakeTool(name, "read"));
    assert.equal(v.find((x) => x.gate === "hosted")?.action, "block", name);
  }
  const ok = k.preTool(state, call("y", "web_fetch", { url: "https://example.com" }), fakeTool("web_fetch", "read"));
  assert.ok(!ok.some((x) => x.gate === "hosted"));
  const offered = k.allowedTools(state, ["bash", "web_fetch", "mind_query", "grep"].map((n) => fakeTool(n, "read"))).map((t) => t.spec.name);
  assert.deepEqual(offered, ["web_fetch", "mind_query"]);
  assert.ok(hostedToolAllowed("mind_remember") && !hostedToolAllowed("mind") && !hostedToolAllowed("bash"));
});

class CostlyProvider implements Provider {
  name = "costly";
  calls = 0;
  async *stream(): AsyncIterable<StreamEvent> {
    this.calls++;
    yield { type: "text", delta: "answer" };
    yield { type: "done", usage: { promptTokens: 1, completionTokens: 1, costUsd: 3 }, finishReason: "stop" };
  }
}

test("hosted: daily cost cap refuses new turns with a one-line notice, and resets on the next UTC day", async () => {
  let now = new Date("2026-10-15T12:00:00Z");
  const provider = new CostlyProvider();
  const rt = createRuntime(baseCfg(), { provider, fetchImpl: offline, hosted: { dailyUsdCap: 5, now: () => now } });
  const s = await rt.openSession({ surface: "web" });
  await collect(s.send("one"));   // $3 spent
  await collect(s.send("two"));   // $6 total, allowed to finish, now over the cap
  assert.equal(provider.calls, 2);
  const refused = await collect(s.send("three"));
  assert.equal(provider.calls, 2, "provider not called once over the cap");
  const n = refused.find((e) => e.type === "notice") as any;
  assert.match(n.text, /Daily cost cap reached/);
  assert.ok(!n.text.includes("\n"));
  assert.equal((refused.at(-1) as any).type, "done");
  // a second session shares the process-wide cap
  const s2 = await rt.openSession({ surface: "web" });
  await collect(s2.send("hi"));
  assert.equal(provider.calls, 2);
  now = new Date("2026-10-16T00:00:01Z");
  await collect(s2.send("new day"));
  assert.equal(provider.calls, 3);
  await s.close(); await s2.close();
});

test("cost cap helpers: env parsing and accounting", () => {
  assert.equal(parseDailyCap(undefined), 5);
  assert.equal(parseDailyCap("abc"), 5);
  assert.equal(parseDailyCap("-1"), 5);
  assert.equal(parseDailyCap("2.5"), 2.5);
  const c = new DailyCostCap(1);
  c.add(0.4); assert.equal(c.exceeded(), false);
  c.add(0.6); assert.equal(c.exceeded(), true);
});

test("hosted runtime forces the kernel on and enforcing, whatever the config says", async () => {
  const provider = new FakeProvider([{ calls: [call("c1", "mind_remember", { type: "entry" })] }, { text: "x" }]);
  const rt = createRuntime(baseCfg({ kernel: false, shadow: true }), { provider, fetchImpl: offline, hosted: { dailyUsdCap: 5 } });
  const s = await rt.openSession({ surface: "web" });
  const ev = await collect(s.send("remember this"));
  assert.ok(ev.some((e) => e.type === "gate" && (e as any).enforced === true), "a gate fired in enforcing mode");
  await s.close();
});
