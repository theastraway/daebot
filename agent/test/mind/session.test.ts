import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionSync } from "../../src/mind/index.ts";
import type { MindClient } from "../../src/types.ts";

interface Rec { tool: string; args: Record<string, any> }

function fakeClient(handler: (r: Rec, n: number) => unknown) {
  const calls: Rec[] = [];
  const client: MindClient = {
    context: async () => "", query: async () => "", remember: async () => "",
    call: async (tool, args) => {
      const r = { tool, args };
      calls.push(r);
      const out = handler(r, calls.length);
      if (out instanceof Error) throw out;
      return JSON.stringify(out ?? {});
    },
  };
  return { client, calls };
}

const open = (a: Rec) => a.args.action === "open";

test("open sends source_key + title, idempotent on repeat", async () => {
  const { client, calls } = fakeClient(() => ({ session_id: "S1" }));
  const s = createSessionSync(client, "mindclaw-agent-test");
  await s.open({ title: "Test session", sourceKey: "mindclaw-agent-test" });
  await s.open({ title: "Test session", sourceKey: "mindclaw-agent-test" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "agent_sessions");
  assert.equal(calls[0].args.source_key, "mindclaw-agent-test");
  assert.equal(calls[0].args.external_session_id, "mindclaw-agent-test");
  assert.equal(calls[0].args.title, "Test session");
});

test("never logs an unnamed session", async () => {
  const { client, calls } = fakeClient(() => ({}));
  const s = createSessionSync(client, "k");
  await assert.rejects(() => s.open({ title: "   ", sourceKey: "k" }), /unnamed/);
  await assert.rejects(() => s.append("user", "hi"), /not opened/);
  assert.equal(calls.length, 0);
});

test("append posts messages to the session id; title only on the first append", async () => {
  const { client, calls } = fakeClient((r) => (open(r) ? { session_id: "S1" } : {}));
  const s = createSessionSync(client, "k");
  await s.open({ title: "T", sourceKey: "k" });
  await s.append("user", "hello");
  await s.append("assistant", "hi there");
  assert.equal(calls[1].args.action, "append");
  assert.equal(calls[1].args.session_id, "S1");
  assert.deepEqual(calls[1].args.messages, [{ role: "user", content: "hello" }]);
  assert.equal(calls[1].args.title, "T");
  assert.equal(calls[2].args.title, undefined);
});

test("append redacts secrets", async () => {
  const { client, calls } = fakeClient((r) => (open(r) ? { session_id: "S1" } : {}));
  const s = createSessionSync(client, "k");
  await s.open({ title: "T", sourceKey: "k" });
  await s.append("user", "my api_key=SUPERSECRET and mind_ABCDEFGHIJKLMNOP1234");
  const content = calls[1].args.messages[0].content;
  assert.ok(!content.includes("SUPERSECRET"));
  assert.ok(!content.includes("mind_ABCDEFGHIJKLMNOP1234"));
});

test("append failures are swallowed and queued, then flushed on the next success", async () => {
  let failing = true;
  const { client, calls } = fakeClient((r) => {
    if (open(r)) return { session_id: "S1" };
    return failing ? new Error("network down") : {};
  });
  const s = createSessionSync(client, "k");
  await s.open({ title: "T", sourceKey: "k" });
  await s.append("user", "one");           // does not throw
  await s.append("assistant", "two");
  failing = false;
  await s.append("user", "three");
  const last = calls[calls.length - 1];
  assert.deepEqual(last.args.messages.map((m: any) => m.content), ["one", "two", "three"]);
  failing = true;
  await s.append("user", "four");          // ok again? queue only has "four" after success flush
  failing = false;
  await s.append("user", "five");
  assert.deepEqual(calls[calls.length - 1].args.messages.map((m: any) => m.content), ["four", "five"]);
});

test("retry queue is capped at 50, dropping the oldest", async () => {
  const { client, calls } = fakeClient((r) => (open(r) ? { session_id: "S1" } : new Error("down")));
  const s = createSessionSync(client, "k");
  await s.open({ title: "T", sourceKey: "k" });
  for (let i = 0; i < 70; i++) await s.append("user", `m${i}`);
  const lastFailed = calls[calls.length - 1].args.messages;
  assert.equal(lastFailed.length, 50);
  assert.equal(lastFailed[0].content, "m20");
  assert.equal(lastFailed[49].content, "m69");
});

test("open failure is swallowed; the first append retries the open", async () => {
  let n = 0;
  const { client, calls } = fakeClient((r) => {
    if (open(r)) { n++; return n === 1 ? new Error("502") : { session_id: "S9" }; }
    return {};
  });
  const s = createSessionSync(client, "k");
  await s.open({ title: "T", sourceKey: "k" });   // no throw
  await s.append("user", "late");
  const app = calls.find((c) => c.args.action === "append")!;
  assert.equal(app.args.session_id, "S9");
  assert.equal(app.args.messages[0].content, "late");
});

test("pendingReplies returns only unseen replies, once", async () => {
  let k = 0;
  const { client } = fakeClient((r) => {
    if (open(r)) return { session_id: "S1", pending_replies: [{ id: "r1", content: "first from Anthony" }] };
    k++;
    return k === 1
      ? { pending_replies: [{ id: "r1", content: "first from Anthony" }, { id: "r2", content: "second", meta: { replied_by: "Lance" } }] }
      : { pending_replies: [{ id: "r2", content: "second" }] };
  });
  const s = createSessionSync(client, "k");
  await s.open({ title: "T", sourceKey: "k" });
  await s.append("user", "a");
  assert.deepEqual(await s.pendingReplies(), ["first from Anthony", "[Lance] second"]);
  assert.deepEqual(await s.pendingReplies(), []);
  await s.append("user", "b");
  assert.deepEqual(await s.pendingReplies(), []);  // r2 already seen
});

test("close flushes the queue then posts summary with status ended; failures swallowed", async () => {
  const { client, calls } = fakeClient((r) => (open(r) ? { session_id: "S1" } : {}));
  const s = createSessionSync(client, "k");
  await s.open({ title: "T", sourceKey: "k" });
  await s.close("did the thing");
  const c = calls[calls.length - 1];
  assert.equal(c.args.action, "close");
  assert.equal(c.args.session_id, "S1");
  assert.equal(c.args.status, "ended");
  assert.equal(c.args.summary, "did the thing");
  const bad = fakeClient((r) => (open(r) ? { session_id: "S1" } : new Error("down")));
  const s2 = createSessionSync(bad.client, "k");
  await s2.open({ title: "T", sourceKey: "k" });
  await s2.close("x");   // does not throw
});

test("open: externalId overrides external_session_id while source_key stays", async () => {
  const { client, calls } = fakeClient(() => ({ session_id: "S1" }));
  const s = createSessionSync(client, "mindclaw-web-abc");
  await s.open({ title: "T", sourceKey: "mindclaw-web-abc", externalId: "uuid-123" });
  assert.equal(calls[0].args.source_key, "mindclaw-web-abc");
  assert.equal(calls[0].args.external_session_id, "uuid-123");
});
