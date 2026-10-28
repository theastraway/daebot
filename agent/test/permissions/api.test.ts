import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startGateway } from "../../src/gateway/index.ts";
import { PermissionService, factsOf } from "../../src/permissions/index.ts";
import type { AgentEvent, AgentSession, Runtime } from "../../src/types.ts";
import { auth, http, parseSse, tmpStatic } from "../gateway/helpers.ts";

/** A runtime whose turn behaves like the real loop: it opens a card and waits for the user's click. */
function permRuntime(dir: string) {
  const perms = new PermissionService({ dir, owner: "owner" });
  const feedback: unknown[] = [];
  let mode = "email";
  const rt: Runtime = {
    async openSession(o) {
      const s: AgentSession = {
        id: "s1", surface: o.surface, violations: () => [], close: async () => {},
        async *send(msg, so) {
          mode = String(so?.interactive);
          const f = factsOf("mind_email", "outward", { action: "send", to: "bob@acme.com" }, "/p");
          const req = perms.open({ sessionId: "s1", facts: f, args: { to: "bob@acme.com" } });
          yield req.event;
          const res = await req.wait(so?.signal);
          yield { type: "permissionResolved", id: req.id, outcome: res.allow ? "allowed" : "denied", by: "user" };
          yield { type: "text", delta: res.allow ? "sent" : "skipped" };
          yield { type: "done", finalText: res.allow ? "sent" : "skipped" };
        },
      };
      return s;
    },
    listSessions: () => [],
    permissions: perms,
    async suggestReplies() { return { replies: ["Yes, send it", "Change the subject first"] }; },
    recordSuggestionFeedback(_id, fb) { feedback.push(fb); return true; },
  };
  return { rt, perms, feedback, interactive: () => mode };
}

test("HTTP: the card arrives on the stream, POST /permissions/:id/decide answers it, and the turn finishes", async () => {
  const { rt, perms, interactive } = permRuntime(mkdtempSync(join(tmpdir(), "perm-api-")));
  const gw = await startGateway({ runtime: rt, port: 0, staticDir: tmpStatic().dir, tokenPath: join(mkdtempSync(join(tmpdir(), "mc-home-")), "tok") });
  try {
    const open = await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: { surface: "web" } });
    const sid = JSON.parse(open.body).sessionId;
    let answered = false;
    const send = http(gw.url, "POST", `/sessions/${sid}/send`, {
      headers: auth(gw.token), body: { text: "email bob" },
      onChunk: (chunk) => {
        const m = /"type":"permission","id":"([^"]+)"/.exec(chunk);
        if (m && !answered) {
          answered = true;
          void http(gw.url, "POST", `/permissions/${m[1]}/decide`, { headers: auth(gw.token), body: { decision: "allow", remember: "once" } });
        }
      },
    });
    const r = await send;
    const evs = parseSse(r.body);
    assert.ok(evs.some((e) => e.type === "permission"));
    assert.ok(evs.some((e) => e.type === "permissionResolved" && (e as any).outcome === "allowed"));
    assert.equal((evs.at(-1) as AgentEvent & { finalText: string }).finalText, "sent");
    assert.equal(interactive(), "true", "the web send route marks the turn interactive");
    assert.equal(perms.pendingList().length, 0);
  } finally { await gw.close(); }
});

test("decision endpoint: no token is 401, a bad or stale id is 404, a forged scope is 400, and nothing is created by refused calls", async () => {
  const { rt, perms } = permRuntime(mkdtempSync(join(tmpdir(), "perm-api-")));
  const gw = await startGateway({ runtime: rt, port: 0, staticDir: tmpStatic().dir, tokenPath: join(mkdtempSync(join(tmpdir(), "mc-home-")), "tok") });
  try {
    const req = perms.open({ sessionId: "s1", facts: factsOf("bash", "write", { command: "ls" }, "/p"), args: {} });
    const body = { decision: "allow", remember: "always", scope: "s1" };
    assert.equal((await http(gw.url, "POST", `/permissions/${req.id}/decide`, { body })).status, 401, "no credentials");
    assert.equal((await http(gw.url, "POST", `/permissions/${req.id}/decide`, { headers: auth("wrong-token"), body })).status, 401);
    assert.equal((await http(gw.url, "GET", "/permissions")).status, 401);
    assert.equal((await http(gw.url, "PUT", "/permissions/mode", { body: { mode: "everything" } })).status, 401);
    assert.equal((await http(gw.url, "DELETE", "/permissions/rules/x")).status, 401);
    assert.equal(perms.store.rules().length, 0);
    assert.equal(perms.store.mode(), "risky");
    assert.equal(perms.pendingList().length, 1, "still waiting: the unauthenticated calls did nothing");
    assert.equal((await http(gw.url, "POST", `/permissions/${randomBytes(8).toString("hex")}/decide`, { headers: auth(gw.token), body })).status, 404);
    assert.equal((await http(gw.url, "POST", `/permissions/${req.id}/decide`, { headers: auth(gw.token), body: { ...body, scope: { kind: "any" } } })).status, 400);
    assert.equal((await http(gw.url, "POST", `/permissions/${req.id}/decide`, { headers: auth(gw.token), body: { decision: "allow", remember: "always", scope: "s99" } })).status, 400);
    assert.equal((await http(gw.url, "GET", `/permissions/${req.id}/decide`, { headers: auth(gw.token) })).status, 405);
    assert.equal(perms.store.rules().length, 0);
    const ok = await http(gw.url, "POST", `/permissions/${req.id}/decide`, { headers: auth(gw.token), body });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).rule.matcher.value, "ls");
    assert.equal((await http(gw.url, "POST", `/permissions/${req.id}/decide`, { headers: auth(gw.token), body })).status, 404, "answered once");
  } finally { await gw.close(); }
});

test("rules API: list, edit, delete, mode", async () => {
  const { rt, perms } = permRuntime(mkdtempSync(join(tmpdir(), "perm-api-")));
  const gw = await startGateway({ runtime: rt, port: 0, staticDir: tmpStatic().dir, tokenPath: join(mkdtempSync(join(tmpdir(), "mc-home-")), "tok") });
  try {
    const o = perms.open({ sessionId: "s", facts: factsOf("bash", "write", { command: "git push origin x" }, "/p"), args: {} });
    perms.decide(o.id, { decision: "deny", remember: "always", scope: "s1" });
    const snap = JSON.parse((await http(gw.url, "GET", "/permissions", { headers: auth(gw.token) })).body);
    assert.equal(snap.mode, "risky");
    assert.deepEqual(snap.modes, ["risky", "writes", "everything"]);
    assert.equal(snap.rules.length, 1);
    const id = snap.rules[0].id;
    const patched = await http(gw.url, "PATCH", `/permissions/rules/${id}`, { headers: auth(gw.token), body: { value: "git push --force" } });
    assert.equal(patched.status, 200);
    assert.equal(JSON.parse(patched.body).rule.matcher.value, "git push --force");
    assert.equal((await http(gw.url, "PATCH", `/permissions/rules/${id}`, { headers: auth(gw.token), body: { effect: "nope" } })).status, 400);
    assert.equal((await http(gw.url, "PATCH", `/permissions/rules/zzz`, { headers: auth(gw.token), body: { effect: "allow" } })).status, 404);
    assert.equal((await http(gw.url, "PUT", "/permissions/mode", { headers: auth(gw.token), body: { mode: "writes" } })).status, 200);
    assert.equal((await http(gw.url, "PUT", "/permissions/mode", { headers: auth(gw.token), body: { mode: "yolo" } })).status, 400);
    assert.equal(perms.store.mode(), "writes");
    assert.equal((await http(gw.url, "DELETE", `/permissions/rules/${id}`, { headers: auth(gw.token) })).status, 200);
    assert.equal((await http(gw.url, "DELETE", `/permissions/rules/${id}`, { headers: auth(gw.token) })).status, 404);
  } finally { await gw.close(); }
});

test("a runtime with no permissions answers 404, not an error", async () => {
  const rt: Runtime = { async openSession(o) { return { id: "s", surface: o.surface, violations: () => [], close: async () => {}, send: async function* () { yield { type: "done", finalText: "" }; } }; }, listSessions: () => [] };
  const gw = await startGateway({ runtime: rt, port: 0, staticDir: tmpStatic().dir, tokenPath: join(mkdtempSync(join(tmpdir(), "mc-home-")), "tok") });
  try {
    assert.equal((await http(gw.url, "GET", "/permissions", { headers: auth(gw.token) })).status, 404);
    const sid = JSON.parse((await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: {} })).body).sessionId;
    const r = await http(gw.url, "POST", `/sessions/${sid}/suggest`, { headers: auth(gw.token), body: {} });
    assert.deepEqual(JSON.parse(r.body), { replies: [] });
  } finally { await gw.close(); }
});

test("suggestions over HTTP: generate needs auth, feedback is validated and handed to the runtime", async () => {
  const { rt, feedback } = permRuntime(mkdtempSync(join(tmpdir(), "perm-api-")));
  const gw = await startGateway({ runtime: rt, port: 0, staticDir: tmpStatic().dir, tokenPath: join(mkdtempSync(join(tmpdir(), "mc-home-")), "tok") });
  try {
    const sid = JSON.parse((await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: {} })).body).sessionId;
    assert.equal((await http(gw.url, "POST", `/sessions/${sid}/suggest`, { body: {} })).status, 401);
    const r = await http(gw.url, "POST", `/sessions/${sid}/suggest`, { headers: auth(gw.token), body: {} });
    assert.deepEqual(JSON.parse(r.body).replies, ["Yes, send it", "Change the subject first"]);
    assert.equal((await http(gw.url, "POST", `/sessions/${sid}/suggest`, { headers: auth(gw.token) })).status, 200);
    assert.equal((await http(gw.url, "GET", `/sessions/${sid}/suggest`, { headers: auth(gw.token) })).status, 405);
    assert.equal((await http(gw.url, "POST", `/sessions/${sid}/suggest-feedback`, { headers: auth(gw.token), body: { shown: ["a"], action: "weird" } })).status, 400);
    assert.equal((await http(gw.url, "POST", `/sessions/${sid}/suggest-feedback`, { body: { shown: ["a"], action: "chosen" } })).status, 401);
    const ok = await http(gw.url, "POST", `/sessions/${sid}/suggest-feedback`, { headers: auth(gw.token), body: { shown: ["Yes, send it", 5, "b", "c", "d"], picked: "Yes, send it", sent: "Yes, send it please", action: "edited" } });
    assert.equal(ok.status, 200);
    assert.deepEqual(feedback, [{ shown: ["Yes, send it", "b", "c"], picked: "Yes, send it", sent: "Yes, send it please", action: "edited" }]);
  } finally { await gw.close(); }
});
