import { test } from "node:test";
import assert from "node:assert/strict";
import { alternateMindUrl, edgeFallbackFetch, isEdgeBlock } from "../../src/provider/edge-fallback.ts";

const html403 = () => new Response("<!DOCTYPE html><html>blocked</html>", { status: 403, headers: { "content-type": "text/html; charset=UTF-8" } });
const ok = (host: string) => new Response(JSON.stringify({ host }), { status: 200, headers: { "content-type": "application/json" } });
const OTHER = "https://example-model-host.test/api/v1/chat/completions";

test("alternate address pairs", () => {
  assert.equal(alternateMindUrl("https://mindapp.onrender.com/developer/v1/llm/chat/completions"), "https://m-i-n-d.ai/developer/v1/llm/chat/completions");
  assert.equal(alternateMindUrl("https://m-i-n-d.ai/developer/v1/credits"), "https://mindapp.onrender.com/developer/v1/credits");
  assert.equal(alternateMindUrl(OTHER), undefined);
});

test("only an HTML 403/429/503 is an edge block; a JSON 403 is MIND's own answer", () => {
  assert.equal(isEdgeBlock(html403()), true);
  assert.equal(isEdgeBlock(new Response("{}", { status: 403, headers: { "content-type": "application/json" } })), false);
  assert.equal(isEdgeBlock(ok("x")), false);
});

test("edge 403 on the API service retries once on m-i-n-d.ai with the same body, then sticks to it", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const f = edgeFallbackFetch(async (input, init) => {
    const url = String(input); calls.push({ url, body: init?.body });
    return new URL(url).hostname === "mindapp.onrender.com" ? html403() : ok(new URL(url).hostname);
  });
  const r = await f("https://mindapp.onrender.com/developer/v1/llm/chat/completions", { method: "POST", body: '{"a":1}' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.map((c) => new URL(c.url).hostname), ["mindapp.onrender.com", "m-i-n-d.ai"]);
  assert.equal(calls[1].body, '{"a":1}');
  calls.length = 0;
  await f("https://mindapp.onrender.com/developer/v1/credits");
  assert.deepEqual(calls.map((c) => new URL(c.url).hostname), ["m-i-n-d.ai"]); // remembered
});

test("both edges blocked returns the original block, no loop", async () => {
  let n = 0;
  const f = edgeFallbackFetch(async () => { n++; return html403(); });
  const r = await f("https://mindapp.onrender.com/developer/v1/llm/chat/completions", { method: "POST", body: "{}" });
  assert.equal(r.status, 403); assert.equal(n, 2);
});

test("non-MIND hosts and MIND JSON errors pass through untouched", async () => {
  let n = 0;
  const f = edgeFallbackFetch(async (input) => { n++; return String(input) === OTHER ? html403() : new Response("{}", { status: 402, headers: { "content-type": "application/json" } }); });
  assert.equal((await f(OTHER)).status, 403);
  assert.equal((await f("https://mindapp.onrender.com/developer/v1/llm/chat/completions", { body: "{}" })).status, 402);
  assert.equal(n, 2);
});
