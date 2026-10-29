// No blind jobs: a request to act carries the requester's OOC/EMR receipt; an outward action on a peer turn needs the receiver's own
// receipt too; anything the user must approve goes to the task board; receipts die with the turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, peerGateMessage } from "../../src/loop.ts";
import type { PeerAwaiting } from "../../src/loop.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { PermissionService, factsOf } from "../../src/permissions/index.ts";
import { createMindTools } from "../../src/mind/tools.ts";
import { createBotTalkTool } from "../../src/bots/talk-tool.ts";
import { ExchangeHub } from "../../src/bots/exchanges.ts";
import { checkTask, loadTasks } from "../../src/board/board.ts";
import { FakeKernel, FakeProvider, FakeSync, baseCfg, call, collect, fakeTool } from "../core/helpers.ts";
import type { AgentEvent, MindClient, Tool, ToolContext } from "../../src/types.ts";

/** A mind_decision_record that files nothing real: returns the receipt meta the real tool returns. */
function decisionTool(id = "doc-111"): Tool & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls, class: "write",
    spec: { name: "mind_decision_record", description: "file a decision", parameters: { type: "object", properties: {} } },
    async run(args) { calls.push(args); return { ok: true, output: `saved document ${id}\nDecision receipt: ${id}`, meta: { decisionId: id, subject: String(args.subject ?? "x"), ...(args.stance === "decline" ? { declined: true } : {}) } }; },
  };
}
const rec = (_id?: string, stance?: string) => call("d1", "mind_decision_record", { subject: "job", decision: "ok", owner_check: "the job belongs to Acme; the user asked about Acme; Acme == Acme", ...(stance ? { stance } : {}) });

function mk(rounds: ConstructorParameters<typeof FakeProvider>[0], tools: Tool[], over: Partial<Parameters<typeof createAgentSession>[0]> = {}) {
  return createAgentSession({
    id: "s1", surface: "bot", provider: new FakeProvider(rounds), kernel: new FakeKernel(), tools, sync: new FakeSync(), cfg: baseCfg(), cwd: "/",
    systemPrompt: "SYS", bootContext: "booted", ...over,
  });
}
const toolMsgs = (p: FakeProvider, req: number) => p.requests[req].messages.filter((m) => m.role === "tool").map((m) => m.content);

// ---------------------------------------------------------------- receiver side
test("receiver: a peer request with no issuer receipt is a blind job: the outward tool is refused with the think-first instruction", async () => {
  const send = fakeTool("send_email", "outward", "sent");
  const dec = decisionTool();
  const provider = new FakeProvider([{ calls: [rec(), call("2", "send_email", { to: "a@b.co" })] }, { text: "declined" }]);
  const s = mk([], [send, dec], { provider });
  const ev = await collect(s.send("do the thing", { origin: "bot" })); // no peerReceipt
  assert.equal(send.calls.length, 0);
  assert.match(toolMsgs(provider, 1).join("\n"), /without a decision receipt \(a blind job\)/);
  assert.ok(ev.some((e) => e.type === "gate" && (e as any).verdict.gate === "peer" && (e as any).verdict.action === "block"));
  assert.ok(s.violations().some((v) => v.gate === "peer" && v.action === "block"), "the refusal is in the violations/gate log");
});

test("receiver: the requester carried a receipt but the receiver filed none this turn: refused, told to run decide + mind_decision_record", async () => {
  const send = fakeTool("send_email", "outward", "sent");
  const provider = new FakeProvider([{ calls: [call("1", "send_email", { to: "a@b.co" })] }, { text: "ok" }]);
  const s = mk([], [send, decisionTool()], { provider });
  await collect(s.send("do the thing", { origin: "bot", peerReceipt: "doc-req-1" }));
  assert.equal(send.calls.length, 0);
  assert.equal(toolMsgs(provider, 1)[0], peerGateMessage("receiver"));
  assert.match(toolMsgs(provider, 1)[0], /Run your own OOC\/EMR/);
  assert.match(toolMsgs(provider, 1)[0], /declining is a valid outcome/);
});

test("receiver: both receipts present -> the outward action runs (normal flow has no confirmation here), toolEnd carries the decision id", async () => {
  const send = fakeTool("send_email", "outward", "sent");
  const dec = decisionTool("doc-recv-9");
  const provider = new FakeProvider([{ calls: [rec()] }, { calls: [call("2", "send_email", { to: "a@b.co" })] }, { text: "done" }]);
  const s = mk([], [send, dec], { provider });
  const ev = await collect(s.send("do the thing", { origin: "bot", peerReceipt: "doc-req-1" }));
  assert.equal(send.calls.length, 1, "the outward tool ran");
  const end = ev.filter((e) => e.type === "toolEnd") as Extract<AgentEvent, { type: "toolEnd" }>[];
  assert.equal(end[0].decisionId, "doc-recv-9");
  const gate = ev.find((e) => e.type === "gate" && (e as any).verdict.gate === "peer") as any;
  assert.equal(gate.verdict.action, "allow");
  assert.match(gate.verdict.reason, /doc-req-1/);
  assert.match(gate.verdict.reason, /doc-recv-9/);
});

test("receiver: a DECLINE record is a valid, recorded outcome but never unlocks an action", async () => {
  const send = fakeTool("send_email", "outward", "sent");
  const provider = new FakeProvider([{ calls: [rec(undefined, "decline"), call("2", "send_email", {})] }, { text: "I declined" }]);
  const s = mk([], [send, decisionTool()], { provider });
  await collect(s.send("do the thing", { origin: "bot", peerReceipt: "doc-req-1" }));
  assert.equal(send.calls.length, 0);
  assert.equal(toolMsgs(provider, 1)[0].includes("[#c1 mind_decision_record]"), true, "the decline itself was recorded");
});

test("receiver: receipts are per turn: a receipt filed in an earlier turn does not unlock the next peer turn", async () => {
  const send = fakeTool("send_email", "outward", "sent");
  const provider = new FakeProvider([
    { calls: [rec()] }, { calls: [call("2", "send_email", {})] }, { text: "done" },   // turn 1: both receipts, runs
    { calls: [call("3", "send_email", { again: 1 })] }, { text: "stuck" },            // turn 2: no new decision filed
  ]);
  const s = mk([], [send, decisionTool()], { provider });
  await collect(s.send("one", { origin: "bot", peerReceipt: "doc-req-1" }));
  assert.equal(send.calls.length, 1);
  await collect(s.send("two", { origin: "bot", peerReceipt: "doc-req-2" }));
  assert.equal(send.calls.length, 1, "stale receipt from turn 1 rejected");
  const last = provider.requests.at(-1)!.messages.filter((m) => m.role === "tool").at(-1)!.content;
  assert.equal(last, peerGateMessage("receiver"));
});

test("receiver: read and local-write tools still work on a peer turn with no receipts", async () => {
  const note = fakeTool("note", "write", "noted"), look = fakeTool("look", "read", "seen");
  const s = mk([{ calls: [call("1", "note", { t: 1 }), call("2", "look", {})] }, { text: "ok" }], [note, look]);
  await collect(s.send("hi", { origin: "bot" }));
  assert.equal(note.calls.length + look.calls.length, 2);
});

// ---------------------------------------------------------------- the user's gates stay
test("irreversible on a peer turn with both receipts: NOT executed, a red awaiting-decision item is raised with both receipts, the user's confirmation stays required", async () => {
  const del = fakeTool("danger_delete", "irreversible", "deleted");
  const items: PeerAwaiting[] = [];
  const provider = new FakeProvider([{ calls: [rec()] }, { calls: [call("2", "danger_delete", { id: 7 })] }, { text: "waiting on the user" }]);
  const s = mk([], [del, decisionTool("doc-recv-2")], { provider, kernel: createKernel({ shadow: false, enabled: true }), peerAwaiting: (i) => items.push(i) });
  const ev = await collect(s.send("delete it", { origin: "bot", peerReceipt: "doc-req-2" }));
  assert.equal(del.calls.length, 0, "not executed");
  assert.equal(items.length, 1);
  assert.equal(items[0].issuerReceipt, "doc-req-2");
  assert.equal(items[0].receiverReceipt, "doc-recv-2");
  assert.equal(items[0].tool, "danger_delete");
  assert.match(toolMsgs(provider, 2).join("\n"), /on the user's task board as "awaiting decision"/);
  assert.ok(!ev.some((e) => e.type === "confirm"), "no typed-confirmation card in the peer thread");
  assert.ok(s.violations().some((v) => v.gate === "peer" && v.action === "needs-confirmation"));
});

test("a user permission DENY rule still blocks a peer action that has both receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "peer-perm-"));
  const perms = new PermissionService({ dir, owner: "u1" });
  const mail = fakeTool("mind_email", "outward", "sent");
  const args = { action: "send", to: "bob@acme.com", subject: "hi" };
  const o = perms.open({ sessionId: "s1", facts: factsOf("mind_email", "outward", args, "/"), args });
  perms.decide(o.id, { decision: "deny", remember: "always", scope: "s1" });
  const provider = new FakeProvider([{ calls: [rec()] }, { calls: [call("2", "mind_email", args)] }, { text: "no" }]);
  const items: PeerAwaiting[] = [];
  const s = mk([], [mail, decisionTool()], { provider, kernel: createKernel({ shadow: false, enabled: true }), permissions: perms, peerAwaiting: (i) => items.push(i) });
  const ev = await collect(s.send("mail bob", { origin: "bot", peerReceipt: "doc-req-3" }));
  assert.equal(mail.calls.length, 0);
  assert.equal(items.length, 0, "a denied action never reaches the board");
  assert.ok(ev.some((e) => e.type === "gate" && (e as any).verdict.gate === "permission"));
});

test("a user ALLOW rule: the peer action with both receipts runs without a human (normal flow would have allowed it)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "peer-perm-"));
  const perms = new PermissionService({ dir, owner: "u1" });
  const mail = fakeTool("mind_email", "outward", "sent");
  const args = { action: "send", to: "bob@acme.com", subject: "hi" };
  const o = perms.open({ sessionId: "s1", facts: factsOf("mind_email", "outward", args, "/"), args });
  perms.decide(o.id, { decision: "allow", remember: "always", scope: "s2" });
  const provider = new FakeProvider([{ calls: [rec()] }, { calls: [call("2", "mind_email", args)] }, { text: "sent" }]);
  const s = mk([], [mail, decisionTool()], { provider, kernel: createKernel({ shadow: false, enabled: true }), permissions: perms });
  await collect(s.send("mail bob", { origin: "bot", peerReceipt: "doc-req-3" }));
  assert.equal(mail.calls.length, 1);
});

// ---------------------------------------------------------------- issuer side
const stubBus = () => { const sent: any[] = []; return { sent, ref: { current: { talk: async (r: any) => { sent.push(r); return { ok: true, output: "reply" }; } } } as any }; };
const ctx = (decisions: ToolContext["decisions"] = []): ToolContext => ({ cwd: "/", sessionId: "s1", decisions });

test("issuer: a task request without a decision receipt is refused with the decide + mind_decision_record instruction; nothing is sent", async () => {
  const b = stubBus();
  const t = createBotTalkTool({ bus: b.ref, owner: "u1" });
  const r = await t.run({ to: "bob", message: "please send the invoice", request: true }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.output, /blind job/);
  assert.match(r.output, /mind_decision_record/);
  assert.equal(b.sent.length, 0);
});

test("issuer: a receipt that is not from THIS turn (or was a decline) is refused", async () => {
  const b = stubBus();
  const t = createBotTalkTool({ bus: b.ref, owner: "u1" });
  const stale = await t.run({ to: "bob", message: "do x", request: true, decision_receipt: "doc-old" }, ctx([{ id: "doc-new", subject: "s", at: 1 }]));
  assert.equal(stale.ok, false);
  assert.match(stale.output, /not a decision you filed in THIS turn/);
  const declined = await t.run({ to: "bob", message: "do x", request: true, decision_receipt: "doc-no" }, ctx([{ id: "doc-no", subject: "s", at: 1, declined: true }]));
  assert.equal(declined.ok, false);
  assert.equal(b.sent.length, 0);
});

test("issuer: a request with this turn's receipt goes through and the bus gets the receipt", async () => {
  const b = stubBus();
  const t = createBotTalkTool({ bus: b.ref, owner: "u1" });
  const r = await t.run({ to: "bob", message: "do x", request: true, decision_receipt: "doc-now" }, ctx([{ id: "doc-now", subject: "s", at: 1 }]));
  assert.equal(r.ok, true);
  assert.equal(b.sent[0].decisionReceipt, "doc-now");
});

test("issuer: a question / info ask (no request flag) needs no receipt", async () => {
  const b = stubBus();
  const t = createBotTalkTool({ bus: b.ref, owner: "u1" });
  const r = await t.run({ to: "bob", message: "what is the plan?" }, ctx());
  assert.equal(r.ok, true);
  assert.equal(b.sent[0].decisionReceipt, undefined);
});

test("issuer: receipts are per turn end to end: filed in turn 1, used in turn 2 -> refused", async () => {
  const b = stubBus();
  const talk = createBotTalkTool({ bus: b.ref, owner: "u1" });
  const provider = new FakeProvider([
    { calls: [rec()] }, { text: "filed" },
    { calls: [call("2", "bot_talk", { to: "bob", message: "do x", request: true, decision_receipt: "doc-111" })] }, { text: "refused" },
  ]);
  const s = mk([], [talk, decisionTool("doc-111")], { provider, surface: "web" });
  await collect(s.send("think"));
  await collect(s.send("now ask bob"));
  assert.equal(b.sent.length, 0);
  assert.match(provider.requests.at(-1)!.messages.filter((m) => m.role === "tool").at(-1)!.content, /not a decision you filed in THIS turn/);
});

test("issuer: same turn: file the decision, then bot_talk with its id -> sent", async () => {
  const b = stubBus();
  const talk = createBotTalkTool({ bus: b.ref, owner: "u1" });
  const provider = new FakeProvider([{ calls: [rec()] }, { calls: [call("2", "bot_talk", { to: "bob", message: "do x", request: true, decision_receipt: "doc-111" })] }, { text: "sent" }]);
  const s = mk([], [talk, decisionTool("doc-111")], { provider, surface: "web" });
  await collect(s.send("ask bob to do x"));
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].decisionReceipt, "doc-111");
});

// ---------------------------------------------------------------- the real mind_decision_record tool
const fakeMind = (over: Partial<MindClient> = {}): MindClient => ({
  context: async () => "", query: async () => "", call: async () => "",
  remember: async () => "saved document abc123", ...over,
});
const realRecord = (c: MindClient) => createMindTools(c).find((t) => t.spec.name === "mind_decision_record")!;
const dargs = { subject: "send invoice", decision: "do it", owner_check: "x belongs to Acme; user asked about Acme; Acme == Acme" };

test("mind_decision_record returns its MIND id as the receipt; decline stance is flagged", async () => {
  const t = realRecord(fakeMind());
  const r = await t.run(dargs, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.meta?.decisionId, "abc123");
  assert.equal(r.meta?.declined, undefined);
  assert.match(r.output, /Decision receipt: abc123/);
  const d = await t.run({ ...dargs, stance: "decline" }, ctx());
  assert.equal(d.meta?.declined, true);
});

test("mind_decision_record files a PRIVATE document (never the feed) and tags it oocemr", async () => {
  const seen: any[] = [];
  const t = realRecord(fakeMind({ remember: async (a) => { seen.push(a); return "saved document q1"; } }));
  await t.run(dargs, ctx());
  assert.equal(seen[0].type, "document");
  assert.deepEqual(seen[0].tags, ["decision", "oocemr"]);
});

test("mind_decision_record with MIND down still returns a clearly-marked local receipt id", async () => {
  const t = realRecord(fakeMind({ remember: async () => { throw new Error("HTTP 503"); } }));
  const r = await t.run(dargs, ctx());
  assert.equal(r.ok, true);
  assert.match(String(r.meta?.decisionId), /^local-[0-9a-f]{12}$/);
  assert.match(r.output, /NOT saved to MIND/);
});

// ---------------------------------------------------------------- exchange + board records
test("exchange messages keep the decision receipts (requester on the request, receiver on the reply)", () => {
  const hub = new ExchangeHub(mkdtempSync(join(tmpdir(), "ex-")));
  const a = hub.append("u1", "main", "bot1", { from: "main", text: "do x", kind: "message", decisions: [{ id: "doc-req", role: "requester" }] });
  const b = hub.append("u1", "main", "bot1", { from: "bot1", text: "done", kind: "reply", decisions: [{ id: "doc-recv", role: "receiver" }] });
  assert.deepEqual(a.message.decisions, [{ id: "doc-req", role: "requester" }]);
  assert.deepEqual(b.message.decisions, [{ id: "doc-recv", role: "receiver" }]);
  assert.deepEqual(hub.get("u1", a.exchange.id)!.messages.map((m) => m.decisions?.[0].id), ["doc-req", "doc-recv"]);
});

test("board: a peer awaiting-decision item keeps both receipts through save/load; the model's own task_board input cannot forge one", () => {
  const c = checkTask({ id: "peer-1", title: "Awaiting", status: "stopped", question: "q" }, 5, undefined, { issuer: "doc-a", receiver: "doc-b", tool: "send_email" });
  assert.equal(c.ok && c.value.peer?.issuer, "doc-a");
  const back = loadTasks(JSON.parse(JSON.stringify([c.ok ? c.value : null])));
  assert.deepEqual(back[0].peer, { issuer: "doc-a", receiver: "doc-b", tool: "send_email" });
  const forged = checkTask({ id: "t", title: "x", status: "stopped", question: "q", peer: { issuer: "fake", receiver: "fake" } }, 5);
  assert.equal(forged.ok && forged.value.peer, undefined);
});

// ---------------------------------------------------------------- the bus carries the receipt, the chips read it
import { createBotBus } from "../../src/bots/bus.ts";
import type { BusManager } from "../../src/bots/bus.ts";
import { BotStore } from "../../src/bots/store.ts";
// @ts-ignore plain browser module, no declarations
import { decisionLabel } from "../../web/exchanges.js";
// @ts-ignore plain browser module, no declarations
import { labelOf } from "../../web/board.js";

test("bus: the issuer receipt reaches the recipient turn as a structured value (not text), is shown on the request, and the receiver's receipt lands on the reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bus-pd-"));
  const store = new BotStore({ dir, owner: "u1", mind: { list: async () => [], create: async () => {}, remove: async () => {} } });
  await store.create({ slug: "bob", name: "Bob", purpose: "p" });
  const rows = new Map<string, any>([["S", { owner: "u1", busy: true, turns: 1 }]]);
  const turns: { text: string; origin?: string; client?: any }[] = [];
  const mgr: BusManager = {
    async open(o) { rows.set(o.resumeId!, { owner: "u1", busy: false, turns: 0 }); return { id: o.resumeId! }; },
    get: (id) => rows.get(id),
    async turn(_id, text, onEvent, _sig, origin, _i, _p, client) {
      turns.push({ text, origin, client });
      onEvent({ type: "toolStart", receiptId: "c1", tool: "mind_decision_record", args: {} });
      onEvent({ type: "toolEnd", receiptId: "c1", tool: "mind_decision_record", ok: true, preview: "saved", decisionId: "doc-recv" });
      onEvent({ type: "done", finalText: "done it" });
    },
  };
  const exchanges = new ExchangeHub(join(dir, "ex"));
  const bus = createBotBus({ manager: mgr, botsFor: () => store, exchanges });
  const r = await bus.talk({ owner: "u1", fromSession: "S", to: "bob", message: "send the invoice", decisionReceipt: "doc-req" });
  assert.equal(r.ok, true, r.output);
  assert.equal(turns[0].origin, "bot");
  assert.deepEqual(turns[0].client, { peerReceipt: "doc-req" });
  assert.match(turns[0].text, /REQUEST for you to act[\s\S]*doc-req/);
  const msgs = exchanges.list("u1").map((s) => exchanges.get("u1", s.id)!.messages)[0];
  assert.deepEqual(msgs[0].decisions, [{ id: "doc-req", role: "requester" }]);
  assert.deepEqual(msgs[1].decisions, [{ id: "doc-recv", role: "receiver" }]);
  // a plain question: no receipt passed, the recipient is told it cannot act
  const q = await bus.talk({ owner: "u1", fromSession: "S", to: "bob", message: "how are you today" });
  assert.equal(q.ok, true);
  assert.equal(turns[1].client, undefined);
  assert.match(turns[1].text, /no decision receipt/);
});

test("web: the Decision chip label and the Awaiting decision board label", () => {
  assert.equal(decisionLabel({ id: "abc", role: "requester" }).text, "Decision ✓ abc");
  assert.match(decisionLabel({ id: "0123456789abcdef0123", role: "receiver" }).title, /Receiver/);
  assert.equal(labelOf({ status: "stopped", peer: { issuer: "a", receiver: "b" } }), "Awaiting decision");
  assert.equal(labelOf({ status: "stopped" }), "Waiting on you");
});
