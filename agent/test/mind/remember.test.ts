import { test } from "node:test";
import assert from "node:assert/strict";
import { createMindClient, createMindTools } from "../../src/mind/index.ts";
import { routeFor } from "../../src/mind/routes.ts";
import { dangerGate } from "../../src/kernel/danger.ts";
import type { Tool } from "../../src/types.ts";
import { cfg, fakeFetch, json } from "./helpers.ts";
import { call, state } from "../kernel/helpers.ts";

const ctx = { cwd: "/", sessionId: "s" };
const OWNER = "note belongs to Ada; Ada asked about Ada; Ada == Ada";
const REASON = "the old fact was wrong";

function tools(handler: Parameters<typeof fakeFetch>[0], user = "Anthony") {
  const f = fakeFetch(handler);
  const list = createMindTools(createMindClient(cfg(), f.fetch, { retryDelayMs: 0 }), { user });
  const by = (n: string): Tool => {
    const t = list.find((x) => x.spec.name === n);
    assert.ok(t, n);
    return t!;
  };
  return { by, seen: f.seen };
}

test("routes: get/list/search/delete for entry and document, supersedes on POST /entries", () => {
  const getE = routeFor("remember", { action: "get", type: "entry", item_id: "e/1" });
  assert.equal(getE.method, "GET");
  assert.equal(getE.path, "/entries/e%2F1");
  assert.equal(getE.query, undefined);

  const getD = routeFor("remember", { action: "get", type: "document", item_id: "d1" });
  assert.equal(getD.method, "GET");
  assert.equal(getD.path, "/documents/d1");
  assert.deepEqual(getD.query, { include_content: "true" });

  const listE = routeFor("remember", { action: "list", type: "entry", limit: 10 });
  assert.equal(listE.method, "GET");
  assert.equal(listE.path, "/entries");
  assert.deepEqual(listE.query, { limit: "10" });

  const listD = routeFor("remember", { action: "list", type: "document", page: 2, limit: 10 });
  assert.equal(listD.method, "GET");
  assert.equal(listD.path, "/documents");
  assert.deepEqual(listD.query, { page: "2", page_size: "10" });

  const searchE = routeFor("remember", { action: "search", type: "entry", query: "tea time", limit: 3 });
  assert.equal(searchE.method, "GET");
  assert.equal(searchE.path, "/entries/search");
  assert.deepEqual(searchE.query, { query: "tea time", limit: "3" });

  // No document search endpoint: search is the list. The query string is page/page_size, not the search text.
  const searchD = routeFor("remember", { action: "search", type: "document", query: "tea", page: 1, limit: 20 });
  assert.equal(searchD.method, "GET");
  assert.equal(searchD.path, "/documents");
  assert.deepEqual(searchD.query, { page: "1", page_size: "20" });

  const delE = routeFor("remember", { action: "delete", type: "entry", item_id: "e1" });
  assert.equal(delE.method, "DELETE");
  assert.equal(delE.path, "/entries/e1");
  const delD = routeFor("remember", { action: "delete", type: "document", item_id: "d1" });
  assert.equal(delD.method, "DELETE");
  assert.equal(delD.path, "/documents/d1");

  const post = routeFor("remember", { title: "t", content: "c", tags: ["a"], source: "mindclaw", supersedes: ["old-1", "old-2"], reason: REASON });
  assert.equal(post.method, "POST");
  assert.equal(post.path, "/entries");
  assert.deepEqual(post.body?.supersedes, ["old-1", "old-2"]);
  assert.equal(post.body?.reason, undefined);
  assert.equal(post.body?.title, "t");

  const doc = routeFor("remember", { type: "document", title: "t", content: "c", supersedes: ["old-1"] });
  assert.equal(doc.method, "POST");
  assert.equal(doc.path, "/documents");
  assert.equal(doc.body?.supersedes, undefined);

  // A create with no action is still a plain POST, same fields as before.
  const plain = routeFor("remember", { title: "t", content: "c", tags: ["a"], source: "mindclaw" });
  assert.equal(plain.method, "POST");
  assert.equal(plain.path, "/entries");
  assert.deepEqual(plain.body, { title: "t", content: "c", tags: ["a"], source: "mindclaw" });
});

test("classFor: get/list/search read, create/supersede write, delete irreversible; danger gate asks only for delete", () => {
  const { by } = tools(() => json(200, {}));
  const t = by("mind_remember");
  for (const action of ["get", "list", "search"]) assert.equal(t.classFor!({ action }), "read", action);
  assert.equal(t.classFor!({ action: "create" }), "write");
  assert.equal(t.classFor!({ action: "supersede", supersedes: ["x"] }), "write");
  assert.equal(t.classFor!({ supersedes: ["x"] }), "write");
  assert.equal(t.classFor!({}), "write");
  assert.equal(t.classFor!({ action: "delete" }), "irreversible");
  assert.equal(t.classFor!({ action: " DELETE " }), "irreversible");
  assert.equal(t.class, "write");

  assert.equal(dangerGate.preTool!(state(), call("mind_remember", { action: "get", item_id: "e1" }), t), undefined);
  assert.equal(dangerGate.preTool!(state(), call("mind_remember", { action: "list" }), t), undefined);
  assert.equal(dangerGate.preTool!(state(), call("mind_remember", { action: "search", query: "q" }), t), undefined);
  assert.equal(dangerGate.preTool!(state(), call("mind_remember", { title: "t", content: "c" }), t), undefined);
  const card = dangerGate.preTool!(state(), call("mind_remember", { action: "delete", type: "entry", item_id: "e1", reason: REASON }), t);
  assert.equal(card?.gate, "danger");
  assert.equal(card?.action, "needs-confirmation");
});

test("get and delete are accepted without title or content; the schema does not require them", async () => {
  const { by, seen } = tools((req) => {
    if (req.method === "GET") return json(200, { title: "T", content: "body" });
    if (req.method === "DELETE") return json(200, { status: "deleted" });
    return json(200, { id: "audit-bare" });
  });
  const t = by("mind_remember");
  const required = (t.spec.parameters as { required?: string[] }).required ?? [];
  assert.ok(!required.includes("title"));
  assert.ok(!required.includes("content"));
  assert.ok(required.includes("owner_check"));
  const got = await t.run({ action: "get", type: "entry", item_id: "e1" }, ctx);
  assert.equal(got.ok, true, got.output);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].body, undefined);
  const del = await t.run({ action: "delete", type: "entry", item_id: "e1", reason: REASON, owner_check: OWNER }, ctx);
  assert.equal(del.ok, true, del.output);
  assert.match(del.output, /deleted entry e1/);
  // Delete loads the title first, then DELETEs. Neither request carries title or content.
  assert.equal(seen[1].method, "GET");
  assert.equal(seen[1].body, undefined);
  assert.equal(seen[2].method, "DELETE");
  assert.equal(seen[2].body, undefined);
  const created = await t.run({ owner_check: OWNER }, ctx);
  assert.equal(created.ok, false);
  assert.match(created.output, /title and content/);
  assert.equal(seen.length, 4, "the refused create makes no further request");
});

test("reads need no owner_check; delete still does", async () => {
  const { by, seen } = tools(() => json(200, { title: "T", content: "c", entries: [] }));
  const t = by("mind_remember");
  const got = await t.run({ action: "get", type: "entry", item_id: "e1" }, ctx);
  assert.equal(got.ok, true, got.output);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, "https://m-i-n-d.ai/developer/v1/entries/e1");
  const denied = await t.run({ action: "delete", type: "entry", item_id: "e1", reason: REASON }, ctx);
  assert.equal(denied.ok, false);
  assert.match(denied.output, /owner_check/);
  assert.equal(seen.length, 1);
});

test("delete: GET title, DELETE, audit entry with redacted preview; missing reason or item_id is refused", async () => {
  const secret = "sk-or-abcdefghijklmnop1234";
  const content = `${secret}\n${"y".repeat(300)}`;
  const { by, seen } = tools((req) => {
    if (req.method === "GET") return json(200, { title: "Old note", content });
    if (req.method === "DELETE") return json(200, { status: "deleted", id: "e1" });
    return json(200, { id: "audit1" });
  });
  const r = await by("mind_remember").run({ action: "delete", type: "entry", item_id: "e1", reason: REASON, owner_check: OWNER }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /deleted entry e1/);
  assert.match(r.output, /Old note/);
  assert.match(r.output, /audit: saved entry audit1/);
  assert.doesNotMatch(r.output, /warning:/);
  assert.equal(seen.length, 3);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, "https://m-i-n-d.ai/developer/v1/entries/e1");
  assert.equal(seen[1].method, "DELETE");
  assert.equal(seen[1].url, "https://m-i-n-d.ai/developer/v1/entries/e1");
  assert.equal(seen[2].method, "POST");
  assert.equal(seen[2].url, "https://m-i-n-d.ai/developer/v1/entries");
  assert.equal(seen[2].body.title, "Memory deleted - Old note");
  assert.deepEqual(seen[2].body.tags, ["daebot-memory-audit", "deleted", "origin:tool"]);
  assert.match(seen[2].body.content, /Item: e1/);
  assert.match(seen[2].body.content, /Type: entry/);
  assert.match(seen[2].body.content, new RegExp(`Reason: ${REASON}`));
  assert.match(seen[2].body.content, /Asked by: Anthony/);
  assert.match(seen[2].body.content, /Time: \d{4}-\d{2}-\d{2}T/);
  const preview = seen[2].body.content.slice(seen[2].body.content.indexOf("Preview: ") + "Preview: ".length);
  assert.ok(preview.length <= 200, `preview ${preview.length}`);
  assert.match(preview, /\[redacted secret\]/);
  assert.ok(!seen[2].body.content.includes(secret));
  assert.ok(!r.output.includes(secret));

  const refused = tools(() => json(200, {}));
  const noReason = await refused.by("mind_remember").run({ action: "delete", type: "entry", item_id: "e1", owner_check: OWNER }, ctx);
  assert.equal(noReason.ok, false);
  assert.match(noReason.output, /reason/);
  const blank = await refused.by("mind_remember").run({ action: "delete", type: "entry", item_id: "e1", reason: "   ", owner_check: OWNER }, ctx);
  assert.equal(blank.ok, false);
  assert.match(blank.output, /reason/);
  const noId = await refused.by("mind_remember").run({ action: "delete", type: "entry", reason: REASON, owner_check: OWNER }, ctx);
  assert.equal(noId.ok, false);
  assert.match(noId.output, /item_id/);
  const noType = await refused.by("mind_remember").run({ action: "delete", item_id: "e1", reason: REASON, owner_check: OWNER }, ctx);
  assert.equal(noType.ok, false);
  assert.match(noType.output, /type/);
  assert.equal(refused.seen.length, 0);
});

test("delete still reports deleted when the audit write fails, and when the GET fails the title is unknown", async () => {
  const auditFail = tools((req) => {
    if (req.method === "GET") return json(200, { title: "Kept", content: "body" });
    if (req.method === "DELETE") return json(200, { status: "deleted" });
    return json(500, { detail: "audit down" });
  });
  const r = await auditFail.by("mind_remember").run({ action: "delete", type: "document", item_id: "d1", reason: REASON, owner_check: OWNER }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /deleted document d1/);
  assert.match(r.output, /Kept/);
  assert.match(r.output, /warning: delete succeeded but the audit entry was not saved/);
  assert.equal(auditFail.seen[0].method, "GET");
  assert.equal(auditFail.seen[0].url, "https://m-i-n-d.ai/developer/v1/documents/d1?include_content=true");
  assert.equal(auditFail.seen[1].method, "DELETE");
  assert.equal(auditFail.seen[1].url, "https://m-i-n-d.ai/developer/v1/documents/d1");
  assert.equal(auditFail.seen[2].method, "POST");

  const unknown = tools((req) => {
    if (req.method === "GET") return json(404, { detail: "missing" });
    if (req.method === "DELETE") return json(200, { status: "deleted" });
    return json(200, { id: "audit2" });
  });
  const u = await unknown.by("mind_remember").run({ action: "delete", type: "entry", item_id: "gone", reason: REASON, owner_check: OWNER }, ctx);
  assert.equal(u.ok, true, u.output);
  assert.match(u.output, /title unknown/);
  assert.doesNotMatch(u.output, /warning:/);
  assert.equal(unknown.seen[2].body.title, "Memory deleted - title unknown");
  assert.match(unknown.seen[2].body.content, /Item: gone/);
});

test("supersede without a reason is refused; an entry passes supersedes; a document is tagged and not deleted", async () => {
  const { by, seen } = tools(() => json(200, { id: "new1" }));
  const t = by("mind_remember");
  const missing = await t.run({ title: "New", content: "Corrected fact", supersedes: ["old1"], owner_check: OWNER }, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.output, /reason/);
  const short = await t.run({ title: "New", content: "Corrected fact", supersedes: ["old1"], reason: "wrong fact", owner_check: OWNER }, ctx);
  assert.equal(short.ok, false);
  assert.match(short.output, /few words/);
  assert.equal(seen.length, 0);

  const entry = await t.run({ title: "New", content: "Corrected fact", tags: ["keep"], supersedes: ["old1", "old2"], reason: REASON, owner_check: OWNER }, ctx);
  assert.equal(entry.ok, true, entry.output);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "https://m-i-n-d.ai/developer/v1/entries");
  assert.deepEqual(seen[0].body.supersedes, ["old1", "old2"]);
  assert.match(seen[0].body.content, /Supersedes old1, old2: the old fact was wrong/);
  assert.ok(seen[0].body.content.startsWith("Corrected fact"));
  assert.ok(seen[0].body.tags.includes("keep"));
  assert.ok(seen[0].body.tags.includes("supersedes:old1"));
  assert.ok(seen[0].body.tags.includes("supersedes:old2"));
  assert.equal(seen[0].body.reason, undefined);

  const doc = await t.run({ type: "document", title: "New doc", content: "Corrected doc", supersedes: ["doc9"], reason: REASON, owner_check: OWNER }, ctx);
  assert.equal(doc.ok, true, doc.output);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].method, "POST");
  assert.equal(seen[1].url, "https://m-i-n-d.ai/developer/v1/documents");
  assert.equal(seen[1].body.supersedes, undefined);
  assert.match(seen[1].body.content, /Supersedes doc9: the old fact was wrong/);
  assert.ok(seen[1].body.tags.includes("supersedes:doc9"));
  assert.ok(!seen.some((s) => s.method === "DELETE"));
});

test("document search filters listed pages on title and tags and does not call a search endpoint", async () => {
  const { by, seen } = tools((req) => {
    const page = new URL(req.url).searchParams.get("page");
    if (page === "1") {
      return json(200, {
        documents: [
          { id: "1", title: "Alpha Contract", tags: [], content: "ignore" },
          { id: "2", title: "Beta Payroll", tags: ["finance"], content: "alpha appears only in the body" },
        ],
      });
    }
    return json(200, { documents: [{ id: "3", title: "Gamma Notes", tags: ["alpha-notes"] }] });
  });
  const r = await by("mind_remember").run({ action: "search", type: "document", query: "alpha", limit: 2 }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /Alpha Contract/);
  assert.match(r.output, /Gamma Notes/);
  assert.doesNotMatch(r.output, /Beta Payroll/);
  assert.match(r.output, /no document search endpoint/);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[1].method, "GET");
  assert.equal(seen[0].url, "https://m-i-n-d.ai/developer/v1/documents?page=1&page_size=2");
  assert.equal(seen[1].url, "https://m-i-n-d.ai/developer/v1/documents?page=2&page_size=2");
  for (const s of seen) {
    assert.ok(!s.url.includes("/search"));
    assert.ok(!s.url.includes("query="));
  }
});

test("plain create with no action posts the entry and tags origin:agent_inferred", async () => {
  const { by, seen } = tools(() => json(200, { id: "abc" }));
  const r = await by("mind_remember").run({ title: "t", content: "c", tags: ["a"], owner_check: OWNER }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /saved entry abc/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "https://m-i-n-d.ai/developer/v1/entries");
  assert.deepEqual(seen[0].body, { title: "t", content: "c", tags: ["a", "origin:agent_inferred"], source: "mindclaw" });
});

test("entry search and list hit the entry routes; feed_post is still refused", async () => {
  const { by, seen } = tools(() => json(200, { entries: [{ title: "Tea", entry_id: "e9" }] }));
  const t = by("mind_remember");
  const search = await t.run({ action: "search", query: "tea", limit: 5 }, ctx);
  assert.equal(search.ok, true, search.output);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, "https://m-i-n-d.ai/developer/v1/entries/search?query=tea&limit=5");
  const list = await t.run({ action: "list", limit: 4 }, ctx);
  assert.equal(list.ok, true, list.output);
  assert.equal(seen[1].url, "https://m-i-n-d.ai/developer/v1/entries?limit=4");
  const feed = await t.run({ type: "feed_post", title: "t", content: "c", owner_check: OWNER }, ctx);
  assert.equal(feed.ok, false);
  assert.match(feed.output, /mind_feed_post/);
  assert.equal(seen.length, 2);
});
