import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashWriteTargets, createIsolationGate } from "../../src/kernel/isolation.ts";
import { call, state, tool } from "./helpers.ts";

let root: string, gh: string, wt: string, repo: string, worktree: string, plain: string;
let gate: ReturnType<typeof createIsolationGate>;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "iso-")));
  gh = join(root, "GitHub"); wt = join(root, ".worktrees");
  repo = join(gh, "proj"); worktree = join(wt, "proj-x"); plain = join(root, "plain");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere\n");
  mkdirSync(plain, { recursive: true });
  gate = createIsolationGate({ githubRoot: gh, worktreesRoot: wt, cwd: repo });
});
after(() => rmSync(root, { recursive: true, force: true }));

const run = (name: string, args: Record<string, unknown>) => gate.preTool!(state(), call(name, args), tool(name, "write"));

test("isolation: write_file into a real clone under GitHub blocks", () => {
  const v = run("write_file", { path: join(repo, "src", "a.ts"), content: "x" });
  assert.equal(v?.action, "block");
  assert.equal(v?.reason, "cut a worktree first: mwt <topic>");
});
test("isolation: write_file to a not-yet-existing deep path in clone blocks", () => {
  assert.equal(run("write_file", { path: join(repo, "new", "deep", "a.ts") })?.action, "block");
});
test("isolation: relative path resolved against cwd", () => {
  assert.equal(run("edit_file", { path: "src/a.ts" })?.action, "block");
});
test("isolation: write inside a worktree (.git file) allowed", () => {
  assert.equal(run("write_file", { path: join(worktree, "a.ts") }), undefined);
});
test("isolation: write outside any repo allowed", () => {
  assert.equal(run("write_file", { path: join(plain, "a.txt") }), undefined);
});
test("isolation: repo outside GitHub root allowed", () => {
  const other = join(root, "other"); mkdirSync(join(other, ".git"), { recursive: true });
  assert.equal(run("write_file", { path: join(other, "a") }), undefined);
});
test("isolation: bash redirect into clone blocks", () => {
  assert.equal(run("bash", { command: `echo hi > ${join(repo, "x.txt")}` })?.action, "block");
});
test("isolation: bash rm / git commit in clone cwd blocks", () => {
  assert.equal(run("bash", { command: "rm -rf src" })?.action, "block");
  assert.equal(run("bash", { command: "git commit -m x" })?.action, "block");
});
test("isolation: read-only bash allowed", () => {
  assert.equal(run("bash", { command: "ls -la && cat src/a.ts | grep x" }), undefined);
  assert.equal(run("bash", { command: "git status" }), undefined);
});
test("isolation: bash cd into worktree then write allowed", () => {
  assert.equal(run("bash", { command: `cd ${worktree} && touch a.txt` }), undefined);
});
test("isolation: disabled by option", () => {
  const g = createIsolationGate({ enabled: false, githubRoot: gh, worktreesRoot: wt, cwd: repo });
  assert.equal(g.preTool!(state(), call("write_file", { path: join(repo, "a") }), tool("write_file", "write")), undefined);
});
test("isolation: non-write tools ignored; missing paths tolerated", () => {
  assert.equal(run("read_file", { path: join(repo, "a") }), undefined);
  assert.equal(run("write_file", { path: "/definitely/not/here/a.txt" }), undefined);
  assert.equal(run("write_file", {}), undefined);
});
test("isolation: bashWriteTargets finds redirect and rm targets", () => {
  const t = bashWriteTargets("echo a > out.txt && rm -f old.log", "/w");
  assert.ok(t.includes("/w/out.txt") && t.includes("/w/old.log"), JSON.stringify(t));
});
