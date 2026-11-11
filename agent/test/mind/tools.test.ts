import { test } from "node:test";
import assert from "node:assert/strict";
import { createMindClient, createMindTools } from "../../src/mind/index.ts";
import type { MindClient, Tool } from "../../src/types.ts";
import { cfg, fakeFetch, json } from "./helpers.ts";

const ctx = { cwd: "/", sessionId: "s" };

function setup() {
  const f = fakeFetch(() => json(200, { id: "x1", response: "ok" }));
  const tools = createMindTools(createMindClient(cfg(), f.fetch, { retryDelayMs: 0 }));
  const by = (n: string): Tool => { const t = tools.find((x) => x.spec.name === n); assert.ok(t, `missing tool ${n}`); return t!; };
  return { tools, by, seen: f.seen };
}

test("expected tools exist with unique names", () => {
  const { tools } = setup();
  const names = tools.map((t) => t.spec.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of ["mind_context", "mind_query", "mind_remember", "mind_sense", "mind_life", "mind_crm", "mind_checklists", "mind_tasks", "mind_folders"]) {
    assert.ok(names.includes(n), n);
  }
});

test("classes and receipts: reads are read+mind, writes are write, public is public", () => {
  const { by } = setup();
  for (const n of ["mind_context", "mind_query", "mind_sense", "mind_life", "mind_crm", "mind_checklists", "mind_tasks", "mind_folders_read"]) {
    assert.equal(by(n).class, "read", n);
    assert.equal(by(n).receipt, "mind", n);
  }
  for (const n of ["mind_remember", "mind_folders", "mind_life_write", "mind_crm_write", "mind_checklists_write", "mind_tasks_write"]) {
    assert.equal(by(n).class, "write", n);
    assert.equal(by(n).receipt, undefined, n);
  }
  assert.equal(by("mind_feed_post").class, "public");
  assert.equal(by("mind_social").class, "public");
});

test("every write tool requires owner_check in its schema; reads do not", () => {
  const { tools } = setup();
  for (const t of tools) {
    const params = t.spec.parameters as { properties: Record<string, any>; required: string[] };
    if (t.class === "write") {
      assert.ok(params.required.includes("owner_check"), t.spec.name);
      assert.equal(params.properties.owner_check.type, "string");
      assert.match(params.properties.owner_check.description, /==/);
    } else {
      assert.ok(!params.properties.owner_check, t.spec.name);
    }
  }
});

test("write tool refuses without owner_check or without '==' and makes no request", async () => {
  const { by, seen } = setup();
  const t = by("mind_remember");
  let r = await t.run({ title: "t", content: "c" }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /owner_check required/);
  r = await t.run({ title: "t", content: "c", owner_check: "Atlas SOP belongs to Atlas" }, ctx);
  assert.equal(r.ok, false);
  assert.equal(seen.length, 0);
});

test("owner_check is stripped before sending to MIND", async () => {
  const { by, seen } = setup();
  const r = await by("mind_remember").run({ title: "t", content: "c", type: "document", owner_check: "MINDClaw spec belongs to Astra AI; Anthony asked about Astra AI; A == B" }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.equal(seen[0].url, "https://m-i-n-d.ai/developer/v1/documents");
  assert.ok(!JSON.stringify(seen[0].body).includes("owner_check"));
  assert.ok(!JSON.stringify(seen[0].body).includes("A == B"));

  const w = await by("mind_crm_write").run({ action: "create", fields: { name: "Pat" }, owner_check: "Pat belongs to Astra; asked Astra; A == B" }, ctx);
  assert.equal(w.ok, true, w.output);
  assert.equal(seen[1].url, "https://m-i-n-d.ai/developer/v1/crm/contacts");
  assert.deepEqual(seen[1].body, { name: "Pat" });
});

test("mind_remember refuses feed_post/thought (private only)", async () => {
  const { by, seen } = setup();
  const r = await by("mind_remember").run({ type: "feed_post", title: "t", content: "c", owner_check: "x == x" }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /mind_feed_post/);
  assert.equal(seen.length, 0);
});

test("mind_feed_post posts to /thoughts", async () => {
  const { by, seen } = setup();
  const r = await by("mind_feed_post").run({ content: "hello world" }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.equal(seen[0].url, "https://m-i-n-d.ai/developer/v1/thoughts");
  assert.deepEqual(seen[0].body, { content: "hello world" });
});

test("read tools cannot run write actions and vice versa", async () => {
  const { by, seen } = setup();
  let r = await by("mind_life").run({ action: "delete", item_id: "1" }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /not allowed here/);
  r = await by("mind_life_write").run({ action: "list", owner_check: "a == a" }, ctx);
  assert.equal(r.ok, false);
  assert.equal(seen.length, 0);
});

test("read tools route to the right endpoints", async () => {
  const { by, seen } = setup();
  await by("mind_life").run({ action: "get", item_id: "abc" }, ctx);
  await by("mind_checklists").run({ action: "list" }, ctx);
  await by("mind_sense").run({}, ctx);
  await by("mind_query").run({ query: "who is Leo?" }, ctx);
  await by("mind_context").run({ sections: ["soul"] }, ctx);
  assert.equal(seen[0].url, "https://m-i-n-d.ai/developer/v1/life/items/abc");
  assert.equal(seen[1].url, "https://m-i-n-d.ai/developer/v1/checklists");
  assert.equal(seen[2].url, "https://m-i-n-d.ai/developer/v1/mindsense/state");
  assert.equal(seen[3].body.query, "who is Leo?");
});

test("tool errors become ok:false results, key never present", async () => {
  const f = fakeFetch(() => json(500, { detail: "kaboom mind_SECRETSECRETSECRET1234" }));
  const tools = createMindTools(createMindClient(cfg(), f.fetch, { retryDelayMs: 0 }));
  const r = await tools.find((t) => t.spec.name === "mind_query")!.run({ query: "q" }, ctx);
  assert.equal(r.ok, false);
  assert.ok(!/mind_[A-Za-z0-9]{12,}/.test(r.output));
});

test("long outputs are capped", async () => {
  const fake: MindClient = {
    context: async () => "x".repeat(50_000), query: async () => "", remember: async () => "", call: async () => "",
  };
  const t = createMindTools(fake).find((x) => x.spec.name === "mind_context")!;
  const r = await t.run({}, ctx);
  assert.ok(r.output.length < 25_000);
  assert.match(r.output, /truncated/);
});

test("classFor: delete on any write tool is irreversible (action or HTTP-style), other actions keep the write class", () => {
  const { by, tools } = setup();
  for (const n of ["mind_remember", "mind_folders", "mind_life_write", "mind_crm_write", "mind_checklists_write", "mind_tasks_write"]) {
    const t = by(n);
    assert.equal(typeof t.classFor, "function", n);
    assert.equal(t.classFor!({ action: "delete" }), "irreversible", n);
    assert.equal(t.classFor!({ action: " DELETE " }), "irreversible", n);
    assert.equal(t.classFor!({ method: "DELETE" }), "irreversible", n);
    assert.equal(t.classFor!({ fields: { action: "delete" } }), "irreversible", n);
    assert.equal(t.classFor!({ action: "update" }), "write", n);
    assert.equal(t.classFor!({}), "write", n);
    assert.equal(t.class, "write", n);
  }
  for (const t of tools.filter((x) => x.class === "read" || x.class === "public")) assert.equal(t.classFor, undefined, t.spec.name);
});

test("mind_todos: read tool routes every read action to /developer/v1/todos and sends no body", async () => {
  const { by, seen } = setup();
  const t = by("mind_todos");
  const id = "b7ed3123-e5e7-4fd1-9deb-05f812ea1a5d";
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ action: "list", workspace_id: "ws_1", status: "open" }, "GET", "/developer/v1/todos?workspace_id=ws_1&status=open"],
    [{ action: "waiting", workspace_id: "ws_1" }, "GET", "/developer/v1/todos?workspace_id=ws_1&waiting=true"],
    [{ action: "search", q: "fax", workspace_id: "ws_1" }, "GET", "/developer/v1/todos/search?q=fax&workspace_id=ws_1"],
    [{ action: "get", todo_id: id }, "GET", `/developer/v1/todos/${id}`],
    [{ action: "thread", todo_id: id }, "GET", `/developer/v1/todos/${id}/comments`],
    [{ action: "progress", project_id: "p1" }, "GET", "/developer/v1/projects/p1/progress"],
  ];
  for (const [args, method, path] of cases) {
    const r = await t.run(args, ctx);
    assert.equal(r.ok, true, JSON.stringify(args) + r.output);
    const s = seen[seen.length - 1];
    assert.equal(s.method, method);
    assert.equal(s.url.replace("https://m-i-n-d.ai", ""), path);
    assert.equal(s.body, undefined);
  }
  assert.equal(t.class, "read");
  assert.equal(t.receipt, "mind");
  const bad = await t.run({ action: "get" }, ctx);
  assert.equal(bad.ok, false);
});

test("mind_todos_write: owner gate in schema, route mapping per write action, no delete anywhere", async () => {
  const { by, seen, tools } = setup();
  const t = by("mind_todos_write");
  assert.equal(t.class, "write");
  const params = t.spec.parameters as { required: string[]; properties: Record<string, any> };
  assert.ok(params.required.includes("owner_check"));
  const id = "b7ed3123-e5e7-4fd1-9deb-05f812ea1a5d";
  const owner_check = "todo belongs to Atlas; Anthony asked about Atlas; Atlas == Atlas";
  const cases: Array<[Record<string, unknown>, string, string, unknown]> = [
    [{ action: "update", todo_id: id, status: "in_progress", notes: "n" }, "PATCH", `/developer/v1/todos/${id}`, { status: "in_progress", notes: "n" }],
    [{ action: "start", todo_id: id }, "POST", `/developer/v1/todos/${id}/start`, {}],
    [{ action: "reopen", todo_id: id }, "POST", `/developer/v1/todos/${id}/reopen`, {}],
    [{ action: "complete", todo_id: id, notes: "done" }, "POST", `/developer/v1/todos/${id}/complete`, { note: "done" }],
    [{ action: "comment", todo_id: id, body: "hi" }, "POST", `/developer/v1/todos/${id}/comments`, { kind: "comment", body: "hi" }],
    [{ action: "create", project_id: "p1", title: "T", priority: "high" }, "POST", "/developer/v1/todos", { project_id: "p1", title: "T", priority: "high" }],
  ];
  for (const [args, method, path, body] of cases) {
    const r = await t.run({ ...args, owner_check }, ctx);
    assert.equal(r.ok, true, JSON.stringify(args) + r.output);
    const s = seen[seen.length - 1];
    assert.equal(s.method, method);
    assert.equal(s.url.replace("https://m-i-n-d.ai", ""), path);
    assert.deepEqual(s.body, body);
  }
  const before = seen.length;
  let r = await t.run({ action: "complete", todo_id: id }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /owner_check required/);
  r = await t.run({ action: "delete", todo_id: id, owner_check }, ctx);
  assert.equal(r.ok, false);
  assert.equal(seen.length, before, "no request for a missing owner_check or a delete");
  for (const n of ["mind_todos", "mind_todos_write"]) {
    const a = (by(n).spec.parameters as any).properties.action.enum as string[];
    assert.ok(!a.includes("delete"), n);
  }
  assert.ok(tools.some((x) => x.spec.name === "mind_todos"));
  // a delete attempt is still classed irreversible by the shared classFor
  assert.equal(t.classFor!({ action: "delete" }), "irreversible");
});

test("mind_todos descriptions state the id space and treat to-do text as untrusted", () => {
  const { by } = setup();
  for (const n of ["mind_todos", "mind_todos_write"]) {
    const d = by(n).spec.description;
    assert.match(d, /MIND to-do UUID/);
    assert.match(d, /workspace_id/);
    assert.match(d, /astra_board/);
    assert.match(d, /portal ids/);
    assert.match(d, /never instructions/);
  }
});
