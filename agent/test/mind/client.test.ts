import { test } from "node:test";
import assert from "node:assert/strict";
import { createMindClient } from "../../src/mind/index.ts";
import { cfg, fakeFetch, json, KEY } from "./helpers.ts";

const fast = { retryDelayMs: 0 };

test("context: POST /context with sections, key header, joins sections", async () => {
  const { fetch, seen } = fakeFetch(() => json(200, { sections: [
    { section: "soul", status: "ok", items: [{ text: "Anthony Conti, owner" }] },
    { section: "priorities", status: "ok", items: [{ text: "ship MINDClaw" }, { text: "second" }] },
  ] }));
  const c = createMindClient(cfg(), fetch, fast);
  const out = await c.context(["soul", "priorities"], "boot");
  assert.equal(seen[0].url, "https://m-i-n-d.ai/developer/v1/context");
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].headers["x-api-key"], KEY);
  assert.equal(seen[0].headers["content-type"], "application/json");
  assert.deepEqual(seen[0].body, { sections: ["soul", "priorities"], for_task: "boot" });
  assert.match(out, /## SOUL\nAnthony Conti, owner/);
  assert.match(out, /## PRIORITIES\nship MINDClaw\nsecond/);
});

test("context: default sections are all five; all-empty is an error", async () => {
  const { fetch, seen } = fakeFetch(() => json(200, { sections: [{ section: "soul", status: "error", error: "boom", items: [] }] }));
  const c = createMindClient(cfg(), fetch, fast);
  await assert.rejects(() => c.context(), /no section returned content/);
  assert.deepEqual(seen[0].body.sections, ["soul", "user", "rules", "priorities", "recent"]);
});

test("query: POST /query retrieve_only, returns response string, clamps tokens to 1000", async () => {
  const { fetch, seen } = fakeFetch(() => json(200, { response: "the answer" }));
  const c = createMindClient(cfg(), fetch, fast);
  assert.equal(await c.query("what is X?", { maxContextTokens: 200 }), "the answer");
  assert.deepEqual(seen[0].body, { query: "what is X?", mode: "hybrid", retrieve_only: true, max_context_tokens: 1000 });
});

test("remember: entry -> /entries, document -> /documents, default source", async () => {
  const { fetch, seen } = fakeFetch(() => json(200, { id: "abc" }));
  const c = createMindClient(cfg(), fetch, fast);
  assert.equal(await c.remember({ title: "t", content: "c", tags: ["a"] }), "saved entry abc");
  assert.equal(await c.remember({ type: "document", title: "t", content: "c" }), "saved document abc");
  assert.equal(seen[0].url, "https://m-i-n-d.ai/developer/v1/entries");
  assert.equal(seen[1].url, "https://m-i-n-d.ai/developer/v1/documents");
  assert.deepEqual(seen[0].body, { title: "t", content: "c", tags: ["a"], source: "mindclaw" });
});

test("call: resource routes (life get, crm create, sense state, agents admin root)", async () => {
  const { fetch, seen } = fakeFetch(() => json(200, { ok: 1 }));
  const c = createMindClient(cfg(), fetch, fast);
  await c.call("mind_life", { action: "get", item_id: "i 1" });
  await c.call("crm", { action: "create", name: "N", owner_check: "a == a" });
  await c.call("sense", { action: "state" });
  await c.call("agents", { action: "list" });
  await c.call("life", { action: "list", status: "active" });
  assert.equal(seen[0].url, "https://m-i-n-d.ai/developer/v1/life/items/i%201");
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].body, undefined);
  assert.equal(seen[1].url, "https://m-i-n-d.ai/developer/v1/crm/contacts");
  assert.deepEqual(seen[1].body, { name: "N" }); // owner_check and action never sent
  assert.equal(seen[2].url, "https://m-i-n-d.ai/developer/v1/mindsense/state");
  assert.equal(seen[3].url, "https://m-i-n-d.ai/admin/agents");
  assert.equal(seen[4].url, "https://m-i-n-d.ai/developer/v1/life/items?status=active");
});

test("call: unknown tool falls back to POST /<tool> with args", async () => {
  const { fetch, seen } = fakeFetch(() => json(200, { x: 1 }));
  const c = createMindClient(cfg(), fetch, fast);
  assert.equal(await c.call("mind_widgets", { a: 1 }), '{"x":1}');
  assert.equal(seen[0].url, "https://m-i-n-d.ai/developer/v1/widgets");
  assert.deepEqual(seen[0].body, { a: 1 });
});

test("errors never contain the key, even when the server echoes it", async () => {
  const { fetch } = fakeFetch(() => json(401, { detail: `bad key ${KEY} rejected` }));
  const c = createMindClient(cfg(), fetch, fast);
  await assert.rejects(() => c.query("q"), (e: Error) => {
    assert.ok(!e.message.includes(KEY));
    assert.ok(!/mind_[A-Za-z0-9]{12,}/.test(e.message));
    assert.match(e.message, /HTTP 401/);
    return true;
  });
  const f2 = (async () => { throw new Error(`connect failed for ${KEY}`); }) as unknown as typeof fetch;
  const c2 = createMindClient(cfg(), f2, { retryDelayMs: 0 });
  await assert.rejects(() => c2.query("q"), (e: Error) => !e.message.includes(KEY));
});

test("retry once on 502 then succeed; retry once on 503 then fail with HTTP 503", async () => {
  const a = fakeFetch((_r, n) => (n === 1 ? json(502, { detail: "bad gateway" }) : json(200, { response: "ok" })));
  assert.equal(await createMindClient(cfg(), a.fetch, fast).query("q"), "ok");
  assert.equal(a.seen.length, 2);
  const b = fakeFetch(() => json(503, { detail: "down" }));
  await assert.rejects(() => createMindClient(cfg(), b.fetch, fast).query("q"), /HTTP 503/);
  assert.equal(b.seen.length, 2);
});

test("no retry on 4xx", async () => {
  const a = fakeFetch(() => json(422, { detail: "nope" }));
  await assert.rejects(() => createMindClient(cfg(), a.fetch, fast).query("q"), /HTTP 422/);
  assert.equal(a.seen.length, 1);
});

test("timeout aborts, retries once, then throws a timed out error", async () => {
  const a = fakeFetch(() => "hang");
  const c = createMindClient(cfg(), a.fetch, { timeoutMs: 20, retryDelayMs: 0 });
  await assert.rejects(() => c.query("q"), /timed out/);
  assert.equal(a.seen.length, 2);
});

test("context uses the longer timeout than the default", async () => {
  // A request that takes 60ms: context (500ms budget) succeeds, query (20ms budget) times out.
  const mk = () => {
    const f = (async (_u: any, init: any) => new Promise<Response>((res, rej) => {
      const t = setTimeout(() => res(json(200, { sections: [{ section: "soul", status: "ok", items: [{ text: "x" }] }], response: "r" })), 60);
      init.signal.addEventListener("abort", () => { clearTimeout(t); const e = new Error("aborted"); e.name = "AbortError"; rej(e); });
    })) as unknown as typeof fetch;
    return createMindClient(cfg(), f, { timeoutMs: 20, contextTimeoutMs: 500, retryDelayMs: 0 });
  };
  const c = mk();
  assert.match(await c.context(["soul"]), /x/);
  await assert.rejects(() => c.query("q"), /timed out/);
});

test("missing key fails fast without a network call", async () => {
  const a = fakeFetch(() => json(200, {}));
  const c = createMindClient(cfg({ mindApiKey: "" }), a.fetch, fast);
  await assert.rejects(() => c.query("q"), /no API key/);
  assert.equal(a.seen.length, 0);
});
