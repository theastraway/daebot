import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenRouterProvider, pickModel, toWireMessages } from "../../src/provider/index.ts";
import type { StreamEvent } from "../../src/types.ts";
import { baseCfg } from "./helpers.ts";

const sse = (chunks: (object | string)[], split = 0): Response => {
  const text = chunks.map((c) => (typeof c === "string" && c.startsWith(":") ? `${c}\n\n` : `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`)).join("");
  const enc = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      if (split > 0) for (let i = 0; i < enc.length; i += split) ctl.enqueue(enc.slice(i, i + split));
      else ctl.enqueue(enc);
      ctl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const drain = async (it: AsyncIterable<StreamEvent>) => { const out: StreamEvent[] = []; for await (const e of it) out.push(e); return out; };
const delta = (d: object, extra: object = {}) => ({ choices: [{ delta: d, ...extra }] });

test("parses text, assembled split tool-call JSON, usage and cost (even with 7-byte network chunks)", async () => {
  const chunks = [
    ": OPENROUTER PROCESSING",
    delta({ content: "Hel" }),
    delta({ content: "lo" }),
    delta({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "" } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"/t' } }] }),
    delta({ tool_calls: [{ index: 1, id: "call_b", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'mp/a.txt"}' } }] }, { finish_reason: "tool_calls" }),
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, cost: 0.0042 } },
    "[DONE]",
  ];
  let seen: any;
  const f = (async (url: string, init: any) => { seen = { url, init }; return sse(chunks, 7); }) as any;
  const p = createOpenRouterProvider(baseCfg(), f, { backoffMs: 0 });
  const ev = await drain(p.stream({ model: "m/default", messages: [{ role: "user", content: "hi" }], tools: [{ name: "x", description: "d", parameters: { type: "object" } }] }));
  assert.equal(ev.filter((e) => e.type === "text").map((e: any) => e.delta).join(""), "Hello");
  const calls = ev.filter((e) => e.type === "toolCall").map((e: any) => e.call);
  assert.deepEqual(calls.map((c) => [c.id, c.name, c.args]), [["call_a", "read_file", { path: "/tmp/a.txt" }], ["call_b", "glob", { pattern: "*.ts" }]]);
  const done = ev.at(-1) as any;
  assert.equal(done.type, "done");
  assert.deepEqual(done.usage, { promptTokens: 12, completionTokens: 7, costUsd: 0.0042 });
  assert.equal(done.finishReason, "tool_calls");
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.stream, true);
  assert.equal(body.tools[0].function.name, "x");
  assert.equal(seen.init.headers["HTTP-Referer"], "https://www.m-i-n-d.ai/mindclaw");
  assert.equal(seen.init.headers["X-Title"], "Daebot");
  assert.equal(seen.init.headers.Authorization, "Bearer or-test");
});

test("invalid tool-call JSON is flagged, not thrown", async () => {
  const f = (async () => sse([delta({ tool_calls: [{ index: 0, id: "c", function: { name: "bash", arguments: '{"command": "ls' } }] }), "[DONE]"])) as any;
  const ev = await drain(createOpenRouterProvider(baseCfg(), f, { backoffMs: 0 }).stream({ model: "m", messages: [], tools: [] }));
  const c = (ev.find((e) => e.type === "toolCall") as any).call;
  assert.equal(typeof c.args._invalidJson, "string");
});

test("retries once on 429 then succeeds on the same model", async () => {
  const models: string[] = [];
  let n = 0;
  const f = (async (_u: string, init: any) => {
    models.push(JSON.parse(init.body).model);
    return n++ === 0 ? new Response("slow down", { status: 429 }) : sse([delta({ content: "ok" }), "[DONE]"]);
  }) as any;
  const ev = await drain(createOpenRouterProvider(baseCfg(), f, { backoffMs: 0 }).stream({ model: "m/default", messages: [], tools: [] }));
  assert.deepEqual(models, ["m/default", "m/default"]);
  assert.equal((ev[0] as any).delta, "ok");
});

test("persistent 5xx falls through to the fallback model", async () => {
  const models: string[] = [];
  const f = (async (_u: string, init: any) => {
    const m = JSON.parse(init.body).model;
    models.push(m);
    return m === "m/fallback" ? sse([delta({ content: "fb" }), "[DONE]"]) : new Response("boom", { status: 503 });
  }) as any;
  const ev = await drain(createOpenRouterProvider(baseCfg(), f, { backoffMs: 0 }).stream({ model: "m/default", messages: [], tools: [] }));
  assert.deepEqual(models, ["m/default", "m/default", "m/fallback"]);
  assert.equal((ev[0] as any).delta, "fb");
});

test("an upstream error as the first stream chunk (200 then 429 in SSE) falls through to the fallback model", async () => {
  const models: string[] = [];
  const f = (async (_u: string, init: any) => {
    const m = JSON.parse(init.body).model;
    models.push(m);
    return m === "m/fallback"
      ? sse([delta({ content: "fb" }), "[DONE]"])
      : sse([{ error: { code: 429, message: "Provider returned error" } }]);
  }) as any;
  const ev = await drain(createOpenRouterProvider(baseCfg(), f, { backoffMs: 0 }).stream({ model: "m/default", messages: [], tools: [] }));
  assert.deepEqual(models, ["m/default", "m/fallback"]);
  assert.equal((ev[0] as any).delta, "fb");
});

test("an error after text was streamed propagates (no silent model switch mid-answer)", async () => {
  const models: string[] = [];
  const f = (async (_u: string, init: any) => {
    models.push(JSON.parse(init.body).model);
    return sse([delta({ content: "partial" }), { error: { code: 502, message: "upstream died" } }]);
  }) as any;
  await assert.rejects(drain(createOpenRouterProvider(baseCfg(), f, { backoffMs: 0 }).stream({ model: "m/default", messages: [], tools: [] })), /upstream died/);
  assert.deepEqual(models, ["m/default"]);
});

test("401 throws immediately without fallback; all-fail throws", async () => {
  let n = 0;
  const f401 = (async () => { n++; return new Response("no", { status: 401 }); }) as any;
  await assert.rejects(drain(createOpenRouterProvider(baseCfg(), f401, { backoffMs: 0 }).stream({ model: "m", messages: [], tools: [] })), /401/);
  assert.equal(n, 1);
  const f500 = (async () => new Response("x", { status: 500 })) as any;
  await assert.rejects(drain(createOpenRouterProvider(baseCfg(), f500, { backoffMs: 0 }).stream({ model: "m", messages: [], tools: [] })), /500/);
});

test("abort signal stops the stream", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const f = (async (_u: string, init: any) => { if (init.signal?.aborted) { const e = new Error("a"); e.name = "AbortError"; throw e; } return sse(["[DONE]"]); }) as any;
  await assert.rejects(drain(createOpenRouterProvider(baseCfg(), f, { backoffMs: 0 }).stream({ model: "m", messages: [], tools: [], signal: ctl.signal })), /abort/i);
});

test("wire messages: tool calls, tool results, mid-conversation system folded to user", () => {
  const w = toWireMessages([
    { role: "system", content: "S" },
    { role: "user", content: "u" },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "bash", args: { command: "ls" } }] },
    { role: "tool", content: "out", toolCallId: "1", name: "bash" },
    { role: "system", content: "nudge" },
  ]);
  assert.equal(w[0].role, "system");
  assert.deepEqual((w[2] as any).tool_calls[0], { id: "1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } });
  assert.deepEqual(w[3], { role: "tool", tool_call_id: "1", content: "out" });
  assert.deepEqual(w[4], { role: "user", content: "[system] nudge" });
});

test("pickModel", () => {
  assert.equal(pickModel(baseCfg(), "default"), "m/default");
  assert.equal(pickModel(baseCfg(), "cheap"), "m/cheap");
});
