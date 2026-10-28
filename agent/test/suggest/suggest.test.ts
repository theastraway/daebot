import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SuggestionStore, awaitsUser, buildMessages, generateReplies, parseReplies, tailOf } from "../../src/suggest/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { FakeProvider, baseCfg, collect } from "../core/helpers.ts";
import type { HistoryEvent, Provider, StreamEvent } from "../../src/types.ts";

const dir = () => mkdtempSync(join(tmpdir(), "sugg-"));

test("awaitsUser: questions, proposals and drafts yes; finished reports no", () => {
  assert.equal(awaitsUser("I drafted the reply to Sarah. Want me to send it?"), true);
  assert.equal(awaitsUser("Here is the plan. Let me know if that works."), true);
  assert.equal(awaitsUser("Which option do you prefer, A or B?"), true);
  assert.equal(awaitsUser("Shall I proceed with the merge"), true);
  assert.equal(awaitsUser("Done. PR 12 is merged and the deploy is live."), false);
  assert.equal(awaitsUser(""), false);
  assert.equal(awaitsUser("[aborted]"), false);
  assert.equal(awaitsUser("Done.", true), true, "a turn that ended on a typed confirmation always waits");
});

test("parseReplies: JSON, fenced JSON, dupes, long text, junk", () => {
  assert.deepEqual(parseReplies('{"replies":["Yes, send it","Change the subject"]}'), ["Yes, send it", "Change the subject"]);
  assert.deepEqual(parseReplies('```json\n{"replies":["a","A","b","c","d"]}\n```'), ["a", "b", "c"]);
  assert.deepEqual(parseReplies('{"replies":[]}'), []);
  assert.deepEqual(parseReplies("not json at all"), []);
  assert.deepEqual(parseReplies('{"replies":[1,null,"  ok  "]}'), ["ok"]);
  assert.ok(parseReplies(`{"replies":["${"x".repeat(900)}"]}`)[0].length <= 200);
});

test("tailOf: reads the last block only when the turn ended on it; retract drops a withdrawn draft", () => {
  const ev = (...e: HistoryEvent[]) => e;
  const t = tailOf(ev({ type: "user", text: "hi" }, { type: "text", delta: "Want me to send it?" }, { type: "usage", usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 }, totalCostUsd: 0 }, { type: "done", finalText: "" }));
  assert.equal(t?.lastText, "Want me to send it?");
  assert.equal(t?.endedOnConfirm, false);
  assert.equal(tailOf(ev({ type: "user", text: "hi" }, { type: "text", delta: "Working?" }, { type: "toolStart", receiptId: "c1", tool: "bash", args: {} })), undefined, "text then a tool: the turn is not over");
  assert.equal(tailOf(ev({ type: "user", text: "hi" }, { type: "text", delta: "draft" }, { type: "retract", reason: "r" })), undefined);
  const c = tailOf(ev({ type: "user", text: "do it" }, { type: "text", delta: "Ready." }, { type: "confirm", id: "x", tool: "t", args: {}, reason: "r" }));
  assert.equal(c?.endedOnConfirm, true);
  assert.deepEqual(t?.transcript, [{ role: "user", text: "hi" }, { role: "assistant", text: "Want me to send it?" }]);
});

test("store: records chosen / edited / ignored per user, caps and cleans input, feeds few-shot", () => {
  const d = dir();
  const s = new SuggestionStore(d, "u1");
  assert.equal(s.record({ shown: [], action: "chosen", picked: "x" }, "ask"), undefined, "nothing shown, nothing to learn");
  assert.equal(s.record({ shown: ["a"], action: "chosen" }, "ask"), undefined, "chosen needs the picked chip");
  assert.equal(s.record({ shown: ["a"], action: "bogus" as any, picked: "a" }, "ask"), undefined);
  s.record({ shown: ["Yes, send it", "Wait"], picked: "Yes, send it", sent: "Yes, send it", action: "chosen" }, "Want me to send the email to Sarah?");
  s.record({ shown: ["Yes", "No"], picked: "Yes", sent: "Yes but cc Mike", action: "edited" }, "Send the draft?");
  s.record({ shown: ["Ok", "No"], sent: "do it tomorrow morning", action: "ignored" }, "Send now?");
  s.record({ shown: ["Ok"], action: "ignored" }, "Anything else?");
  assert.deepEqual(s.stats(), { shown: 4, chosen: 1, edited: 1, ignored: 2 });
  const ex = s.examples();
  assert.deepEqual(ex.map((e) => [e.how, e.reply]), [["took", "Yes, send it"], ["edited", "Yes but cc Mike"], ["wrote their own", "do it tomorrow morning"]]);
  assert.equal(new SuggestionStore(d, "u1").stats().shown, 4, "persisted in the data dir");
  assert.equal(new SuggestionStore(d, "u2").stats().shown, 0, "per user");
  const big = s.record({ shown: ["a".repeat(2000), "b", "c", "d"], picked: "p".repeat(5000), sent: "q".repeat(9000), action: "edited" }, "z".repeat(5000))!;
  assert.equal(big.shown.length, 3);
  assert.ok(big.shown[0].length <= 300 && big.picked!.length <= 600 && big.sent!.length <= 1200 && big.ask.length <= 500);
  for (let i = 0; i < 320; i++) s.record({ shown: ["a"], picked: "a", sent: "a", action: "chosen" }, "ask");
  assert.ok(JSON.parse(readFileSync(join(d, "suggestions", "u1.json"), "utf8")).records.length <= 300);
});

test("the prompt carries the user's voice and the accepted examples, and never offers a pricier model", async () => {
  const msgs = buildMessages([{ role: "user", text: "ship it" }, { role: "assistant", text: "Draft ready. Send?" }], [{ ask: "Send the draft?", reply: "yes go, cc Mike", how: "took" }]);
  assert.match(msgs[1].content, /ship it/);
  assert.match(msgs[1].content, /yes go, cc Mike/);
  assert.match(msgs[0].content, /Output ONLY JSON/);
  const p = new FakeProvider([{ text: '{"replies":["Yes, send it","Hold on, change the tone"]}' }]);
  const r = await generateReplies({ provider: p, model: "m/cheap", transcript: [{ role: "assistant", text: "Send?" }], examples: [] });
  assert.deepEqual(r.replies, ["Yes, send it", "Hold on, change the tone"]);
  assert.equal(p.requests[0].model, "m/cheap");
  assert.deepEqual(p.requests[0].tools, [], "no tools on a suggestion call");
  const failing: Provider = { name: "x", async *stream(): AsyncIterable<StreamEvent> { throw new Error("boom"); } };
  assert.deepEqual((await generateReplies({ provider: failing, model: "m", transcript: [], examples: [] })).replies, [], "a failed call is simply no chips");
});

test("runtime: suggestions come from the cheap model only after a turn that waits, learn from feedback, and feed it back as few-shot", async () => {
  const stateDir = dir();
  const provider = new FakeProvider([
    { text: "I wrote the reply to Sarah. Want me to send it?" },
    { text: '{"replies":["Yes, send it","Change the subject line first","Add a note about Friday"]}' },
    { text: "Sent." },
    { text: '{"replies":["x"]}' },
    { text: '{"replies":["Yes, send it"]}' },
  ]);
  const failing = (async () => { throw new Error("offline"); }) as any;
  const rt = createRuntime(baseCfg({ mindApiKey: "k" }), { provider, fetchImpl: failing, stateDir });
  const s = await rt.openSession({ surface: "web", title: "t" });
  assert.deepEqual(await rt.suggestReplies!(s.id), { replies: [] }, "no turn yet: nothing to suggest");
  await collect(s.send("draft a reply to Sarah"));
  const r1 = await rt.suggestReplies!(s.id);
  assert.deepEqual(r1.replies, ["Yes, send it", "Change the subject line first", "Add a note about Friday"]);
  const suggestReq = provider.requests.at(-1)!;
  assert.equal(suggestReq.model, "m/cheap", "the configured cheap model, not the default");
  assert.deepEqual((await rt.suggestReplies!(s.id)).replies, r1.replies, "same turn: served from cache, no second model call");
  assert.equal(provider.requests.length, 2);
  // the user takes chip 1 unchanged
  assert.equal(rt.recordSuggestionFeedback!(s.id, { shown: r1.replies, picked: "Yes, send it", sent: "Yes, send it", action: "chosen" }), true);
  await collect(s.send("Yes, send it"));
  // a finished report: no model call, no chips
  const before = provider.requests.length;
  assert.deepEqual(await rt.suggestReplies!(s.id), { replies: [] });
  assert.equal(provider.requests.length, before);
  // the next suggestion call carries the accepted example
  const p2 = new FakeProvider([{ text: "Next: should I also email Mike?" }, { text: '{"replies":["Yes"]}' }]);
  const rt2 = createRuntime(baseCfg({ mindApiKey: "k" }), { provider: p2, fetchImpl: failing, stateDir });
  const s2 = await rt2.openSession({ surface: "web", title: "t2" });
  assert.equal(rt2.recordSuggestionFeedback!(s2.id, { shown: ["a"], picked: "a", sent: "a", action: "chosen" }), true);
  await collect(s2.send("hi"));
  await rt2.suggestReplies!(s2.id);
  assert.match(p2.requests.at(-1)!.messages[1].content, /Yes, send it/, "the earlier accepted reply is in the few-shot block");
  assert.equal(rt.recordSuggestionFeedback!("no-such-session", { shown: ["a"], picked: "a", action: "chosen" }), false);
});

test("runtime without a state dir offers neither feature", async () => {
  const failing = (async () => { throw new Error("offline"); }) as any;
  const rt = createRuntime(baseCfg({ mindApiKey: "k" }), { provider: new FakeProvider([{ text: "Want me to?" }]), fetchImpl: failing });
  assert.equal(rt.permissions, undefined);
  const s = await rt.openSession({ surface: "web", title: "t" });
  await collect(s.send("x"));
  assert.deepEqual(await rt.suggestReplies!(s.id), { replies: [] });
});

test("runtime: permissions are per owner and their preferences reach the system prompt", async () => {
  const stateDir = dir();
  const failing = (async () => { throw new Error("offline"); }) as any;
  const mk = (owner: string, p: FakeProvider) => createRuntime(baseCfg({ mindApiKey: "k" }), { provider: p, fetchImpl: failing, stateDir, owner });
  const pa = new FakeProvider([{ text: "a" }]);
  const a = mk("alice", pa), b = mk("bob", new FakeProvider([{ text: "b" }]));
  const o = a.permissions!.open({ sessionId: "x", facts: (await import("../../src/permissions/index.ts")).factsOf("bash", "write", { command: "rm -rf build" }, "/p"), args: {} });
  a.permissions!.decide(o.id, { decision: "deny", remember: "always", scope: "s1" });
  assert.equal(a.permissions!.store.rules().length, 1);
  assert.equal(b.permissions!.store.rules().length, 0, "bob never sees alice's rules");
  const s = await a.openSession({ surface: "web", title: "t" });
  await collect(s.send("hello"));
  const sys = pa.requests[0].messages[0].content;
  assert.match(sys, /User's permission preferences/);
  assert.match(sys, /NEVER do these[\s\S]*rm/);
});
