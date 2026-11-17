import { test } from "node:test";
import assert from "node:assert/strict";
import { detectOllama, isChatModelName, pickLocalModel } from "../../src/provider/local.ts";
import { createModelCatalog } from "../../src/models.ts";
import { baseCfg } from "../core/helpers.ts";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

test("detect: Ollama /api/tags first, then the OpenAI-compatible /v1/models (LM Studio, llama.cpp, vLLM)", async () => {
  const seen: string[] = [];
  const lmstudio = (async (u: string) => {
    seen.push(String(u));
    if (String(u).endsWith("/api/tags")) return new Response("not found", { status: 404 });
    return json({ data: [{ id: "qwen2.5-7b-instruct" }, { id: "text-embedding-nomic-embed-text-v1.5" }] });
  }) as unknown as typeof fetch;
  const r = await detectOllama({ fetchImpl: lmstudio, base: "http://127.0.0.1:1234" });
  assert.deepEqual(r, { base: "http://127.0.0.1:1234", models: ["qwen2.5-7b-instruct"] });
  assert.deepEqual(seen, ["http://127.0.0.1:1234/api/tags", "http://127.0.0.1:1234/v1/models"]);
  const ollama = (async () => json({ models: [{ name: "nomic-embed-text:latest" }, { name: "qwen3:8b" }] })) as unknown as typeof fetch;
  assert.deepEqual((await detectOllama({ fetchImpl: ollama }))!.models, ["qwen3:8b"], "an embedding model is never a chat model");
  const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  assert.equal(await detectOllama({ fetchImpl: down }), undefined);
  assert.equal(isChatModelName("llama3.1:8b"), true);
  assert.equal(isChatModelName("bge-m3"), false);
  assert.equal(pickLocalModel(["llama3.1:8b"]), "ollama/llama3.1:8b");
});

test("catalog: served local models are listed as ollama/<name>, always allowed; none when nothing is served or no local source is wired", async () => {
  const mind = (async () => json({ models: [{ id: "qwen/qwen3.8-flash", name: "Qwen", tier: "paid" }] })) as unknown as typeof fetch;
  const cfg = { ...baseCfg(), mindBaseUrl: "https://mind.test/developer/v1" };
  let calls = 0;
  let t = 1_000_000;
  const cat = createModelCatalog({ cfg, fetchImpl: mind, now: () => t, local: async () => { calls++; return ["qwen3:8b"]; } });
  const free = await cat.list("k", true);
  const row = free.models.find((m) => m.id === "ollama/qwen3:8b");
  assert.ok(row, "the local model is in the list");
  assert.equal(row!.allowed, true, "allowed even on the free plan");
  assert.equal(free.models.find((m) => m.id === "qwen/qwen3.8-flash")!.allowed, false, "a paid model stays blocked on the free plan");
  await cat.list("k", false);
  assert.equal(calls, 1, "the local probe is cached for 30 seconds");
  t += 31_000;
  await cat.list("k", false);
  assert.equal(calls, 2);
  const none = createModelCatalog({ cfg, fetchImpl: mind });
  assert.equal((await none.list("k", false)).models.some((m) => m.id.startsWith("ollama/")), false, "hosted and tests wire no local source");
  const empty = createModelCatalog({ cfg, fetchImpl: mind, local: async () => { throw new Error("x"); } });
  assert.equal((await empty.list("k", false)).models.some((m) => m.id.startsWith("ollama/")), false);
});
