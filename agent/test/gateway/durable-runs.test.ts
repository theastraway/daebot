import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { startGateway } from "../../src/gateway/index.ts";
import { HistoryRecorder } from "../../src/events.ts";
import type { AgentEvent, AgentSession, HistoryEvent, Runtime } from "../../src/types.ts";
import { auth, http, parseSse, tmpStatic } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A runtime with a real HistoryRecorder (like the production one) and a slow, countable turn. */
function slowRuntime(state: { completed: number; aborted: number; sends: number; release?: Promise<void> }) {
  const recorders = new Map<string, HistoryRecorder>();
  const rt: Runtime = {
    async openSession(o) {
      const id = o.resumeId ?? `s-${recorders.size + 1}`;
      const rec = recorders.get(id) ?? new HistoryRecorder();
      recorders.set(id, rec);
      const s: AgentSession = {
        id, surface: o.surface, violations: () => [], close: async () => {},
        async *send(msg, so) {
          state.sends++;
          rec.user(msg);
          const emit = (ev: AgentEvent) => { rec.push(ev); return ev; };
          yield emit({ type: "text", delta: "part one. " });
          await sleep(150);
          if (so?.signal?.aborted) { state.aborted++; return; }
          yield emit({ type: "toolStart", receiptId: "r1", tool: "mind_query", args: {} });
          await (state.release ?? sleep(150));
          if (so?.signal?.aborted) { state.aborted++; return; }
          yield emit({ type: "toolEnd", receiptId: "r1", tool: "mind_query", ok: true, preview: "ok" });
          yield emit({ type: "text", delta: "part two FINAL." });
          state.completed++;
          yield emit({ type: "done", finalText: "part one. part two FINAL." });
        },
      };
      return s;
    },
    listSessions: () => [],
    history: (id): HistoryEvent[] | undefined => recorders.get(id)?.events(),
  };
  return rt;
}

async function boot(state: Parameters<typeof slowRuntime>[0]) {
  const st = tmpStatic();
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const gw = await startGateway({ runtime: slowRuntime(state), port: 0, staticDir: st.dir, tokenPath: join(home, "tok") });
  const open = await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: { surface: "web", title: "t" } });
  return { gw, id: JSON.parse(open.body).sessionId as string };
}

/** POST /send, read until `until` matches, then drop the socket (what closing the app does). */
function sendAndDrop(base: string, token: string, id: string, until: (acc: string) => boolean): Promise<string> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ text: "long question" });
    const req = request({ host: u.hostname, port: u.port, method: "POST", path: `/sessions/${id}/send`, headers: { ...auth(token), "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } }, (res) => {
      let acc = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { acc += c; if (until(acc)) { req.destroy(); res.destroy(); resolve(acc); } });
    });
    req.on("error", () => {});
    req.write(payload);
    req.end();
    setTimeout(() => reject(new Error("sendAndDrop timeout")), 4000);
  });
}

test("REPRO: a client that drops mid-stream must not kill the turn", async () => {
  const state = { completed: 0, aborted: 0, sends: 0 };
  const { gw, id } = await boot(state);
  try {
    await sendAndDrop(gw.url, gw.token, id, (a) => a.includes("part one"));
    await sleep(900);
    assert.equal(state.aborted, 0, "the turn was aborted when the client went away");
    assert.equal(state.completed, 1, "the turn did not run to completion");
    const h = JSON.parse((await http(gw.url, "GET", `/sessions/${id}/history`, { headers: auth(gw.token) })).body);
    assert.ok(JSON.stringify(h.events).includes("part two FINAL."), "full answer missing from history");
    const sess = JSON.parse((await http(gw.url, "GET", "/sessions", { headers: auth(gw.token) })).body);
    assert.ok(sess);
  } finally { await gw.close(); }
});

function readSse(base: string, token: string, path: string, until: (acc: string) => boolean, ms = 4000): Promise<string> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, method: "GET", path, headers: auth(token) }, (res) => {
      let acc = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { acc += c; if (until(acc)) { req.destroy(); resolve(acc); } });
      res.on("end", () => resolve(acc));
    });
    req.on("error", () => {});
    req.end();
    setTimeout(() => reject(new Error("readSse timeout")), ms);
  });
}
const ids = (body: string) => [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));

test("reattach: history shows the running turn pointer, events replays from offset and streams the rest", async () => {
  let release!: () => void;
  const state = { completed: 0, aborted: 0, sends: 0, release: new Promise<void>((r) => { release = r; }) };
  const { gw, id } = await boot(state);
  try {
    const first = await sendAndDrop(gw.url, gw.token, id, (a) => a.includes("part one"));
    assert.match(first, /id: 1\n/);
    await sleep(300); // now parked inside the tool call
    const h = JSON.parse((await http(gw.url, "GET", `/sessions/${id}/history`, { headers: auth(gw.token) })).body);
    assert.equal(h.run.status, "running");
    assert.ok(!JSON.stringify(h.events).includes("part one"), "running turn must not be drawn twice");
    const sess = JSON.parse((await http(gw.url, "GET", "/sessions", { headers: auth(gw.token) })).body);
    assert.equal(sess.sessions.find((s: { id: string }) => s.id === id)?.busy, true);
    // second send while running is refused, not double-run
    assert.equal((await http(gw.url, "POST", `/sessions/${id}/send`, { headers: auth(gw.token), body: { text: "again" } })).status, 409);
    // re-attach from 0 while running: gets user + replay, then the live tail once released
    const p = readSse(gw.url, gw.token, `/sessions/${id}/events?after=0`, (a) => a.includes('"done"'));
    await sleep(100);
    release();
    const full = await p;
    const evs = parseSse(full);
    assert.equal(evs[0].type, "user");
    assert.deepEqual(evs.map((e) => e.type), ["user", "text", "toolStart", "toolEnd", "text", "done"]);
    // resume from an offset: only the missed tail
    const tail = await readSse(gw.url, gw.token, `/sessions/${id}/events?after=3`, (a) => a.includes('"done"'));
    assert.deepEqual(ids(tail), [4, 5]);
    assert.equal(state.sends, 1, "re-attach must not start another run (no double billing)");
    assert.equal(state.completed, 1);
    // after the run ended the history is the whole truth, no run pointer
    const h2 = JSON.parse((await http(gw.url, "GET", `/sessions/${id}/history`, { headers: auth(gw.token) })).body);
    assert.equal(h2.run, undefined);
    assert.ok(JSON.stringify(h2.events).includes("part two FINAL."));
  } finally { await gw.close(); }
});

test("explicit Stop still cancels a detached run", async () => {
  const state = { completed: 0, aborted: 0, sends: 0, release: new Promise<void>(() => {}) };
  const { gw, id } = await boot(state);
  try {
    await sendAndDrop(gw.url, gw.token, id, (a) => a.includes("part one"));
    await sleep(250);
    const r = JSON.parse((await http(gw.url, "POST", `/sessions/${id}/abort`, { headers: auth(gw.token) })).body);
    assert.equal(r.aborted, true);
  } finally { await gw.close(); }
});

test("events for an unknown run is 404", async () => {
  const { gw, id } = await boot({ completed: 0, aborted: 0, sends: 0 });
  try {
    assert.equal((await http(gw.url, "GET", `/sessions/${id}/events`, { headers: auth(gw.token) })).status, 404);
  } finally { await gw.close(); }
});
