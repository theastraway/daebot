import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfirmWatcher } from "../src/lib/watcher.mjs";

function rig(sessions) {
  const sent = [];
  const socks = [];
  const confirms = [];
  const w = new ConfirmWatcher({
    listSessions: async () => sessions(),
    connect: () => { const s = { send: (t) => sent.push(JSON.parse(t)), close() { s.closed = true; }, onmessage: null, onclose: null }; socks.push(s); return s; },
    onConfirm: (e, sid) => confirms.push([e, sid]),
    pollMs: 1e9,
  });
  return { w, sent, socks, confirms };
}
const frame = (sid, event) => JSON.stringify({ t: "event", sessionId: sid, event });

test("subscribes to each LIVE session once by resuming its id", async () => {
  const r = rig(() => [{ id: "a", live: true }, { id: "b", live: false }]);
  r.w.start();
  await r.w.tick(); await r.w.tick();
  r.w.stop();
  assert.deepEqual(r.sent, [{ t: "open", surface: "desktop-watch", resumeId: "a" }]);
});

test("forwards confirm events (deduped by session+id) and ignores other frames", async () => {
  const r = rig(() => [{ id: "a", live: true }]);
  r.w.start();
  await r.w.tick();
  const s = r.socks[0];
  const c = { type: "confirm", id: "k1", tool: "send_email", args: {}, reason: "go?" };
  s.onmessage(frame("a", { type: "text", delta: "hi" }));
  s.onmessage("not json");
  s.onmessage(JSON.stringify({ t: "opened", sessionId: "a" }));
  s.onmessage(frame("a", c));
  s.onmessage(frame("a", c));
  s.onmessage(frame("a", { ...c, id: "k2" }));
  s.onmessage(frame("b", c));
  r.w.stop();
  assert.deepEqual(r.confirms.map(([e, sid]) => `${sid}:${e.id}`), ["a:k1", "a:k2", "b:k1"]);
});

test("reconnects after the socket closes and re-subscribes", async () => {
  const r = rig(() => [{ id: "a", live: true }]);
  r.w.start();
  await r.w.tick();
  r.socks[0].onclose();
  await r.w.tick();
  r.w.stop();
  assert.equal(r.socks.length, 2);
  assert.equal(r.sent.length, 2);
  assert.ok(r.socks[1].closed);
});

test("a failing session list or throwing onConfirm never kills the watcher; stop is final", async () => {
  let fail = true;
  const confirms = [];
  const socks = [];
  const w = new ConfirmWatcher({
    listSessions: async () => { if (fail) throw new Error("down"); return [{ id: "a", live: true }]; },
    connect: () => { const s = { send() {}, close() {}, onmessage: null, onclose: null }; socks.push(s); return s; },
    onConfirm: () => { confirms.push(1); throw new Error("toast failed"); },
    pollMs: 1e9,
  });
  w.start();
  await w.tick();
  fail = false;
  await w.tick();
  socks[0].onmessage(frame("a", { type: "confirm", id: "z", tool: "t", reason: "r" }));
  assert.equal(confirms.length, 1);
  w.stop();
  await w.tick();
  assert.equal(socks.length, 1, "no reconnect after stop");
});
