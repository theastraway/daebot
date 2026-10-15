import { test } from "node:test";
import assert from "node:assert/strict";
import { findClaims, receiptGate, validReceipts } from "../../src/kernel/receipt.ts";
import { rec, state } from "./helpers.ts";

const surf = rec("c1", "web_fetch", { url: "https://x" }, { receipt: "surface" });
const m1 = rec("c2", "mind_query", { query: "what is Leo" }, { receipt: "mind" });
const m2 = rec("c3", "mind_query", { query: "Leo agent card details" }, { receipt: "mind" });
const pre = (draft: string, calls = [surf, m1, m2]) => receiptGate.preAnswer!(state({ calls }), draft);

test("receipt: plain chatty answer allowed", () => {
  assert.equal(pre("Sure, here is how that works. The function takes two arguments."), undefined);
});
test("receipt: completion claim without receipt blocked, one-line reason", () => {
  const v = pre("The page is done.");
  assert.equal(v?.action, "block");
  assert.equal(v?.reason, "claim 'done' has no valid receipt: run a check and cite it as SURFACE✓ #cN");
  assert.ok(!v!.reason.includes("\n"));
});
test("receipt: valid SURFACE receipt passes", () => {
  assert.equal(pre("The page is deployed.\nSURFACE✓ #c1 fetched the page and saw it"), undefined);
});
test("receipt: valid MIND receipt passes a fact claim", () => {
  assert.equal(pre("Price is $49.\nMIND✓ #c2 pricing doc"), undefined);
});
test("receipt: nonexistent id blocked", () => {
  const v = pre("It is built.\nSURFACE✓ #c9 looked");
  assert.equal(v?.action, "block");
  assert.match(v!.reason, /#c9 is not a call from this turn/);
});
test("receipt: receipt from previous turn blocked", () => {
  const old = rec("c1", "web_fetch", {}, { receipt: "surface" });
  const s = state({ calls: [], allCalls: [old] });
  assert.equal(receiptGate.preAnswer!(s, "It is shipped.\nSURFACE✓ #c1 saw it")?.action, "block");
});
test("receipt: MIND✓ citing a surface call blocked", () => {
  const v = pre("It is fixed.\nMIND✓ #c1 checked");
  assert.equal(v?.action, "block");
  assert.match(v!.reason, /surface call, not mind/);
});
test("receipt: SURFACE✓ citing a mind call blocked", () => {
  assert.equal(pre("It is fixed.\nSURFACE✓ #c2 checked")?.action, "block");
});
test("receipt: failed call receipt invalid", () => {
  const bad = rec("c1", "web_fetch", {}, { receipt: "surface", ok: false });
  assert.equal(pre("It is live.\nSURFACE✓ #c1 saw it", [bad])?.action, "block");
});
test("receipt: call without receipt kind invalid", () => {
  const plain = rec("c1", "bash", {});
  assert.equal(pre("It is working.\nSURFACE✓ #c1 ran", [plain])?.action, "block");
});
test("receipt: claim inside code fence ignored", () => {
  assert.equal(pre("Example output:\n```\nStatus: done and deployed, $5, bob@x.com\n```\nThat is the format."), undefined);
});
test("receipt: claim inside inline code or quotes ignored", () => {
  assert.equal(pre("Set the flag to `done` when needed."), undefined);
  assert.equal(pre('He said "it is done" yesterday.'), undefined);
});
test("receipt: questions ignored", () => {
  assert.equal(pre("Is it deployed? Are we ready? Does it cost $5?"), undefined);
});
test("receipt: negative claim with one query blocked", () => {
  const v = pre("That feature doesn't exist.\nMIND✓ #c2 searched", [m1]);
  assert.equal(v?.action, "block");
  assert.match(v!.reason, /negative claim/);
});
test("receipt: negative claim with two differently worded queries allowed", () => {
  assert.equal(pre("That feature doesn't exist.\nMIND✓ #c2 searched twice"), undefined);
});
test("receipt: same query twice does not satisfy negative claim", () => {
  const dup = rec("c3", "mind_query", { query: "  WHAT is leo " }, { receipt: "mind" });
  assert.equal(pre("There is no such card.\nMIND✓ #c2 searched", [m1, dup])?.action, "block");
});
test("receipt: list_bare satisfies negative claim", () => {
  const bare = rec("c1", "mind_agents", { action: "list", list_bare: true }, { receipt: "mind" });
  assert.equal(pre("There is no such agent.\nMIND✓ #c1 bare list", [bare]), undefined);
});
test("receipt: negative claim with no receipt line blocked even with queries", () => {
  assert.equal(pre("I can't find that, it is not available.")?.action, "block");
});
test("receipt: email claim without receipt blocked", () => {
  assert.equal(pre("Reach him at andrew@ysf.org")?.action, "block");
});
test("receipt: price, percent, id, phone claims blocked", () => {
  assert.equal(pre("It costs $1,200.50 a month.")?.action, "block");
  assert.equal(pre("Accuracy is 87%.")?.action, "block");
  assert.equal(pre("The id is 13b0693d.")?.action, "block");
  assert.equal(pre("Call 603-555-1234 today.")?.action, "block");
});
test("receipt: curly apostrophe negatives detected", () => {
  assert.equal(pre("It doesn’t exist.")?.action, "block");
});
test("receipt: word boundaries (undone, alive do not trigger)", () => {
  assert.equal(pre("Leave it undone for now, and keep the alive process."), undefined);
});
test("receipt: receipt lines themselves are not claims", () => {
  assert.equal(pre("Here you go.\nSURFACE✓ #c1 page shows it is live and done"), undefined);
});
test("receipt: receipt inside a code fence does not count", () => {
  assert.equal(pre("It is done.\n```\nSURFACE✓ #c1 saw\n```")?.action, "block");
});
test("receipt: multiple receipts, one valid is enough", () => {
  assert.equal(pre("It is merged.\nSURFACE✓ #c9 bogus\nSURFACE✓ #c1 real"), undefined);
});
test("findClaims: kinds and text", () => {
  const c = findClaims("It is deployed. There is no card. Email a@b.co. Is it done?");
  assert.deepEqual(c.map((x) => x.kind).sort(), ["completion", "fact", "negative"]);
});
test("validReceipts: reports validity and reasons", () => {
  const r = validReceipts("MIND✓ #c2 x\nMIND✓ #c1 y\nSURFACE✓ #c7 z", [surf, m1]);
  assert.deepEqual(r.map((x) => x.valid), [true, false, false]);
});
test("receipt: no claims and no receipts returns undefined", () => {
  assert.equal(pre(""), undefined);
});
