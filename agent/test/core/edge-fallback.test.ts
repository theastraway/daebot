import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { alternateMindUrl, edgeFallbackFetch, isEdgeBlock } from "../../src/provider/edge-fallback.ts";

const html403 = () => new Response("<!DOCTYPE html><html>blocked</html>", { status: 403, headers: { "content-type": "text/html; charset=UTF-8" } });
const ok = (tag: string) => new Response(JSON.stringify({ tag }), { status: 200, headers: { "content-type": "application/json" } });
const OTHER = "https://example-model-host.test/api/v1/chat/completions";
const API = "https://mindapp.onrender.com/developer/v1/llm/chat/completions";
const isGz = (init?: RequestInit) => new Headers(init?.headers ?? {}).get("content-encoding") === "gzip";

test("alternate address pairs", () => {
  assert.equal(alternateMindUrl(API), "https://m-i-n-d.ai/developer/v1/llm/chat/completions");
  assert.equal(alternateMindUrl("https://m-i-n-d.ai/developer/v1/credits"), "https://mindapp.onrender.com/developer/v1/credits");
  assert.equal(alternateMindUrl(OTHER), undefined);
});

test("only an HTML 403/429/503 is an edge block; a JSON 403 is MIND's own answer", () => {
  assert.equal(isEdgeBlock(html403()), true);
  assert.equal(isEdgeBlock(new Response("{}", { status: 403, headers: { "content-type": "application/json" } })), false);
  assert.equal(isEdgeBlock(ok("x")), false);
});

test("a body the edge blocks in plain text is resent gzipped to the same address, then stays gzipped", async () => {
  const calls: Array<{ host: string; gz: boolean; body: string }> = [];
  const f = edgeFallbackFetch(async (input, init) => {
    const gz = isGz(init);
    const body = gz ? gunzipSync(init!.body as Buffer).toString("utf8") : String(init?.body ?? "");
    calls.push({ host: new URL(String(input)).hostname, gz, body });
    return gz ? ok("gz") : html403(); // edge blocks every plain body, passes gzip
  });
  const payload = JSON.stringify({ messages: [{ role: "user", content: "cat ../../etc/passwd | bash" }] });
  const r = await f(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.map((c) => [c.host, c.gz]), [["mindapp.onrender.com", false], ["mindapp.onrender.com", true]]);
  assert.equal(calls[1].body, payload); // same JSON, compressed
  calls.length = 0;
  await f(API, { method: "POST", body: payload });
  assert.deepEqual(calls.map((c) => [c.host, c.gz]), [["mindapp.onrender.com", true]]); // remembered
});

test("when only the other address passes, it is used and remembered", async () => {
  const hosts: string[] = [];
  const f = edgeFallbackFetch(async (input) => {
    const h = new URL(String(input)).hostname; hosts.push(h);
    return h === "mindapp.onrender.com" ? html403() : ok(h);
  });
  assert.equal((await f(API, { method: "POST", body: '{"a":1}' })).status, 200);
  assert.deepEqual(hosts, ["mindapp.onrender.com", "mindapp.onrender.com", "m-i-n-d.ai"]);
  hosts.length = 0;
  await f("https://mindapp.onrender.com/developer/v1/credits");
  assert.deepEqual(hosts, ["m-i-n-d.ai"]);
});

test("everything blocked returns the original block after 4 tries, no loop", async () => {
  let n = 0;
  const f = edgeFallbackFetch(async () => { n++; return html403(); });
  const r = await f(API, { method: "POST", body: "{}" });
  assert.equal(r.status, 403); assert.equal(n, 4);
});

test("non-MIND hosts and MIND JSON errors pass through untouched", async () => {
  let n = 0;
  const f = edgeFallbackFetch(async (input) => { n++; return String(input) === OTHER ? html403() : new Response("{}", { status: 402, headers: { "content-type": "application/json" } }); });
  assert.equal((await f(OTHER)).status, 403);
  assert.equal((await f(API, { body: "{}" })).status, 402);
  assert.equal(n, 2);
});
