import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createAgentSession } from "../../src/loop.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { PermissionService, WAIVER_TEXT, WAIVER_VERSION, factsOf } from "../../src/permissions/index.ts";
import type { SessionPermMode } from "../../src/permissions/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { startGateway } from "../../src/gateway/index.ts";
import type { AgentEvent, AgentSession, Runtime } from "../../src/types.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { auth, http, tmpStatic } from "../gateway/helpers.ts";
import { FakeProvider, FakeSync, baseCfg, call, collect, fakeTool } from "../core/helpers.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function make(rounds: ConstructorParameters<typeof FakeProvider>[0], tools: ReturnType<typeof fakeTool>[], opts: { mode?: SessionPermMode; waiver?: boolean; accountMode?: "risky" | "writes" | "everything" } = {}) {
  const perms = new PermissionService({ dir: tmp("bypass-"), owner: "u1" });
  if (opts.waiver) perms.store.acceptWaiver();
  if (opts.accountMode) perms.store.setMode(opts.accountMode);
  let mode = opts.mode;
  const session = createAgentSession({
    id: "s1", surface: "web", provider: new FakeProvider(rounds), kernel: createKernel({ shadow: false, enabled: true }), tools, sync: new FakeSync(),
    cfg: baseCfg(), cwd: "/proj", systemPrompt: "SYS", bootContext: "BOOT", permissions: perms, permMode: () => mode,
  });
  return { perms, session, setMode: (m: SessionPermMode | undefined) => { mode = m; } };
}
const mail = () => call("c1", "mind_email", { action: "send", to: "bob@acme.com", subject: "hi" });
const types = (ev: AgentEvent[]) => ev.map((e) => e.type);

// ---------------------------------------------------------------- the waiver, server side

test("waiver: recorded per account with a timestamp, survives a reload, only counts for the current text version, can be withdrawn", () => {
  const dir = tmp("bypass-w-");
  const a = new PermissionService({ dir, owner: "u1" });
  assert.equal(a.waiverAccepted(), false);
  assert.equal(a.canUseMode("bypass"), false);
  assert.equal(a.canUseMode("writes"), true);
  const w = a.store.acceptWaiver(1234);
  assert.deepEqual(w, { at: 1234, version: WAIVER_VERSION });
  assert.equal(new PermissionService({ dir, owner: "u1" }).waiverAccepted(), true, "read back from the file");
  assert.equal(new PermissionService({ dir, owner: "u2" }).waiverAccepted(), false, "another account never inherits it");
  assert.equal(a.snapshot().waiver.accepted, true);
  assert.equal(a.snapshot().waiver.text, WAIVER_TEXT);
  a.store.revokeWaiver();
  assert.equal(a.waiverAccepted(), false);
});

test("effectiveMode: a stored bypass without a waiver falls back to the account default, never to bypass", () => {
  const perms = new PermissionService({ dir: tmp("bypass-e-"), owner: "u1" });
  perms.store.setMode("writes");
  assert.equal(perms.effectiveMode("bypass"), "writes");
  assert.equal(perms.effectiveMode(undefined), "writes");
  assert.equal(perms.effectiveMode("everything"), "everything");
  perms.store.acceptWaiver();
  assert.equal(perms.effectiveMode("bypass"), "bypass");
});

// ---------------------------------------------------------------- the loop

test("bypass + waiver: the outward call runs with no card and no typed confirmation, and the transcript says it was auto-approved", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const { session } = make([{ calls: [mail()] }, { text: "sent it" }], [t], { mode: "bypass", waiver: true });
  const ev = await collect(session.send("email bob", { interactive: true }));
  assert.equal(t.calls.length, 1);
  assert.ok(!types(ev).includes("permission") && !types(ev).includes("confirm"));
  const note = ev.find((e) => e.type === "notice" && /auto-approved \(bypass\)/.test((e as any).text)) as any;
  assert.ok(note, "logged");
  assert.match(note.text, /bob@acme\.com/);
  assert.ok(types(ev).indexOf("notice") < types(ev).indexOf("toolStart"));
});

test("bypass with NO waiver is not bypass: the same call still stops on a card", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const { perms, session } = make([{ calls: [mail()] }, { text: "ok" }], [t], { mode: "bypass", waiver: false });
  const ev: AgentEvent[] = [];
  for await (const e of session.send("email bob", { interactive: true })) {
    ev.push(e);
    if (e.type === "permission") setImmediate(() => perms.decide(e.id, { decision: "deny", remember: "once" }));
  }
  assert.ok(types(ev).includes("permission"));
  assert.equal(t.calls.length, 0);
});

test("bypass leaves the user's own Always-deny rules in force", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const { perms, session } = make([{ calls: [mail()] }, { text: "ok" }], [t], { mode: "bypass", waiver: true });
  perms.store.addRule({ effect: "deny", tool: "mind_email", matcher: { kind: "recipient", value: "bob@acme.com" }, scope: "email to bob@acme.com" }, "outward");
  const ev = await collect(session.send("email bob", { interactive: true }));
  assert.equal(t.calls.length, 0, "the deny rule wins over bypass");
  assert.ok(ev.some((e) => e.type === "gate" && (e as any).verdict.gate === "permission"));
  assert.ok(!ev.some((e) => e.type === "notice" && /auto-approved/.test((e as any).text)));
});

test("bypass does not lift safety blocks that are not about permission (a bot peer turn still cannot request an outward action)", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const { session } = make([{ calls: [mail()] }, { text: "ok" }], [t], { mode: "bypass", waiver: true });
  const ev = await collect(session.send("email bob", { origin: "bot", interactive: false }));
  assert.equal(t.calls.length, 0);
  assert.ok(ev.some((e) => e.type === "gate" && (e as any).verdict.gate === "peer"));
});

test("per-chat mode beats the account default, and turning it off returns to the default", async () => {
  const t = fakeTool("write_file", "write", "wrote");
  const w = call("c1", "write_file", { path: "/proj/a.txt", content: "x" });
  const ask = async (m: SessionPermMode | undefined) => {
    const { perms, session } = make([{ calls: [w] }, { text: "done" }], [t], { mode: m, accountMode: "risky" });
    const ev: AgentEvent[] = [];
    for await (const e of session.send("write it", { interactive: true })) { ev.push(e); if (e.type === "permission") setImmediate(() => perms.decide(e.id, { decision: "allow", remember: "once" })); }
    return types(ev).includes("permission");
  };
  assert.equal(await ask(undefined), false, "account default risky: a file write just runs");
  assert.equal(await ask("writes"), true, "this chat asks before changes");
  assert.equal(await ask("risky"), false);
});

// ---------------------------------------------------------------- stored with the session

test("the chat's mode is stored with the session and restored; a bypass in the file is ignored without a waiver", async () => {
  const key = "mind_" + randomBytes(18).toString("hex");
  const fake = await startFakeMind({ [key]: "pat" });
  try {
    const dir = tmp("bypass-rt-");
    const store = createFileStore(dir);
    const mk = () => createRuntime(baseCfg({ mindBaseUrl: fake.base, mindApiKey: key }), { provider: new FakeProvider([{ text: "ok" }, { text: "ok" }]), store, owner: "u_pat", stateDir: dir, hosted: { dailyUsdCap: 50, username: "pat", exempt: true } });
    const rt = mk();
    const s = await rt.openSession({ surface: "web", identity: "admin" });
    s.setPermMode!("everything");
    await collect(s.send("hi"));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(store.load(s.id)!.permMode, "everything");
    assert.equal(rt.listSessions().find((r) => r.id === s.id)!.permMode, "everything");
    s.setPermMode!("bypass");
    assert.equal(rt.sessionInfo!(s.id)!.permMode, "everything", "the runtime itself refuses bypass without a waiver");
    rt.permissions!.store.acceptWaiver();
    s.setPermMode!("bypass");
    assert.equal(rt.sessionInfo!(s.id)!.permMode, "bypass");
    await new Promise((r) => setTimeout(r, 50));
    const back = await mk().openSession({ surface: "web", resumeId: s.id, identity: "admin" });
    assert.ok(back);
    assert.equal(mk().sessionInfo!(s.id)!.permMode, "bypass");
    s.setPermMode!(undefined);
    assert.equal(rt.sessionInfo!(s.id)?.permMode, undefined);
  } finally { await fake.close(); }
});

// ---------------------------------------------------------------- HTTP

function modeRuntime(dir: string) {
  const perms = new PermissionService({ dir, owner: "owner" });
  const modes = new Map<string, SessionPermMode | undefined>();
  const rt: Runtime = {
    async openSession(o) {
      const id = o.resumeId ?? "s1";
      const s: AgentSession = {
        id, surface: o.surface, violations: () => [], close: async () => {},
        async *send() { yield { type: "done", finalText: "" } as AgentEvent; },
        setPermMode(m) { modes.set(id, m); },
      };
      return s;
    },
    listSessions: () => [],
    permissions: perms,
    history: () => [],
  };
  return { rt, perms, modes };
}

test("HTTP: bypass is refused (403 waiver_required) until the waiver is recorded; the waiver needs the box ticked for this version; then it works and can be withdrawn", async () => {
  const { rt, perms, modes } = modeRuntime(tmp("bypass-http-"));
  const gw = await startGateway({ runtime: rt, port: 0, staticDir: tmpStatic().dir, tokenPath: join(tmp("mc-home-"), "tok") });
  try {
    const h = auth(gw.token);
    const sid = JSON.parse((await http(gw.url, "POST", "/sessions", { headers: h, body: { surface: "web" } })).body).sessionId;
    // unauthenticated
    assert.equal((await http(gw.url, "PATCH", `/sessions/${sid}`, { body: { permMode: "writes" } })).status, 401);
    assert.equal((await http(gw.url, "POST", "/permissions/waiver", { body: { acknowledged: true, version: WAIVER_VERSION } })).status, 401);
    // the normal modes work with no waiver
    const ok = await http(gw.url, "PATCH", `/sessions/${sid}`, { headers: h, body: { permMode: "writes" } });
    assert.equal(ok.status, 200);
    assert.equal(modes.get(sid), "writes");
    // bypass without a waiver: refused, nothing changed
    const no = await http(gw.url, "PATCH", `/sessions/${sid}`, { headers: h, body: { permMode: "bypass" } });
    assert.equal(no.status, 403);
    assert.equal(JSON.parse(no.body).error, "waiver_required");
    assert.equal(modes.get(sid), "writes");
    assert.equal(JSON.parse((await http(gw.url, "GET", "/permissions/waiver", { headers: h })).body).accepted, false);
    // bad shapes
    assert.equal((await http(gw.url, "PATCH", `/sessions/${sid}`, { headers: h, body: { permMode: "root" } })).status, 400);
    assert.equal((await http(gw.url, "PUT", "/permissions/mode", { headers: h, body: { mode: "bypass" } })).status, 400, "bypass is never an account default");
    // the waiver: no ack, wrong version, then the real thing
    assert.equal((await http(gw.url, "POST", "/permissions/waiver", { headers: h, body: {} })).status, 400);
    assert.equal((await http(gw.url, "POST", "/permissions/waiver", { headers: h, body: { acknowledged: "yes", version: WAIVER_VERSION } })).status, 400);
    assert.equal((await http(gw.url, "POST", "/permissions/waiver", { headers: h, body: { acknowledged: true, version: WAIVER_VERSION + 1 } })).status, 400);
    assert.equal(perms.waiverAccepted(), false);
    const acc = await http(gw.url, "POST", "/permissions/waiver", { headers: h, body: { acknowledged: true, version: WAIVER_VERSION } });
    assert.equal(acc.status, 200);
    assert.ok(JSON.parse(acc.body).at > 0);
    assert.equal(perms.waiverAccepted(), true);
    const snap = JSON.parse((await http(gw.url, "GET", "/permissions", { headers: h })).body);
    assert.equal(snap.waiver.accepted, true);
    assert.equal((await http(gw.url, "PATCH", `/sessions/${sid}`, { headers: h, body: { permMode: "bypass" } })).status, 200);
    assert.equal(modes.get(sid), "bypass");
    // one-click off, and withdrawing the waiver
    assert.equal((await http(gw.url, "PATCH", `/sessions/${sid}`, { headers: h, body: { permMode: null } })).status, 200);
    assert.equal(modes.get(sid), undefined);
    assert.equal((await http(gw.url, "DELETE", "/permissions/waiver", { headers: h })).status, 200);
    assert.equal((await http(gw.url, "PATCH", `/sessions/${sid}`, { headers: h, body: { permMode: "bypass" } })).status, 403);
  } finally { await gw.close(); }
});

test("sanity: factsOf is what the loop prompts on (guards the helper used above)", () => {
  assert.equal(factsOf("mind_email", "outward", { action: "send", to: "bob@acme.com" }, "/p").cls, "outward");
});
