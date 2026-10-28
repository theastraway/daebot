import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "../../src/loop.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { PermissionService } from "../../src/permissions/index.ts";
import type { AgentEvent, AgentSession } from "../../src/types.ts";
import { FakeProvider, FakeSync, baseCfg, call, fakeTool } from "../core/helpers.ts";

function make(rounds: ConstructorParameters<typeof FakeProvider>[0], tools: ReturnType<typeof fakeTool>[], withPerms = true) {
  const dir = mkdtempSync(join(tmpdir(), "perm-loop-"));
  const perms = new PermissionService({ dir, owner: "u1" });
  const provider = new FakeProvider(rounds);
  const session = createAgentSession({
    id: "s1", surface: "web", provider, kernel: createKernel({ shadow: false, enabled: true }), tools, sync: new FakeSync(),
    cfg: baseCfg(), cwd: "/proj", systemPrompt: "SYS", bootContext: "BOOT", ...(withPerms ? { permissions: perms } : {}),
  });
  return { perms, provider, session };
}

/** Runs a turn; whenever a permission card appears, `answer` decides it (as the gateway would after a user click). */
async function drive(session: AgentSession, perms: PermissionService, msg: string, answer: (ev: Extract<AgentEvent, { type: "permission" }>) => Parameters<PermissionService["decide"]>[1], interactive = true) {
  const out: AgentEvent[] = [];
  for await (const ev of session.send(msg, { interactive })) {
    out.push(ev);
    if (ev.type === "permission") setImmediate(() => perms.decide(ev.id, answer(ev)));
  }
  return out;
}
const mail = (to = "bob@acme.com") => call("c1", "mind_email", { action: "send", to, subject: "hi" });

test("an outward call pauses the turn on a card; Allow once runs exactly that call, in the same turn", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const { perms, session } = make([{ calls: [mail()] }, { text: "sent it" }], [t]);
  const ev = await drive(session, perms, "email bob", () => ({ decision: "allow", remember: "once" }));
  const types = ev.map((e) => e.type);
  assert.ok(types.indexOf("permission") < types.indexOf("toolStart"), "card before the tool runs");
  assert.ok(types.includes("permissionResolved"));
  assert.equal(t.calls.length, 1);
  assert.ok(!types.includes("confirm"), "no typed confirmation");
  assert.equal((ev.at(-1) as any).finalText, "sent it");
  assert.equal(perms.store.rules().length, 0);
  const card = ev.find((e) => e.type === "permission") as any;
  assert.equal(card.title, "Contact bob@acme.com");
  assert.ok(card.detail.some((d: any) => d.label === "Recipient" && d.value === "bob@acme.com"));
  assert.deepEqual(card.allowOptions.map((o: any) => o.id), ["s0", "s1", "s2"]);
  // single use: the same call again in a later turn asks again
});

test("Deny: the tool never runs, the model is told not to retry, and the turn still ends with a reply", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const { perms, session, provider } = make([{ calls: [mail()] }, { text: "ok, not sending" }], [t]);
  const ev = await drive(session, perms, "email bob", () => ({ decision: "deny", remember: "once" }));
  assert.equal(t.calls.length, 0);
  const res = ev.find((e) => e.type === "permissionResolved") as any;
  assert.equal(res.outcome, "denied");
  const toolMsg = provider.requests[1].messages.find((m) => m.role === "tool")!;
  assert.match(toolMsg.content, /user denied/);
  assert.match(toolMsg.content, /Do not retry/);
  assert.equal((ev.at(-1) as any).finalText, "ok, not sending");
});

test("Always deny creates a deny rule; the next attempt is blocked with no card and the model is told why", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const { perms, session, provider } = make([{ calls: [mail("bob@acme.com")] }, { text: "stopped" }, { calls: [mail("bob@acme.com")] }, { text: "ok" }], [t]);
  await drive(session, perms, "email bob", (c) => ({ decision: "deny", remember: "always", scope: c.denyOptions[1].id }));
  assert.equal(perms.store.rules()[0].effect, "deny");
  const ev2 = await drive(session, perms, "again", () => { throw new Error("no card expected"); });
  assert.ok(!ev2.some((e) => e.type === "permission"), "blocked without asking");
  assert.equal(t.calls.length, 0);
  const gate = ev2.find((e) => e.type === "gate") as any;
  assert.equal(gate.verdict.gate, "permission");
  const sent = provider.requests.at(-1)!.messages.filter((m) => m.role === "tool").at(-1)!.content;
  assert.match(sent, /permission rule you \(the user\) set: never/);
  assert.equal(perms.store.rules()[0].uses, 1);
});

test("Always allow (this recipient) skips the card next time, but only for that recipient", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const { perms, session } = make([{ calls: [mail("bob@acme.com")] }, { text: "1" }, { calls: [mail("bob@acme.com")] }, { text: "2" }, { calls: [mail("eve@evil.io")] }, { text: "3" }], [t]);
  await drive(session, perms, "one", (c) => ({ decision: "allow", remember: "always", scope: c.allowOptions.find((o) => /targets bob/.test(o.label))!.id }));
  const ev2 = await drive(session, perms, "two", () => { throw new Error("no card expected"); });
  assert.ok(!ev2.some((e) => e.type === "permission"));
  assert.equal(t.calls.length, 2, "ran twice");
  const ev3 = await drive(session, perms, "three", () => ({ decision: "deny" }));
  assert.ok(ev3.some((e) => e.type === "permission"), "a different recipient asks again");
  assert.equal(t.calls.length, 2);
});

test("a rule never lifts any other gate: boot, tier and owner checks still refuse", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const dir = mkdtempSync(join(tmpdir(), "perm-loop-"));
  const perms = new PermissionService({ dir, owner: "u1" });
  const provider = new FakeProvider([{ calls: [mail()] }, { text: "no" }]);
  const session = createAgentSession({
    id: "s2", surface: "web", provider, kernel: createKernel({ shadow: false, enabled: true, tier: "staff" }), tools: [t], sync: new FakeSync(),
    cfg: baseCfg(), cwd: "/proj", systemPrompt: "SYS", bootContext: "BOOT", permissions: perms,
  });
  const ev = await drive(session, perms, "email", () => { throw new Error("no card: the tier gate refuses first"); });
  assert.ok(!ev.some((e) => e.type === "permission"));
  assert.equal(t.calls.length, 0);
});

test("a non-interactive surface (bots, API, chat apps) keeps the typed confirmation and no card", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const { perms, session } = make([{ calls: [mail()] }, { text: "x" }], [t]);
  const ev = await drive(session, perms, "email bob", () => { throw new Error("no card expected"); }, false);
  assert.ok(ev.some((e) => e.type === "confirm"));
  assert.ok(!ev.some((e) => e.type === "permission"));
  assert.equal(t.calls.length, 0);
  assert.equal(perms.pendingList().length, 0);
});

test("a saved Always-allow also stands in for the typed phrase on a non-interactive surface", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const { perms, session } = make([{ calls: [mail()] }, { text: "done" }], [t]);
  const o = perms.open({ sessionId: "s1", facts: (await import("../../src/permissions/index.ts")).factsOf("mind_email", "outward", mail().args, "/proj"), args: mail().args });
  perms.decide(o.id, { decision: "allow", remember: "always", scope: "s1" });
  const ev = await drive(session, perms, "email bob", () => { throw new Error("no card"); }, false);
  assert.equal(t.calls.length, 1);
  assert.ok(!ev.some((e) => e.type === "confirm"));
});

test("writes mode asks before a plain write tool; risky mode (default) does not", async () => {
  const t = fakeTool("bash", "write", "ran");
  const { perms, session } = make([{ calls: [call("c1", "bash", { command: "git status" })] }, { text: "a" }, { calls: [call("c2", "bash", { command: "git status" })] }, { text: "b" }], [t]);
  const ev1 = await drive(session, perms, "go", () => { throw new Error("risky mode should not ask for bash"); });
  assert.ok(!ev1.some((e) => e.type === "permission"));
  perms.setMode("writes");
  const ev2 = await drive(session, perms, "again", (c) => { assert.equal(c.title, "Run a command on this computer"); return { decision: "allow", remember: "always", scope: c.allowOptions[1].id }; });
  assert.ok(ev2.some((e) => e.type === "permission"));
  assert.equal(t.calls.length, 2);
  const stored = perms.store.rules()[0];
  assert.deepEqual(stored.matcher, { kind: "prefix", value: "git status" });
});

test("a deny rule blocks even a read-class tool the kernel would let through", async () => {
  const t = fakeTool("web_fetch", "read", "page", "surface");
  const { perms, session } = make([{ calls: [call("c1", "web_fetch", { url: "https://tracker.example.com/x" })] }, { text: "no" }], [t]);
  const o = perms.open({ sessionId: "s1", facts: (await import("../../src/permissions/index.ts")).factsOf("web_fetch", "read", { url: "https://tracker.example.com/x" }, "/proj"), args: {} });
  perms.decide(o.id, { decision: "deny", remember: "always", scope: "s1" });
  const ev = await drive(session, perms, "fetch", () => { throw new Error("no card"); });
  assert.equal(t.calls.length, 0);
  assert.ok(ev.some((e) => e.type === "gate" && (e as any).verdict.gate === "permission"));
});

test("without a permission service the loop is exactly the old behaviour", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const { session, perms } = make([{ calls: [mail()] }, { text: "x" }], [t], false);
  const ev = await drive(session, perms, "email", () => { throw new Error("no card"); });
  assert.ok(ev.some((e) => e.type === "confirm"));
});

test("an aborted turn cancels its pending card", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const { perms, session } = make([{ calls: [mail()] }, { text: "x" }], [t]);
  const ac = new AbortController();
  const out: AgentEvent[] = [];
  for await (const ev of session.send("email", { interactive: true, signal: ac.signal })) {
    out.push(ev);
    if (ev.type === "permission") setImmediate(() => ac.abort());
  }
  assert.equal(perms.pendingList().length, 0);
  assert.equal(t.calls.length, 0);
  assert.ok(out.some((e) => e.type === "notice" && /aborted/.test((e as any).text)));
});

test("a call denied on a card is never carded again in the same chat (retry or regenerated answer)", async () => {
  const t = fakeTool("mind_email", "outward", "sent");
  const { perms, session } = make([{ calls: [mail()] }, { calls: [mail()] }, { text: "ok, not sending" }], [t]);
  let cards = 0;
  const ev = await drive(session, perms, "email bob", () => { cards++; return { decision: "deny", remember: "once" }; });
  assert.equal(cards, 1, "one card only");
  assert.equal(t.calls.length, 0, "never ran");
  assert.ok(ev.some((e) => e.type === "gate" && (e as any).verdict.reason.includes("already denied")));
  assert.equal(perms.store.rules().length, 0, "deny once makes no rule");
});
