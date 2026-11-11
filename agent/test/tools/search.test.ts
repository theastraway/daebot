import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebSearchTool, parseSearchHits } from "../../src/tools/search.ts";
import { llmEndpoint } from "../../src/tools/llm-call.ts";
import { hostedToolAllowed } from "../../src/hosted.ts";
import { botSessionTools } from "../../src/runtime.ts";
import { writeTrust } from "../../src/learn/guard.ts";

const ctx = { cwd: "/", sessionId: "s1" };
const completion = (annotations: unknown[], cost = 0.0071) => ({
  model: "deepseek/deepseek-v4.1-flash",
  choices: [{ message: { role: "assistant", content: "OK", annotations } }],
  usage: { prompt_tokens: 1202, completion_tokens: 3, cost },
});
const cite = (url: string, title: string, content: string) => ({ type: "url_citation", url_citation: { url, title, content } });
const ENDPOINT = { url: "https://mind.test/developer/v1/llm/chat/completions", via: "mind" as const, headers: () => ({ "Content-Type": "application/json", "X-API-Key": "mind_user_key" }) };

test("parseSearchHits: ranked, deduplicated, title line removed from the snippet", () => {
  const hits = parseSearchHits(completion([
    cite("https://a.example/x", "Alpha", "Alpha\n\n# Heading\n\nBody  text   here"),
    cite("https://a.example/x", "Alpha again", "dup"),
    { type: "other" },
    cite("ftp://nope", "no", "no"),
    cite("https://b.example/", "", "plain"),
  ]));
  assert.deepEqual(hits.map((h) => [h.rank, h.url, h.title]), [[1, "https://a.example/x", "Alpha"], [2, "https://b.example/", "https://b.example/"]]);
  assert.equal(hits[0].snippet, "Heading Body text here");
});

test("web_search sends the web plugin to the MIND proxy with the user's key and returns cited results plus the cost", async () => {
  const seen: any[] = [];
  const tool = createWebSearchTool({
    endpoint: () => ENDPOINT,
    fetchImpl: (async (url: string, init: any) => { seen.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return new Response(JSON.stringify(completion([cite("https://nodejs.org/", "Node.js", "Node.js\nLatest LTS is 26")])), { status: 200 }); }) as any,
  });
  const r = await tool.run({ query: "latest node lts", max_results: 3 }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /> 1\. Node\.js\n>\s+https:\/\/nodejs\.org\//);
  assert.match(r.output, /UNTRUSTED/);
  assert.equal(r.meta?.costUsd, 0.0071);
  assert.equal(r.meta?.results, 1);
  assert.equal(seen[0].url, ENDPOINT.url);
  assert.equal(seen[0].headers["X-API-Key"], "mind_user_key");
  assert.deepEqual(seen[0].body.plugins, [{ id: "web", max_results: 3 }]);
  assert.equal(seen[0].body.stream, undefined);
  assert.ok(seen[0].body.max_tokens <= 32);
  assert.equal(tool.class, "read");
});

test("web_search: validates the query, clamps max_results, reports no results and refusals in plain words", async () => {
  const bodies: any[] = [];
  const mk = (res: () => Response) => createWebSearchTool({ endpoint: () => ENDPOINT, fetchImpl: (async (_u: string, i: any) => { bodies.push(JSON.parse(i.body)); return res(); }) as any });
  assert.equal((await mk(() => new Response("{}")).run({ query: "  " }, ctx)).ok, false);
  assert.equal((await mk(() => new Response("{}")).run({ query: "x".repeat(401) }, ctx)).ok, false);
  const empty = await mk(() => new Response(JSON.stringify(completion([])), { status: 200 })).run({ query: "zzz", max_results: 99 }, ctx);
  assert.equal(empty.ok, true);
  assert.match(empty.output, /no results/);
  assert.equal(bodies[0].plugins[0].max_results, 8);
  const broke = await mk(() => new Response(JSON.stringify({ error: "insufficient_credits" }), { status: 402 })).run({ query: "q" }, ctx);
  assert.equal(broke.ok, false);
  assert.match(broke.output, /no credits/);
  const noEp = await createWebSearchTool({ endpoint: () => undefined }).run({ query: "q" }, ctx);
  assert.equal(noEp.ok, false);
});

test("llmEndpoint: MIND billing uses the user's MIND key; self-host uses the OpenRouter key; neither means no endpoint", () => {
  const mind = llmEndpoint({ billing: "mind", mindBaseUrl: "https://m.test/developer/v1/", openrouterKey: "sk-or-server" }, () => "mind_u");
  assert.equal(mind?.url, "https://m.test/developer/v1/llm/chat/completions");
  assert.equal(mind?.headers()["X-API-Key"], "mind_u");
  assert.equal(JSON.stringify(mind?.headers()).includes("sk-or-server"), false);
  const or = llmEndpoint({ billing: "openrouter", mindBaseUrl: "x", openrouterKey: "sk-or-server" }, () => "");
  assert.match(or!.url, /openrouter\.ai/);
  assert.equal(or!.headers().Authorization, "Bearer sk-or-server");
  assert.equal(llmEndpoint({ billing: "openrouter", mindBaseUrl: "x", openrouterKey: "" }, () => ""), undefined);
});

test("web_search is allowed on hosted, is outward for a bot, and taints a learning turn", () => {
  assert.equal(hostedToolAllowed("web_search"), true);
  const t = createWebSearchTool({ endpoint: () => ENDPOINT });
  const bot = botSessionTools([t]);
  assert.equal(bot[0].classFor?.({ query: "q" }), "outward");
  assert.equal(writeTrust("admin", [{ tool: "web_search" } as any]).ok, false);
});
