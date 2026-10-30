import { test } from "node:test";
import assert from "node:assert/strict";
import { startGateway } from "../../src/gateway/index.ts";
import { HistoryRecorder } from "../../src/events.ts";
import type { AgentEvent, AgentSession, HistoryEvent, Runtime } from "../../src/types.ts";
import { auth, http, tmpStatic } from "./helpers.ts";

/** A runtime that counts how it is read: the history route must use ONE combined read, not history() + messageMeta(). */
function countingRuntime(reads: { combined: number; history: number; meta: number }) {
  const rec = new HistoryRecorder();
  const rt: Runtime = {
    async openSession(o: { surface: string; resumeId?: string }) {
      const id = o.resumeId ?? "s-1";
      const s: AgentSession = {
        id, surface: o.surface, violations: () => [], close: async () => {},
        async *send(msg) {
          rec.user(msg);
          const ev: AgentEvent = { type: "text", delta: "answer" };
          rec.push(ev); yield ev;
          const d: AgentEvent = { type: "done", finalText: "answer" };
          rec.push(d); yield d;
        },
      };
      return s;
    },
    listSessions: () => [],
    history: (): HistoryEvent[] => { reads.history++; return rec.events(); },
    messageMeta: () => { reads.meta++; return { messages: {} }; },
    historyWithMeta: () => { reads.combined++; return { events: rec.events(), meta: { messages: {} }, live: true }; },
  } as unknown as Runtime;
  return rt;
}

test("GET history: one combined read, an ETag, and a 304 for an unchanged transcript", async () => {
  const reads = { combined: 0, history: 0, meta: 0 };
  const { dir } = tmpStatic();
  const gw = await startGateway({ runtime: countingRuntime(reads), staticDir: dir, port: 0, token: "t".repeat(24) } as never);
  try {
    const { sessionId } = JSON.parse((await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: { surface: "web" } })).body);
    await http(gw.url, "POST", `/sessions/${sessionId}/send`, { headers: auth(gw.token), body: { text: "hello" } });
    await new Promise((r) => setTimeout(r, 100));
    const first = await http(gw.url, "GET", `/sessions/${sessionId}/history`, { headers: auth(gw.token) });
    assert.equal(first.status, 200);
    const etag = String(first.headers.etag);
    assert.match(etag, /^"[A-Za-z0-9_-]{22}"$/);
    assert.equal(reads.combined, 1);
    assert.equal(reads.history + reads.meta, 0, "history() and messageMeta() are not called separately any more");
    const again = await http(gw.url, "GET", `/sessions/${sessionId}/history`, { headers: { ...auth(gw.token), "if-none-match": etag } });
    assert.equal(again.status, 304);
    assert.equal(again.body, "");
    const weak = await http(gw.url, "GET", `/sessions/${sessionId}/history`, { headers: { ...auth(gw.token), "if-none-match": `W/${etag}` } });
    assert.equal(weak.status, 304, "a proxy that weakens the tag still matches");
    await http(gw.url, "POST", `/sessions/${sessionId}/send`, { headers: auth(gw.token), body: { text: "again" } });
    await new Promise((r) => setTimeout(r, 100));
    const changed = await http(gw.url, "GET", `/sessions/${sessionId}/history`, { headers: { ...auth(gw.token), "if-none-match": etag } });
    assert.equal(changed.status, 200, "a changed transcript gets the full body");
    assert.notEqual(String(changed.headers.etag), etag);
  } finally { await gw.close(); }
});
