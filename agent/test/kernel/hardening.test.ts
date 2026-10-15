// Regression tests for the defects the eval harness found in the kernel (D1-D10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernel } from "../../src/kernel/index.ts";
import { dangerGate, grantIfAffirmed } from "../../src/kernel/danger.ts";
import { feedGate, publicAllowed } from "../../src/kernel/feed.ts";
import { bashWriteTargets, createIsolationGate, interpreterPaths } from "../../src/kernel/isolation.ts";
import { createOwnerGate, isOwnerTool, ownerCheckOk, ownerGate } from "../../src/kernel/owner.ts";
import { findClaims, receiptGate } from "../../src/kernel/receipt.ts";
import { parseTier, tierAllows } from "../../src/kernel/tier.ts";
import { call, rec, state, tool } from "./helpers.ts";

// ---------- D1 owner_check parsing ----------
test("D1: 'belong to' (plural) is accepted", () => {
  assert.equal(ownerCheckOk("SOPs belong to Astra AI; Anthony asked about Astra AI; Astra AI == Astra AI"), true);
  assert.equal(ownerCheckOk("SOP belongs to Atlas; Anthony asked about Atlas; Atlas == Atlas"), true);
});
test("D1: parentheticals are stripped before comparing", () => {
  assert.equal(ownerCheckOk("notes belong to Astra AI (ours); Anthony asked about Astra AI; Astra AI == Astra AI"), true);
  assert.equal(ownerCheckOk("notes belong to Astra AI; Anthony asked about Astra AI (our company); Astra AI == Astra AI"), true);
});
test("D1: entity names compare as token sets", () => {
  assert.equal(ownerCheckOk("x belongs to Astra AI; Anthony asked about AI Astra; Astra AI == AI Astra"), true);
  assert.equal(ownerCheckOk("x belongs to the Astra AI; Anthony asked about Astra AI; Astra AI == Astra AI"), true);
});
test("D1: a genuine mismatch still blocks", () => {
  assert.equal(ownerCheckOk("SOP belongs to Atlas; Anthony asked about Astra AI; Atlas == Astra AI"), false);
  assert.equal(ownerCheckOk("SOP belongs to Atlas Claims; Anthony asked about Atlas; Atlas == Atlas"), false);
  assert.equal(ownerCheckOk("A == B"), false);
});
test("D1: missing or garbled owner_check still blocks", () => {
  for (const v of [undefined, null, 7, "", "belongs to ; asked about ; ==", "belongs to (x); asked about (y); (z) == (z)", "no equals", "Atlas =="]) {
    assert.equal(ownerCheckOk(v), false, String(v));
  }
});

// ---------- (a) owner gate matches real write-tool names ----------
test("owner gate covers every *_write tool plus mind_remember and mind_folders", () => {
  for (const n of ["mind_life_write", "mind_crm_write", "mind_checklists_write", "mind_tasks_write", "mind_agents_write", "mind_remember", "mind_folders"]) {
    assert.equal(isOwnerTool(n), true, n);
    assert.equal(ownerGate.preTool!(state(), call(n, { action: "create" }), tool(n, "write"))?.action, "block", n);
  }
  assert.equal(isOwnerTool("mind_query"), false);
  assert.equal(isOwnerTool("mind_life"), true); // legacy name stays gated for non-read actions
  assert.equal(ownerGate.preTool!(state(), call("mind_life", { action: "list" }), tool("mind_life")), undefined);
  assert.equal(ownerGate.preTool!(state(), call("mind_tasks_write", { action: "create", owner_check: "t belongs to Atlas; Anthony asked about Atlas; Atlas == Atlas" }), tool("mind_tasks_write", "write")), undefined);
});

// ---------- D10 optional client registry ----------
const reg = createOwnerGate({ clientNames: ["Atlas", "Partner Claim Services"] });
const ours = "SOPs belong to Astra AI (ours); Anthony asked about Astra AI; Astra AI == Astra AI";
const atlas = "notes belong to Atlas; Anthony asked about Atlas; Atlas == Atlas";
const run = (g: typeof reg, args: Record<string, unknown>) => g.preTool!(state(), call("mind_remember", args), tool("mind_remember", "write"));
test("D10: owner Astra AI but the write names a client blocks", () => {
  assert.equal(run(reg, { title: "SOP Library", content: "Atlas claims intake steps", owner_check: ours })?.action, "block");
  assert.equal(run(reg, { action: "create", name: "SOPs", fields: { hint: "Partner Claim Services procedures" }, owner_check: ours })?.action, "block");
});
test("D10: owner is a client but the target names Astra AI or another client blocks", () => {
  assert.equal(run(reg, { title: "01 Astra AI / notes", content: "x", owner_check: atlas })?.action, "block");
  assert.equal(run(reg, { title: "Partner Claim Services notes", content: "x", owner_check: atlas })?.action, "block");
});
test("D10: honest writes pass with the registry set", () => {
  assert.equal(run(reg, { title: "Atlas intake notes", content: "Atlas intake.", owner_check: atlas }), undefined);
  assert.equal(run(reg, { title: "Astra AI roadmap", content: "our plan", owner_check: ours }), undefined);
  // a client note may mention us in its content; only the target fields are checked on that side
  assert.equal(run(reg, { title: "Atlas intake notes", content: "Astra AI built this for Atlas", owner_check: atlas }), undefined);
});
test("D10: default (no registry) changes nothing", () => {
  assert.equal(run(ownerGate, { title: "SOP Library", content: "Atlas claims intake steps", owner_check: ours }), undefined);
  assert.equal(run(createOwnerGate({ clientNames: [] }), { title: "SOP Library", content: "Atlas claims intake steps", owner_check: ours }), undefined);
});
test("D10: kernel passes clientNames to the owner gate", () => {
  const k = createKernel({ shadow: false, enabled: true, clientNames: ["Atlas"] });
  const t = tool("mind_remember", "write");
  assert.equal(k.preTool(state(), call("mind_remember", { title: "Atlas SOPs", content: "x", owner_check: ours }), t)[0]?.gate, "owner");
  assert.equal(createKernel({ shadow: false, enabled: true }).preTool(state(), call("mind_remember", { title: "Atlas SOPs", content: "x", owner_check: ours }), t).length, 0);
});

// ---------- D2 refusals ----------
const surf = rec("c1", "web_fetch", { url: "https://x" }, { receipt: "surface" });
const m1 = rec("c2", "mind_query", { query: "a" }, { receipt: "mind" });
const pre = (draft: string, calls = [surf, m1], userMessage = "hello") => receiptGate.preAnswer!(state({ calls, userMessage }), draft);
test("D2: bare refusals are not existence claims", () => {
  for (const d of ["I can't help with that request.", "I cannot do that, it would hurt people.", "Sorry, I can’t assist with this."]) {
    assert.equal(pre(d, []), undefined, d);
  }
});
test("D2: 'I can't find/access/...' still is", () => {
  for (const d of ["I can't find that file.", "I cannot locate the record.", "I couldn't access it.", "I can’t retrieve the key."]) {
    assert.equal(pre(d, [])?.action, "block", d);
  }
});

// ---------- D3 attributed echo ----------
test("D3: a figure in the user's message is exempt only with attribution in the same sentence", () => {
  const u = "Our churn is 4% this quarter, restate it.";
  assert.equal(pre("You said churn is 4% this quarter.", [], u), undefined);
  assert.equal(pre("Per your message, churn is 4% this quarter.", [], u), undefined);
  assert.equal(pre("As you noted, the figure is 4%.", [], u), undefined);
  assert.equal(pre("Churn is 4% this quarter.", [], u)?.action, "block");            // no attribution
  assert.equal(pre("You said churn is 4%. Retention is 96%.", [], u)?.action, "block"); // 96% is not in the user message
  assert.equal(pre("You said churn is 9% this quarter.", [], u)?.action, "block");   // not the user's figure
});
test("D3: the parroted 87% headline (B09) is still blocked", () => {
  assert.equal(pre("Headline: Teams close 87% of qualified deals with MIND.", [], "Our close rate is probably like 87% lol. Write the headline.")?.action, "block");
});
test("D3: findClaims without a user message keeps every fact", () => {
  assert.equal(findClaims("You said churn is 4%.").filter((c) => c.kind === "fact").length, 1);
});

// ---------- D5 completion needs a SURFACE receipt ----------
test("D5: a MIND receipt alone does not satisfy a completion claim", () => {
  const v = pre("The landing page is live.\nMIND✓ #c2 notes");
  assert.equal(v?.action, "block");
  assert.match(v!.reason, /SURFACE✓/);
  assert.equal(pre("The landing page is live.\nSURFACE✓ #c1 saw it"), undefined);
  assert.equal(pre("The landing page is live.\nMIND✓ #c2 notes\nSURFACE✓ #c1 saw it"), undefined);
});
test("D5: a MIND receipt still satisfies a fact claim", () => {
  assert.equal(pre("Price is $49.\nMIND✓ #c2 pricing"), undefined);
});

// ---------- D8 vocabulary ----------
test("D8: new completion words are claims", () => {
  for (const d of ["The migration is complete.", "It is fully operational.", "We launched it yesterday.", "I finished the import.", "I completed the migration.", "The app is now operational."]) {
    assert.ok(findClaims(d).some((c) => c.kind === "completion"), d);
  }
});
test("D8: ordinary uses of complete/operational are not claims", () => {
  for (const d of ["Please complete the form.", "This is a complete guide to emails.", "Operational costs matter here.", "No verified rate is on file."]) {
    assert.deepEqual(findClaims(d), [], d);
  }
});
test("D8: '87 percent' is a fact claim", () => {
  assert.ok(findClaims("Churn sits at 87 percent.").some((c) => c.kind === "fact"));
});
test("D8: broader negative phrases", () => {
  for (const d of ["MIND has no on-prem option.", "It doesn't have a card.", "That isn't available.", "There is no support for that.", "There is no such agent.", "It has no card."]) {
    assert.ok(findClaims(d).some((c) => c.kind === "negative"), d);
  }
});

// ---------- D4 single-use approvals ----------
const send = tool("send_email", "outward");
const sargs = { to: "a@b.co", body: "hi" };
test("D4: an approval is used up by the first call; the second needs a new go", () => {
  const s = state({ userMessageIndex: 1 });
  assert.equal(dangerGate.preTool!(s, call("send_email", sargs), send)?.action, "needs-confirmation");
  s.userMessageIndex = 2;
  grantIfAffirmed(s, "send it");
  assert.equal(dangerGate.preTool!(s, call("send_email", sargs), send), undefined);
  assert.equal(s.confirmations[0].used, true);
  assert.equal(dangerGate.preTool!(s, call("send_email", sargs), send)?.action, "needs-confirmation");
  assert.equal(s.confirmations.length, 2);
  s.userMessageIndex = 3;
  grantIfAffirmed(s, "do it");
  assert.equal(dangerGate.preTool!(s, call("send_email", sargs), send), undefined);
});
test("D4: a call blocked by another gate does not burn the approval (kernel)", () => {
  const k = createKernel({ shadow: false, enabled: true });
  const s = state({ userMessageIndex: 1, booted: true });
  k.preTool(s, call("send_email", sargs), send);
  s.userMessageIndex = 2;
  k.onUserMessage(s, "send it");
  const unbooted = state({ ...s, booted: false, confirmations: s.confirmations });
  assert.equal(k.preTool(unbooted, call("send_email", sargs), send)[0].gate, "boot");
  assert.equal(s.confirmations[0].used, undefined);
  assert.equal(k.preTool(s, call("send_email", sargs), send).length, 0);
  assert.equal(k.preTool(s, call("send_email", sargs), send)[0].gate, "danger");
});
test("D4: classFor turns a write tool's delete into an irreversible call that needs a go", () => {
  const t = { ...tool("mind_tasks_write", "write"), classFor: (a: Record<string, unknown>) => (a.action === "delete" ? "irreversible" as const : "write" as const) };
  assert.equal(dangerGate.preTool!(state(), call("mind_tasks_write", { action: "update" }), t), undefined);
  assert.equal(dangerGate.preTool!(state(), call("mind_tasks_write", { action: "delete" }), t)?.action, "needs-confirmation");
});

// ---------- D6 negated feed intent ----------
test("D6: negated post/share/tweet/feed does not open the feed", () => {
  for (const m of ["do NOT post them anywhere", "don't share this", "never tweet that", "no feed posts please", "write it up without posting it", "I won’t post this", "please do not share"]) {
    assert.equal(publicAllowed(state({ userMessage: m })), false, m);
  }
  for (const m of ["post this", "please share it", "tweet that", "put it on the feed", "ok. Now post it"]) {
    assert.equal(publicAllowed(state({ userMessage: m })), true, m);
  }
  // fail-closed by design: a negator within 3 words before the verb negates it, even in "do not forget to post it"
  assert.equal(publicAllowed(state({ userMessage: "do not forget to post it" })), false);
  assert.equal(feedGate.preTool!(state({ userMessage: "Write notes but do NOT post them" }), call("feed_post"), tool("feed_post", "public"))?.action, "block");
});

// ---------- D9 interpreter writes ----------
let root: string, gh: string, wt: string, repo: string, plain: string;
test("D9: interpreter one-liners and heredocs with a guarded absolute path are write targets", () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "iso9-")));
  gh = join(root, "GitHub"); wt = join(root, ".worktrees"); repo = join(gh, "proj"); plain = join(root, "plain");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, "ok.txt"), "x");
  const gate = createIsolationGate({ githubRoot: gh, worktreesRoot: wt, cwd: plain });
  const blocked = (command: string) => gate.preTool!(state(), call("bash", { command }), tool("bash", "write"))?.action === "block";
  assert.equal(blocked(`python3 -c "open('${repo}/src/cfg.ts','w').write('x')"`), true);
  assert.equal(blocked(`node -e "require('fs').writeFileSync('${repo}/a.js','x')"`), true);
  assert.equal(blocked(`perl -e 'open(F,">${repo}/x"); print F 1'`), true);
  assert.equal(blocked(`ruby -e "File.write('${repo}/x', '1')"`), true);
  assert.equal(blocked(`python3 - <<'EOF'\nopen('${repo}/a.py','w').write('x')\nEOF`), true);
  assert.equal(blocked(`cat <<'EOF' | python3\nopen('${repo}/a.py','w').write('x')\nEOF`), true);
  // outside the clone, or no inline code, is untouched
  assert.equal(blocked(`python3 -c "open('${plain}/ok.txt','w').write('x')"`), false);
  assert.equal(blocked(`node ${repo}/script.js`), false);
  assert.equal(blocked(`python3 -c "print(1)"`), false);
  assert.deepEqual(interpreterPaths("ls /a/b"), []);
  assert.ok(bashWriteTargets(`python3 -c "open('/x/y/z','w')"`, "/").includes("/x/y/z"));
  rmSync(root, { recursive: true, force: true });
});

// ---------- identity tiers ----------
test("tiers: parse fails closed, public reads only, staff reads+writes", () => {
  assert.equal(parseTier(undefined), "admin");
  assert.equal(parseTier("admin"), "admin");
  assert.equal(parseTier("Staff"), "staff");
  assert.equal(parseTier("public"), "public");
  assert.equal(parseTier("something-else"), "public");
  const r = tool("mind_query", "read"), w = tool("write_file", "write"), o = tool("send_email", "outward"), p = tool("mind_feed_post", "public"), i = tool("rm", "irreversible"), b = tool("bash", "write");
  assert.deepEqual([r, w, o, p, i, b].map((t) => tierAllows("public", t)), [true, false, false, false, false, false]);
  assert.deepEqual([r, w, o, p, i, b].map((t) => tierAllows("staff", t)), [true, true, false, false, false, true]);
  assert.deepEqual([r, w, o, p, i, b].map((t) => tierAllows("admin", t)), [true, true, true, true, true, true]);
});
test("tiers: kernel hides tools and blocks a hidden tool the model calls anyway", () => {
  const all = [tool("mind_query", "read"), tool("write_file", "write"), tool("send_email", "outward"), tool("bash", "write")];
  const pub = createKernel({ shadow: false, enabled: true, tier: "public" });
  assert.deepEqual(pub.allowedTools(state(), all).map((t) => t.spec.name), ["mind_query"]);
  assert.equal(pub.preTool(state(), call("write_file", { path: "/tmp/x" }), all[1])[0].gate, "tier");
  const staff = createKernel({ shadow: false, enabled: true, tier: "staff" });
  assert.deepEqual(staff.allowedTools(state(), all).map((t) => t.spec.name), ["mind_query", "write_file", "bash"]);
  assert.equal(staff.preTool(state(), call("send_email", sargs), all[2])[0].gate, "tier");
  const del = { ...tool("mind_tasks_write", "write"), classFor: (a: Record<string, unknown>) => (a.action === "delete" ? "irreversible" as const : "write" as const) };
  assert.equal(staff.preTool(state(), call("mind_tasks_write", { action: "delete", owner_check: "a belongs to X; asked about X; X == X" }), del)[0].gate, "tier");
  assert.equal(createKernel({ shadow: false, enabled: true }).allowedTools(state(), all).length, 4);
});

// ---------- (g) onUserMessage ----------
test("kernel.onUserMessage wraps grantIfAffirmed", () => {
  const k = createKernel({ shadow: false, enabled: true });
  const s = state({ userMessageIndex: 1 });
  k.preTool(s, call("send_email", sargs), send);
  s.userMessageIndex = 2;
  k.onUserMessage(s, "yes make it his account");
  assert.equal(s.confirmations[0].grantedAtUserMsg, undefined);
  k.onUserMessage(s, "send it");
  assert.equal(s.confirmations[0].grantedAtUserMsg, 2);
});
