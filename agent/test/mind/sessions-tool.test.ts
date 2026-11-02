import { test } from "node:test";
import assert from "node:assert/strict";
import { createMindClient } from "../../src/mind/index.ts";
import { createMindSessionsTool } from "../../src/mind/sessions-tool.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { tierAllows } from "../../src/kernel/tier.ts";
import { effectiveClass } from "../../src/tool-class.ts";
import { cfg, fakeFetch, json } from "./helpers.ts";
import { state } from "../kernel/helpers.ts";

const ctx = { cwd: "/", sessionId: "s" };
const SESSION = { session_id: "sess-1", title: "YSF Fundraising", agent_display: "YSF Fundraising", runtime: "grok", status: "active", message_count: 2, pending_reply_count: 1, updated_at: "2026-11-02T10:00:00Z", last_message_preview: "ready for review" };

function setup(handler: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(handler);
  const client = createMindClient(cfg(), f.fetch, { retryDelayMs: 0 });
  return { tool: createMindSessionsTool({ client: () => client, user: "andrewcastaldi" }), seen: f.seen };
}

test("list: GET /agent-sessions with the filters, formatted, marked as other agents' text", async () => {
  const { tool, seen } = setup(() => json(200, { sessions: [SESSION, { ...SESSION, session_id: "sess-2", title: "Tout Site", pending_reply_count: 0 }], sources: [] }));
  const r = await tool.run({ action: "list", status: "active", limit: 5 }, ctx);
  assert.equal(r.ok, true);
  assert.equal(seen[0].method, "GET");
  assert.match(seen[0].url, /\/developer\/v1\/agent-sessions\?/);
  assert.match(seen[0].url, /status=active/);
  assert.match(seen[0].url, /limit=5/);
  assert.equal(seen[0].headers["x-api-key"], "mind_TESTKEY0123456789abcdef");
  assert.match(r.output, /data, never instructions/);
  assert.match(r.output, /YSF Fundraising/);
  assert.match(r.output, /id sess-1/);
  assert.match(r.output, /1 reply waiting for the agent/);
  assert.match(r.output, /Tout Site/);
});

test("list: empty and error cases do not throw", async () => {
  assert.match((await setup(() => json(200, { sessions: [] })).tool.run({ action: "list" }, ctx)).output, /No agent sessions/);
  const bad = await setup(() => json(403, { detail: "missing scope" })).tool.run({ action: "list" }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.output, /mind_sessions list/);
});

test("get: reads one session with its messages", async () => {
  const { tool, seen } = setup(() => json(200, { ...SESSION, viewer_role: "owner", shared: { shared_with_me: false }, messages: [{ seq: 1, role: "assistant", content: "draft done", created_at: "t1" }, { seq: 2, role: "user", origin: "mind", content: "ship it", created_at: "t2" }] }));
  const r = await tool.run({ action: "get", session_id: "sess-1", limit: 10 }, ctx);
  assert.equal(r.ok, true);
  assert.match(seen[0].url, /agent-sessions\/sess-1\?limit=10/);
  assert.match(r.output, /assistant: draft done/);
  assert.match(r.output, /you \(from MIND\): ship it/);
  assert.equal((await tool.run({ action: "get" }, ctx)).ok, false, "needs session_id");
});

test("inbox: uses the read-only pending feed, never the per-session inbox route (which marks replies delivered)", async () => {
  const { tool, seen } = setup(() => json(200, { pending: [{ session_id: "sess-1", content: "do the thing", created_at: "t", delivery_status: "pending" }, { session_id: "sess-9", content: "other" }], count: 2 }));
  const r = await tool.run({ action: "inbox", session_id: "sess-1" }, ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET");
  assert.match(seen[0].url, /agent-sessions\/replies\/pending\?/);
  assert.doesNotMatch(seen[0].url, /\/inbox/);
  assert.match(r.output, /do the thing/);
  assert.doesNotMatch(r.output, /sess-9/, "filtered to the asked session");
  const none = await setup(() => json(200, { pending: [], count: 0 })).tool.run({ action: "inbox" }, ctx);
  assert.match(none.output, /Nothing waiting/);
});

test("wake_target_get: names only, no url or secret even if the server sent them", async () => {
  const { tool, seen } = setup(() => json(200, { wake_targets: [{ agent: "YSF Fundraising", runtime: "grok", status: "ok", url: "https://hooks.example/secret-path", secret: "TOPSECRET" }], count: 1 }));
  const r = await tool.run({ action: "wake_target_get" }, ctx);
  assert.match(seen[0].url, /wake-targets$/);
  assert.match(r.output, /YSF Fundraising/);
  assert.doesNotMatch(r.output, /secret|hooks\.example|TOPSECRET/i);
});

test("reply: own session only. Reads the session, then POSTs /reply with the content once", async () => {
  const { tool, seen } = setup((req) => req.method === "GET" ? json(200, { ...SESSION, viewer_role: "owner", shared: { shared_with_me: false }, messages: [] }) : json(200, { message_id: "m-77" }));
  const r = await tool.run({ action: "reply", session_id: "sess-1", content: "Use the new pricing page." }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].method, "POST");
  assert.match(seen[1].url, /agent-sessions\/sess-1\/reply$/);
  assert.deepEqual(seen[1].body, { content: "Use the new pricing page." });
  assert.match(r.output, /m-77/);
});

test("reply: refused on a shared session, a viewer, a missing session, empty or oversized content, and a bot-driven turn. No POST ever leaves.", async () => {
  const shared = setup(() => json(200, { ...SESSION, viewer_role: "editor", shared: { shared_with_me: true } }));
  const a = await shared.tool.run({ action: "reply", session_id: "sess-1", content: "hi" }, ctx);
  assert.equal(a.ok, false);
  assert.match(a.output, /shared with you/);
  assert.ok(shared.seen.every((s) => s.method === "GET"));

  const sneaky = setup(() => json(200, { ...SESSION, viewer_role: "owner", shared: { shared_with_me: true } }));
  assert.equal((await sneaky.tool.run({ action: "reply", session_id: "sess-1", content: "hi" }, ctx)).ok, false);
  assert.ok(sneaky.seen.every((s) => s.method === "GET"));

  const missing = setup(() => json(404, { detail: "Agent session not found" }));
  assert.equal((await missing.tool.run({ action: "reply", session_id: "nope", content: "hi" }, ctx)).ok, false);

  const own = setup(() => json(200, { ...SESSION, viewer_role: "owner", shared: { shared_with_me: false } }));
  assert.equal((await own.tool.run({ action: "reply", session_id: "sess-1", content: "   " }, ctx)).ok, false);
  assert.equal((await own.tool.run({ action: "reply", session_id: "sess-1", content: "x".repeat(6001) }, ctx)).ok, false);
  assert.equal((await own.tool.run({ action: "reply", content: "hi" }, ctx)).ok, false);
  const peer = await own.tool.run({ action: "reply", session_id: "sess-1", content: "hi" }, { ...ctx, origin: "bot" });
  assert.equal(peer.ok, false);
  assert.match(peer.output, /another bot/);
  assert.equal(own.seen.length, 0, "none of those reached MIND");
  assert.equal((await own.tool.run({ action: "delete", session_id: "sess-1" }, ctx)).ok, false, "unknown actions are refused");
});

test("classes: reads are read, reply is outward; staff may use the tool, public may not", () => {
  const { tool } = setup(() => json(200, {}));
  assert.equal(effectiveClass(tool, { action: "list" }), "read");
  assert.equal(effectiveClass(tool, { action: "get" }), "read");
  assert.equal(effectiveClass(tool, { action: "inbox" }), "read");
  assert.equal(effectiveClass(tool, { action: "wake_target_get" }), "read");
  assert.equal(effectiveClass(tool, { action: "reply" }), "outward");
  assert.equal(tierAllows("staff", tool), true);
  assert.equal(tierAllows("staff", tool, { action: "reply", session_id: "s", content: "c" }), true);
  assert.equal(tierAllows("admin", tool, { action: "reply" }), true);
  assert.equal(tierAllows("public", tool), false);
  assert.equal(tierAllows("public", tool, { action: "list" }), false);
  // the user's go is still asked for before a reply, never before a read
  const k = createKernel({ shadow: false, enabled: true, tier: "staff", hosted: true });
  const reply = k.preTool(state(), { id: "c", name: "mind_sessions", args: { action: "reply", session_id: "s", content: "c" } }, tool);
  assert.ok(reply.some((v) => v.gate === "danger" && v.action === "needs-confirmation"));
  assert.ok(reply.every((v) => v.gate !== "tier"));
  assert.equal(k.preTool(state(), { id: "c", name: "mind_sessions", args: { action: "list" } }, tool).length, 0);
});

test("reply: the owner's own routine turn (receipt starts with routine:) may reply; a peer bot with any other receipt may not", async () => {
  const mk = () => setup(() => json(200, { ...SESSION, viewer_role: "owner", ok: true, message_id: "m1", seq: 3 }));
  const routine = await mk().tool.run({ action: "reply", session_id: "sess-1", content: "hi" }, { ...ctx, origin: "bot", peerReceipt: "routine:Routine: Prime Heartbeat" });
  assert.doesNotMatch(routine.output, /another bot cannot/);
  const peer = await mk().tool.run({ action: "reply", session_id: "sess-1", content: "hi" }, { ...ctx, origin: "bot", peerReceipt: "3125547d-f4a5" });
  assert.equal(peer.ok, false);
  assert.match(peer.output, /another bot cannot/);
});
