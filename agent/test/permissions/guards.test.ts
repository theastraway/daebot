import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGuards } from "../../src/permissions/guards.ts";
import { PermissionService, factsOf } from "../../src/permissions/index.ts";

const TEXT = [
  "# my guards",
  "- never bash: rm -rf",
  "- never write_file: ~/.ssh/**",
  "- never web_fetch: *.facebook.com",
  "- never send_email: @competitor.com",
  "- never bot_manage",
  "- always bash: npm test",
  "- always read_file: ~/notes/**",
  "- always send_email",
  "this is not a rule",
].join("\n");

test("parseGuards: the grammar, the matchers, and what is refused", () => {
  const p = parseGuards(TEXT, 1);
  assert.deepEqual(p.rules.map((r) => [r.effect, r.tool, r.matcher.kind, r.matcher.value]), [
    ["deny", "bash", "prefix", "rm -rf"],
    ["deny", "write_file", "glob", "**/.ssh/**"],
    ["deny", "web_fetch", "domain", "facebook.com"],
    ["deny", "send_email", "domain", "competitor.com"],
    ["deny", "bot_manage", "any", undefined],
    ["allow", "bash", "prefix", "npm test"],
    ["allow", "read_file", "glob", "**/notes/**"],
  ]);
  assert.equal(p.problems.length, 2);
  assert.match(p.problems[0], /too broad/);
  assert.match(p.problems[1], /line 10/);
  assert.ok(p.rules.every((r) => r.id.startsWith("guard:")));
});

test("PermissionService: guard rules evaluate first and show in the prompt; an edit applies on the next call", () => {
  const dir = mkdtempSync(join(tmpdir(), "guards-"));
  let text = "- never bash: rm -rf\n- always bash: npm test";
  const svc = new PermissionService({ dir, owner: "o", guards: () => text });
  assert.equal(svc.evaluate(factsOf("bash", "write", { command: "rm -rf /tmp/x" }, "/")).effect, "deny");
  assert.equal(svc.evaluate(factsOf("bash", "write", { command: "npm test" }, "/")).effect, "allow");
  assert.equal(svc.evaluate(factsOf("bash", "write", { command: "ls" }, "/")).effect, "none");
  assert.match(svc.preferencesText(), /guard rules[\s\S]*never bash: rm -rf/);
  text = "";
  assert.equal(svc.evaluate(factsOf("bash", "write", { command: "rm -rf /tmp/x" }, "/")).effect, "none");
});
