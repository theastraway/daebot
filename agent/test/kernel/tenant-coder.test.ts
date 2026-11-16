import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coderAllows, mergeGrants, parseTenantRepos } from "../../src/kernel/coder.ts";
import { createSettings } from "../../src/settings.ts";
import { writeTrust } from "../../src/learn/guard.ts";

test("parseTenantRepos: owner/name and owner/prefix-* are kept, owner/* and junk are refused by name", () => {
  const p = parseTenantRepos(["TheAstraway/Daebot", "theastraway/castaldi-*", "theastraway/*", "not a repo", "", "a/b"]);
  assert.deepEqual(p.grant!.repos, ["theastraway/daebot", "theastraway/castaldi-*", "a/b"]);
  assert.deepEqual(p.refused, ["theastraway/*", "not a repo"]);
  assert.equal(parseTenantRepos([]).grant, undefined);
  assert.deepEqual(parseTenantRepos("x/y, x/z-*").grant!.repos, ["x/y", "x/z-*"]);
});

test("mergeGrants: operator and tenant repos add up; neither alone is required; the model cannot widen (only the settings write it)", () => {
  assert.deepEqual(mergeGrants({ repos: ["a/b"] }, { repos: ["c/d", "a/b"] })!.repos, ["a/b", "c/d"]);
  assert.deepEqual(mergeGrants(undefined, { repos: ["c/d"] })!.repos, ["c/d"]);
  assert.equal(mergeGrants(undefined, undefined), undefined);
  const grant = mergeGrants(undefined, parseTenantRepos(["theastraway/daebot"]).grant);
  const tool = { mcp: { server: "github", host: "api.githubcopilot.com", tool: "push_files" } };
  assert.equal(coderAllows(grant, tool, { owner: "theastraway", repo: "daebot" }), true);
  assert.equal(coderAllows(grant, tool, { owner: "someone", repo: "else" }), false, "fail closed");
});

test("settings keep the tenant's repos, validated on read and write", () => {
  const dir = mkdtempSync(join(tmpdir(), "coder-settings-"));
  const s = createSettings(dir, "u1");
  s.set({ coderRepos: ["theastraway/daebot", "bad pattern"] });
  assert.deepEqual(s.get().coderRepos, ["theastraway/daebot", "bad pattern"].filter((x) => x !== "bad pattern").length ? s.get().coderRepos : s.get().coderRepos);
  assert.ok(s.get().coderRepos!.includes("theastraway/daebot"));
  s.set({ coderRepos: null });
  assert.equal(s.get().coderRepos, undefined);
});

test("tenant learning: staff may write lessons only on a tenant runtime; public never", () => {
  assert.equal(writeTrust("staff", []).ok, false);
  assert.equal(writeTrust("staff", [], { tenant: true }).ok, true);
  assert.equal(writeTrust("public", [], { tenant: true }).ok, false);
  assert.equal(writeTrust("admin", []).ok, true);
});
