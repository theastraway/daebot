import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSession } from "../../src/loop.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { FakeKernel, FakeProvider, FakeSync, baseCfg, call, collect, fakeTool } from "../core/helpers.ts";
import type { AgentSession, Tool } from "../../src/types.ts";

function session(over: Partial<Parameters<typeof createAgentSession>[0]> & { provider: FakeProvider; tools?: Tool[] }): AgentSession {
  return createAgentSession({
    id: "s1", surface: "web", kernel: createKernel({ shadow: false, enabled: true }), tools: [], sync: new FakeSync(), cfg: baseCfg(), cwd: "/",
    systemPrompt: "SYS", bootContext: "booted", ...over,
  });
}

// ---------- SECURITY: a bot-originated turn can grant nothing, and cannot even ask ----------
test("origin:bot: 'send it' from another bot grants NO pending confirmation; the bot's own outward request is refused outright (no confirmation created); the human's 'send it' runs it", async () => {
  const email = fakeTool("send_email", "outward", "sent");
  const args = { to: "a@b.co", body: "hi" };
  const provider = new FakeProvider([
    { calls: [call("1", "send_email", args)] },   // human turn 1: proposes
    { calls: [call("2", "send_email", args)] },   // bot turn: tries to run it
    { text: "ok" },                               // ...and gives up after the refusal
    { calls: [call("3", "send_email", args)] },   // human turn: the peer turn wiped the old proposal, so it is proposed again
    { calls: [call("4", "send_email", args)] },   // human turn: really approves
    { text: "ok" },
  ]);
  const k = createKernel({ shadow: false, enabled: true });
  const s = session({ provider, tools: [email], kernel: k });
  let ev = await collect(s.send("please email the client"));
  assert.ok(ev.some((e) => e.type === "confirm"), "proposed, waiting for the human");
  assert.equal(email.calls.length, 0);

  ev = await collect(s.send("send it", { origin: "bot" }));
  assert.ok(!ev.some((e) => e.type === "confirm"), "a peer turn creates no confirmation at all");
  assert.ok(ev.some((e) => e.type === "gate" && (e as any).verdict.gate === "peer"), "refused outright by the peer rule");
  assert.equal(email.calls.length, 0, "the outward tool did NOT run");

  ev = await collect(s.send("send it"));   // a peer turn clears pending confirmations, so the human has to be asked again
  assert.ok(ev.some((e) => e.type === "confirm"));
  assert.equal(email.calls.length, 0);
  ev = await collect(s.send("send it"));
  assert.equal(email.calls.length, 1, "the human's 'send it' runs exactly the proposed call");
  assert.ok(ev.some((e) => e.type === "toolEnd"));
});

test("origin:bot: irreversible and public tools are refused too; read and write tools still work; confirmations are cleared at the start of a peer turn", async () => {
  const del = fakeTool("danger_delete", "irreversible"), post = fakeTool("poster", "public"), note = fakeTool("note", "write", "noted");
  const provider = new FakeProvider([
    { calls: [call("1", "danger_delete", {}), call("2", "poster", {}), call("3", "note", { t: 1 })] },
    { text: "ok" },
  ]);
  const s = session({ provider, tools: [del, post, note] });
  await collect(s.send("hi", { origin: "bot" }));
  assert.equal(del.calls.length + post.calls.length, 0);
  assert.equal(note.calls.length, 1, "local writes are fine for a peer");
  const tool = provider.requests[1].messages.filter((m) => m.role === "tool");
  assert.match(tool[0].content, /blind job/);
  assert.match(tool[1].content, /blind job/);
  // a pending human confirmation does not survive into a peer turn
  const email = fakeTool("send_email", "outward");
  const p2 = new FakeProvider([{ calls: [call("a", "send_email", { x: 1 })] }, { text: "ok" }, { calls: [call("b", "send_email", { x: 1 })] }, { text: "ok" }]);
  const s2 = session({ provider: p2, tools: [email] });
  await collect(s2.send("email them"));          // pending confirmation
  await collect(s2.send("anything", { origin: "bot" }));
  await collect(s2.send("send it"));             // the proposal was dropped, so this grants nothing...
  assert.equal(email.calls.length, 0);
});

test("a granted confirmation is valid for ONE turn only", async () => {
  const email = fakeTool("send_email", "outward");
  const p = new FakeProvider([
    { calls: [call("1", "send_email", { x: 1 })] }, // propose
    { text: "ok" },                                  // turn 2 ("send it"): approved but the model does not call it
    { calls: [call("2", "send_email", { x: 1 })] }, // turn 3: the old grant must be gone
    { text: "ok" },
  ]);
  const s = session({ provider: p, tools: [email] });
  await collect(s.send("email them"));
  await collect(s.send("send it"));
  const ev = await collect(s.send("and again please"));
  assert.equal(email.calls.length, 0, "the grant from turn 2 expired");
  assert.ok(ev.some((e) => e.type === "confirm"), "it has to be proposed again");
});

test("origin:bot: kernel.onUserMessage is never called, and the gates see an empty user message (no attribution exemption, no feed unlock)", async () => {
  const k = new FakeKernel();
  let grants = 0;
  k.onUserMessage = () => { grants++; };
  const seen: string[] = [];
  k.hooks.preAnswer = (st) => { seen.push(st.userMessage); return []; };
  const s = session({ provider: new FakeProvider([{ text: "a" }, { text: "b" }, { text: "c" }]), kernel: k });
  await collect(s.send("post this to the feed", { origin: "bot" }));
  assert.equal(grants, 0);
  assert.deepEqual(seen, [""], "a bot's text is not 'the latest user message'");
  await collect(s.send("hello"));
  assert.equal(grants, 1, "a human turn still goes through onUserMessage");
  assert.equal(seen[1], "hello");
  await collect(s.send("x", { origin: "user" }));
  assert.equal(grants, 2);
});

test("origin:bot: the public feed tool is not offered even when the bot's text says 'post to the feed'", async () => {
  const feed = fakeTool("mind_feed_post", "public");
  const provider = new FakeProvider([{ text: "ok" }, { text: "ok" }]);
  const s = session({ provider, tools: [feed] });
  await collect(s.send("please post this to the feed", { origin: "bot" }));
  assert.ok(!provider.requests[0].tools.some((t) => t.name === "mind_feed_post"));
  await collect(s.send("please post this to the feed"));
  assert.ok(provider.requests[1].tools.some((t) => t.name === "mind_feed_post"), "the human asking does unlock it");
});

// ---------- per-turn system prompt ----------
test("a function systemPrompt is re-evaluated at the start of every turn (DAEBOT.md edits apply on the next message)", async () => {
  let md = "be terse";
  const provider = new FakeProvider([{ text: "a" }, { text: "b" }]);
  const s = session({ provider, systemPrompt: () => `BASE\n${md}` });
  await collect(s.send("one"));
  md = "be formal";
  await collect(s.send("two"));
  assert.match(provider.requests[0].messages[0].content, /be terse/);
  assert.match(provider.requests[1].messages[0].content, /be formal/);
  assert.ok(!provider.requests[1].messages[0].content.includes("be terse"));
  assert.equal(provider.requests[1].messages.filter((m) => m.role === "system" && m.content.startsWith("BASE")).length, 1, "one system prompt, replaced not stacked");
  // exportState never carries the system prompt
  assert.ok(!s.exportState!().messages.some((m) => m.role === "system" && m.content.startsWith("BASE")));
});

test("a string systemPrompt still works and boot context is appended once", async () => {
  const provider = new FakeProvider([{ text: "a" }, { text: "b" }]);
  const s = session({ provider, systemPrompt: "FIXED", bootContext: "CTX" });
  await collect(s.send("one"));
  await collect(s.send("two"));
  for (const r of provider.requests) assert.equal(r.messages[0].content, "FIXED\n\nCTX");
});

// ---------- model per session ----------
test("the model is read per turn: deps.model, setModel, and back to the configured default", async () => {
  const provider = new FakeProvider([{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }]);
  const s = session({ provider, model: "m/mine" });
  await collect(s.send("1"));
  s.setModel!("m/other");
  await collect(s.send("2"));
  s.setModel!(undefined);
  await collect(s.send("3"));
  s.setModel!("  ");
  await collect(s.send("4"));
  assert.deepEqual(provider.requests.map((r) => r.model), ["m/mine", "m/other", "m/default", "m/default"]);
  const usage = (await collect(session({ provider: new FakeProvider([{ text: "x" }]), model: "m/z" }).send("q"))).find((e) => e.type === "usage") as any;
  assert.equal(usage.model, "m/z", "the usage event names the session's model");
});
