// Gateway additions: model in /health, X-Robots-Tag + robots.txt (hosted), /sessions/:id/history, no empty rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { SessionManager } from "../../src/gateway/sessions.ts";
import { loadConfig } from "../../src/config.ts";
import type { AgentSession, HistoryEvent, Runtime } from "../../src/types.ts";
import { auth, fakeRuntime, http, parseSse, tmpStatic } from "./helpers.ts";

const cfg = loadConfig({ MINDCLAW_CONFIG: "/nonexistent.json", MINDCLAW_MODEL: "qwen/qwen3.8-flash" });

test("local /health reports the model and provider", async () => {
  const st = tmpStatic();
  const gw = await startGateway({ runtime: fakeRuntime(), cfg, port: 0, staticDir: st.dir, tokenPath: join(st.dir, "..", "tok") });
  try {
    const r = await http(gw.url, "GET", "/health");
    const j = JSON.parse(r.body);
    assert.equal(j.model, "qwen/qwen3.8-flash");
    assert.equal(j.provider, "openrouter");
  } finally { await gw.close(); }
});

test("hosted: every response is noindex, /robots.txt disallows all without a login, /health names the model", async () => {
  const st = tmpStatic();
  writeFileSync(join(st.dir, "login.html"), "<!doctype html><title>login</title>");
  const token = randomBytes(18).toString("hex");
  const gw = await startGateway({ runtime: fakeRuntime(), cfg, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: { token, allowedHosts: ["daebot.live"] } });
  const H = { host: "daebot.live", "x-forwarded-proto": "https" };
  try {
    const robots = await http(gw.url, "GET", "/robots.txt", { headers: H });
    assert.equal(robots.status, 200);
    assert.equal(robots.body, "User-agent: *\nDisallow: /\n");
    for (const [path, headers] of [["/robots.txt", H], ["/health", { host: "other.example" }], ["/", H], ["/sessions", H], ["/nope", H]] as const) {
      const r = await http(gw.url, "GET", path, { headers: { ...headers } });
      assert.equal(r.headers["x-robots-tag"], "noindex, nofollow", `${path} -> ${r.status}`);
    }
    const bad = await http(gw.url, "GET", "/", { headers: { host: "evil.example" } });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers["x-robots-tag"], "noindex, nofollow", "even refusals carry it");
    const health = JSON.parse((await http(gw.url, "GET", "/health", { headers: H })).body);
    assert.deepEqual([health.model, health.provider, health.hosted], ["qwen/qwen3.8-flash", "openrouter", true]);
  } finally { await gw.close(); }
});

test("GET /sessions/:id/history serves the visible transcript, live or not, 404 for unknown", async () => {
  const st = tmpStatic();
  const saved: HistoryEvent[] = [{ type: "user", text: "hi" }, { type: "text", delta: "hello" }, { type: "done", finalText: "hello" }];
  const base = fakeRuntime();
  const runtime: Runtime = { ...base, openSession: base.openSession, listSessions: () => [], history: (id) => (id === "saved-1" ? saved : undefined) };
  const gw = await startGateway({ runtime, cfg, port: 0, staticDir: st.dir, tokenPath: join(st.dir, "..", "tok2") });
  try {
    assert.equal((await http(gw.url, "GET", "/sessions/saved-1/history")).status, 401);
    const ok = await http(gw.url, "GET", "/sessions/saved-1/history", { headers: auth(gw.token) });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body).events, saved);
    assert.equal((await http(gw.url, "GET", "/sessions/ghost/history", { headers: auth(gw.token) })).status, 404);
    assert.equal((await http(gw.url, "POST", "/sessions/saved-1/history", { headers: auth(gw.token), body: {} })).status, 405);
  } finally { await gw.close(); }
});

test("GET /sessions omits prewarmed sessions with no message; they appear after the first turn", async () => {
  const st = tmpStatic();
  const gw = await startGateway({ runtime: fakeRuntime(), cfg, port: 0, staticDir: st.dir, tokenPath: join(st.dir, "..", "tok3") });
  try {
    const opened = JSON.parse((await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: { surface: "web" } })).body);
    let list = JSON.parse((await http(gw.url, "GET", "/sessions", { headers: auth(gw.token) })).body).sessions;
    assert.deepEqual(list, [], "empty prewarmed session is not listed");
    const sent = await http(gw.url, "POST", `/sessions/${opened.sessionId}/send`, { headers: auth(gw.token), body: { text: "hello" } });
    assert.ok(parseSse(sent.body).some((e) => e.type === "done"));
    list = JSON.parse((await http(gw.url, "GET", "/sessions", { headers: auth(gw.token) })).body).sessions;
    assert.deepEqual(list.map((s: any) => s.id), [opened.sessionId]);
  } finally { await gw.close(); }
});

test("idle sweep closes an empty session after 15 minutes but keeps a used one", async () => {
  const closed: string[] = [];
  let n = 0;
  const rt: Runtime = {
    listSessions: () => [],
    async openSession(o): Promise<AgentSession> {
      const id = `s${++n}`;
      return { id, surface: o.surface, violations: () => [], close: async () => { closed.push(id); }, send: async function* () { yield { type: "done", finalText: "" }; } };
    },
  };
  const m = new SessionManager(rt, { sweepMs: 1e9 });
  const empty = await m.open({ surface: "web" });
  const used = await m.open({ surface: "web" });
  await m.turn(used.id, "hi", () => {});
  const later = Date.now() + 16 * 60_000;
  await m.sweep(later);
  assert.deepEqual(closed, [empty.id]);
  await m.closeAll();
});
