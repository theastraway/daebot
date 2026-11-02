import { test } from "node:test";
import assert from "node:assert/strict";
import { coderAllows, parseCoders, repoAllowed, isGithubHost } from "../../src/kernel/coder.ts";
import { createTierGate, tierAllows } from "../../src/kernel/tier.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { composeSystemPrompt } from "../../src/runtime.ts";
import type { Tool } from "../../src/types.ts";
import { state } from "./helpers.ts";

const VALUE = '{"andrewcastaldi":{"repos":["theastraway/castaldi-*","theastraway/ysf-*"]}}';
const grant = parseCoders(VALUE).coders.get("andrewcastaldi")!;

function gh(tool: string, over: Partial<Tool> = {}, host = "api.githubcopilot.com"): Tool {
  return {
    spec: { name: `github__${tool}`, description: tool, parameters: { type: "object" } },
    class: "outward", mcp: { server: "github", host, tool },
    async run() { return { ok: true, output: "" }; }, ...over,
  };
}

test("parseCoders: the exact value to set parses; bad input grants nothing", () => {
  const ok = parseCoders(VALUE);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.coders.get("andrewcastaldi")?.repos, ["theastraway/castaldi-*", "theastraway/ysf-*"]);
  for (const bad of [undefined, "", "   ", "not json", "[]", '"x"', '{"a":{}}', '{"a":{"repos":[]}}', '{"a":{"repos":["*"]}}', '{"a":{"repos":["*/*"]}}', '{"a":{"repos":["theastraway/*"]}}', '{"a":{"repos":["*/castaldi-x"]}}', '{"a":{"repos":["../x"]}}']) {
    assert.equal(parseCoders(bad).coders.size, 0, String(bad));
  }
  assert.ok(parseCoders("not json").problems.length === 1);
  // usernames are case-insensitive; a good pattern survives next to a bad one
  const mixed = parseCoders('{"AndrewCastaldi":{"repos":["TheAstraWay/Castaldi-*","*"]}}');
  assert.deepEqual(mixed.coders.get("andrewcastaldi")?.repos, ["theastraway/castaldi-*"]);
});

test("repoAllowed: globs match inside the owner, case-insensitively, and nothing else", () => {
  assert.equal(repoAllowed(grant, "theastraway", "castaldi-site"), true);
  assert.equal(repoAllowed(grant, "TheAstraWay", "Castaldi-Site"), true);
  assert.equal(repoAllowed(grant, "theastraway", "ysf-portal"), true);
  assert.equal(repoAllowed(grant, "theastraway", "castaldi-"), true, "empty * part still matches the prefix");
  // outside the globs
  assert.equal(repoAllowed(grant, "theastraway", "daebot"), false);
  assert.equal(repoAllowed(grant, "theastraway", "MINDapp"), false);
  assert.equal(repoAllowed(grant, "someone-else", "castaldi-site"), false, "right repo name, wrong owner");
  assert.equal(repoAllowed(grant, "theastraway", "xcastaldi-site"), false, "pattern is anchored at the start");
  assert.equal(repoAllowed(grant, "theastraway", "castaldi"), false);
  // hostile or malformed names never match
  for (const [o, r] of [["theastraway", "castaldi-x/../daebot"], ["theastraway/castaldi-x", "daebot"], ["theastraway", ""], ["", "castaldi-x"], ["theastraway", "castaldi-x\n"], ["theastraway", undefined], [undefined, "castaldi-x"], ["theastraway", 7]] as const) {
    assert.equal(repoAllowed(grant, o, r), false, JSON.stringify([o, r]));
  }
  assert.equal(repoAllowed(undefined, "theastraway", "castaldi-site"), false);
});

test("isGithubHost: only GitHub's own hosts", () => {
  for (const h of ["api.githubcopilot.com", "github.com", "mcp.github.com", "API.GITHUBCOPILOT.COM"]) assert.equal(isGithubHost(h), true, h);
  for (const h of ["evil.com", "github.com.evil.com", "notgithub.com", "githubcopilot.com.evil.io", "", undefined]) assert.equal(isGithubHost(h as string), false, String(h));
});

test("staff + coder grant: GitHub write tools run on matching repos only", () => {
  for (const t of ["create_branch", "push_files", "create_or_update_file", "create_pull_request", "merge_pull_request", "add_issue_comment", "update_pull_request"]) {
    assert.equal(tierAllows("staff", gh(t), { owner: "theastraway", repo: "castaldi-site" }, grant), true, `${t} allowed`);
    assert.equal(tierAllows("staff", gh(t), { owner: "theastraway", repo: "ysf-portal", branch: "x" }, grant), true, `${t} allowed ysf`);
    assert.equal(tierAllows("staff", gh(t), { owner: "theastraway", repo: "daebot" }, grant), false, `${t} blocked outside globs`);
    assert.equal(tierAllows("staff", gh(t), { owner: "theastraway", repo: "MINDapp" }, grant), false, `${t} blocked MINDapp`);
    assert.equal(tierAllows("staff", gh(t), { owner: "other", repo: "castaldi-site" }, grant), false, `${t} blocked other owner`);
    assert.equal(tierAllows("staff", gh(t), { repo: "castaldi-site" }, grant), false, `${t} blocked without owner`);
    assert.equal(tierAllows("staff", gh(t), {}, grant), false, `${t} blocked without owner and repo`);
    assert.equal(tierAllows("staff", gh(t), { owner: "theastraway", repo: ["castaldi-site"] }, grant), false, `${t} blocked on a non-string repo`);
  }
  // listing (no args): offered to the coder so the model can use it
  assert.equal(tierAllows("staff", gh("create_pull_request"), undefined, grant), true);
});

test("everything else outward stays blocked for a coder", () => {
  const args = { owner: "theastraway", repo: "castaldi-site" };
  assert.equal(tierAllows("staff", gh("create_repository"), args, grant), false, "creating repositories is not coding");
  assert.equal(tierAllows("staff", gh("fork_repository"), args, grant), false);
  assert.equal(tierAllows("staff", gh("delete_repository"), args, grant), false);
  assert.equal(tierAllows("staff", gh("create_pull_request", { mcp: { server: "github", host: "evil.example.com", tool: "create_pull_request" } }), args, grant), false, "same tool name on a non-GitHub host");
  assert.equal(tierAllows("staff", gh("create_pull_request", { mcp: undefined }), args, grant), false, "a tool with no connector facts");
  assert.equal(tierAllows("staff", { ...gh("create_pull_request"), spec: { name: "send_email", description: "", parameters: { type: "object" } }, mcp: undefined }, args, grant), false);
  const other: Tool = { spec: { name: "bash", description: "", parameters: { type: "object" } }, class: "irreversible", async run() { return { ok: true, output: "" }; } };
  assert.equal(tierAllows("staff", other, args, grant), false);
  // a read-only GitHub tool is class read: staff already runs it with or without the grant
  assert.equal(tierAllows("staff", gh("get_file_contents", { class: "read" }), { owner: "theastraway", repo: "daebot" }, grant), true);
});

test("no grant, or another tier = today's behaviour", () => {
  const args = { owner: "theastraway", repo: "castaldi-site" };
  assert.equal(tierAllows("staff", gh("create_pull_request"), args), false, "staff without a grant");
  assert.equal(tierAllows("staff", gh("create_pull_request"), args, undefined), false);
  assert.equal(tierAllows("public", gh("create_pull_request"), args, grant), false, "a grant never lifts the public tier");
  assert.equal(tierAllows("admin", gh("create_pull_request"), args), true);
  assert.equal(coderAllows(undefined, gh("create_pull_request"), args), false);
  assert.equal(parseCoders(undefined).coders.size, 0);
});

test("tier gate verdicts: the call is refused outside the globs and passed inside", () => {
  const g = createTierGate("staff", grant);
  const call = (args: Record<string, unknown>) => ({ id: "c", name: "github__merge_pull_request", args });
  assert.equal(g.preTool!(state(), call({ owner: "theastraway", repo: "castaldi-site", pullNumber: 3 }), gh("merge_pull_request")), undefined);
  const v = g.preTool!(state(), call({ owner: "theastraway", repo: "daebot", pullNumber: 3 }), gh("merge_pull_request"));
  assert.equal(v?.action, "block");
  assert.equal(createTierGate("staff").preTool!(state(), call({ owner: "theastraway", repo: "castaldi-site" }), gh("merge_pull_request"))?.action, "block");
});

test("kernel: a coder's allowed call still meets the confirmation gate; an outside call is blocked outright", () => {
  const k = createKernel({ shadow: false, enabled: true, tier: "staff", coder: grant, hosted: true });
  const c = (args: Record<string, unknown>) => ({ id: "c", name: "github__create_pull_request", args });
  const inside = k.preTool(state(), c({ owner: "theastraway", repo: "castaldi-site", title: "t", head: "a", base: "main" }), gh("create_pull_request"));
  assert.ok(inside.every((v) => v.gate !== "tier"), "tier gate passes");
  assert.ok(inside.some((v) => v.gate === "danger" && v.action === "needs-confirmation"), "the user's go is still asked for");
  const outside = k.preTool(state(), c({ owner: "theastraway", repo: "daebot", title: "t", head: "a", base: "main" }), gh("create_pull_request"));
  assert.ok(outside.some((v) => v.gate === "tier" && v.action === "block"));
  // the offered list keeps the GitHub write tool for the coder and drops it for a plain staff user
  const plain = createKernel({ shadow: false, enabled: true, tier: "staff", hosted: true });
  const t = gh("create_pull_request");
  assert.equal(k.allowedTools(state(), [t]).length, 1);
  assert.equal(plain.allowedTools(state(), [t]).length, 0);
});

test("system prompt names the grant for a coder and not for plain staff", () => {
  const base = { tier: "staff" as const, bootContext: "", surface: "web", cwd: "/" };
  const withGrant = composeSystemPrompt({ ...base, coder: grant });
  assert.match(withGrant, /Coder grant/);
  assert.match(withGrant, /theastraway\/castaldi-\*/);
  assert.doesNotMatch(composeSystemPrompt(base), /Coder grant/);
});
