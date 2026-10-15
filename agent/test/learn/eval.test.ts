import { test } from "node:test";
import assert from "node:assert/strict";
import { runChecks } from "../../src/eval/learning/checks.ts";
import { falseInjectionRate, repeatRate, runLearningSuite } from "../../src/eval/learning/suite.ts";
import { createRuntime } from "../../src/runtime.ts";
import { FakeProvider, baseCfg, collect } from "../core/helpers.ts";

test("LEARNING suite: harness audit passes and learning beats the baseline without false injection", async () => {
  const rep = await runLearningSuite();
  for (const a of rep.audit) assert.equal(a.pass, true, `${a.name}: ${a.detail}`);
  const { off, on, oracle, placebo } = rep.results;
  assert.equal(repeatRate(off), 1);
  assert.equal(repeatRate(oracle), 0);
  assert.equal(repeatRate(placebo), 1);
  assert.ok(repeatRate(on) < repeatRate(off), "learning on must reduce the repeat-error rate");
  assert.ok(repeatRate(on, "similar") <= 0.25, `similar tasks: ${repeatRate(on, "similar")}`);
  assert.equal(falseInjectionRate(on), 0, "unrelated tasks get no lessons");
});

test("LEARNING checks: every safety and robustness check passes", async () => {
  for (const c of await runChecks()) assert.equal(c.pass, true, `${c.id}: ${c.detail}`);
});

function mindFetch(seen: string[]): typeof fetch {
  return (async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    seen.push(`${init.method ?? "GET"} ${u.pathname}`);
    if (u.pathname.endsWith("/context")) return new Response(JSON.stringify({ sections: [{ section: "soul", items: ["x"] }] }), { status: 200 });
    if (u.pathname.endsWith("/query")) return new Response(JSON.stringify({ response: "No relevant context found." }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

test("runtime: learning queries MIND for admin sessions when enabled, never for public/staff, never when off", async () => {
  const run = async (env: NodeJS.ProcessEnv, identity?: string) => {
    const seen: string[] = [];
    const rt = createRuntime(baseCfg({ mindApiKey: "k" }), { provider: new FakeProvider([{ text: "hello there" }]), fetchImpl: mindFetch(seen), env });
    const s = await rt.openSession({ surface: "headless", identity });
    await collect(s.send("What is the status of the deploy progress today?"));
    await s.close();
    return seen.filter((x) => x.endsWith("/query")).length;
  };
  const bootQueries = await run({});
  const enabled = await run({ MINDCLAW_LEARNING: "1" });
  assert.ok(enabled > bootQueries, `admin + enabled queries for lessons (${enabled} vs ${bootQueries})`);
  assert.equal(await run({ MINDCLAW_LEARNING: "1" }, "public"), bootQueries, "public tier: no learning traffic");
  assert.equal(await run({ MINDCLAW_LEARNING: "1" }, "staff"), bootQueries, "staff tier: no learning traffic");
  assert.equal(await run({ MINDCLAW_LEARNING: "0" }), bootQueries, "off: no learning traffic");
});
