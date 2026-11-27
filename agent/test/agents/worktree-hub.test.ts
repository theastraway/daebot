import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeOps } from "../../src/agents/worktree.ts";
import { HelperHub } from "../../src/agents/hub.ts";
import { createDelegateTool, HELPER_KINDS, BUILD_TOOLS } from "../../src/agents/delegate.ts";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), "wt-repo-"));
  git(["init", "-q", "-b", "main"], r);
  mkdirSync(join(r, "src"));
  writeFileSync(join(r, "src", "a.ts"), "export const a = 1;\n");
  git(["add", "-A"], r);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], r);
  return r;
}

test("worktree: a helper's checkout is separate; its edits land on its own branch; the user's checkout is untouched", { skip: !hasGit && "git missing" }, () => {
  const r = repo();
  const home = mkdtempSync(join(tmpdir(), "wt-home-"));
  const ops = createWorktreeOps({ home });
  const wt = ops.prepare(join(r, "src"), "Fix A");
  assert.ok(!("error" in wt), JSON.stringify(wt));
  if ("error" in wt) return;
  assert.ok(wt.path.startsWith(home));
  assert.equal(wt.cwd, join(wt.path, "src"), "same sub-folder as the caller");
  assert.match(wt.branch, /^daebot\/helper-fix-a-/);
  writeFileSync(join(wt.cwd, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(wt.cwd, "b.ts"), "export const b = 1;\n");
  assert.equal(readFileSync(join(r, "src", "a.ts"), "utf8"), "export const a = 1;\n", "the user's checkout is untouched");
  const fin = ops.finish(wt, "Daebot helper: Fix A");
  assert.equal(fin.changed, true);
  assert.equal(fin.branch, wt.branch);
  assert.deepEqual(fin.files.sort(), ["src/a.ts", "src/b.ts"]);
  assert.match(fin.stat, /2 files changed/);
  assert.equal(existsSync(wt.path), false, "the folder goes; the branch keeps the work");
  assert.equal(git(["show", `${wt.branch}:src/a.ts`], r), "export const a = 2;");
  assert.equal(git(["status", "--porcelain"], r), "", "nothing changed in the user's checkout");
});

test("worktree: no change leaves no branch; outside git is a clear error", { skip: !hasGit && "git missing" }, () => {
  const r = repo();
  const ops = createWorktreeOps({ home: mkdtempSync(join(tmpdir(), "wt-home-")) });
  const wt = ops.prepare(r, "noop");
  if ("error" in wt) throw new Error(wt.error);
  const fin = ops.finish(wt, "noop");
  assert.equal(fin.changed, false);
  assert.equal(git(["branch", "--list", wt.branch], r), "");
  const out = ops.prepare(mkdtempSync(join(tmpdir(), "not-git-")), "x");
  assert.ok("error" in out);
  assert.match((out as { error: string }).error, /not inside a git repository/);
});

test("hub: start, tool, finish; loops with scores; newest running first; one-line strings", () => {
  let t = 1000;
  const hub = new HelperHub({ now: () => t });
  let changes = 0;
  hub.onChange = () => { changes++; };
  const a = hub.start({ session: "s1", title: "Explore\nauth", kind: "explore" });
  t += 10;
  const b = hub.start({ session: "s1", title: "Build B", kind: "build" });
  hub.tool(a, "grep"); hub.tool(a, "read_file");
  hub.finish(b, { ok: true, branch: "daebot/helper-b", files: 3 });
  const l = hub.startLoop({ session: "s1", goal: "ship it", bar: 9, maxCycles: 3 });
  hub.updateLoop(l, { cycle: 1, phase: "grade", score: 6.25, weakest: "tests" });
  const v = hub.list();
  assert.equal(v.helpers[0].id, a, "running first");
  assert.equal(v.helpers[0].title, "Explore auth");
  assert.equal(v.helpers[0].tool, "read_file");
  assert.equal(v.helpers[0].calls, 2);
  assert.equal(v.helpers[1].branch, "daebot/helper-b");
  assert.equal(v.helpers[1].files, 3);
  assert.deepEqual(v.loops[0].scores, [6.3]);
  assert.equal(v.running, 2);
  assert.ok(changes >= 6);
  hub.updateLoop(l, { phase: "cleared" });
  assert.equal(hub.list().running, 1);
  t += 2 * 60 * 60_000;
  assert.equal(hub.list().loops.length, 0, "finished entries fall off after an hour");
  assert.equal(hub.list().helpers.length, 1, "still-running helpers stay");
});

test("delegate build helpers: one worktree each, branches reported, the hub sees them; refused without worktrees", async () => {
  assert.ok(HELPER_KINDS.includes("build"));
  for (const t of ["write_file", "edit_file", "bash", "read_file"]) assert.ok(BUILD_TOOLS.has(t));
  const prepared: string[] = [];
  const ops = {
    prepare: (_cwd: string, label: string) => { prepared.push(label); const id = prepared.length; return { repo: "/r", path: `/wt/${id}`, cwd: `/wt/${id}`, branch: `daebot/helper-${id}`, base: "b" }; },
    finish: (wt: any) => ({ changed: wt.branch !== "daebot/helper-2", ...(wt.branch !== "daebot/helper-2" ? { branch: wt.branch } : {}), files: wt.branch !== "daebot/helper-2" ? ["x.ts"] : [], stat: "1 file changed" }),
  };
  const hub = new HelperHub();
  const cwds: string[] = [];
  const tool = createDelegateTool({ worktrees: ops, hub, spawn: async (t, o) => { cwds.push(o.cwd); o.onTool?.("edit_file"); return { ok: true, text: `did ${t.title}`, calls: [{ tool: "edit_file", receiptId: "c1", ok: true }], costUsd: 0 }; } });
  assert.equal(tool.classFor!({ tasks: [{ kind: "build" }] }), "write");
  assert.equal(tool.classFor!({ tasks: [{ kind: "explore" }] }), "read");
  const r = await tool.run({ tasks: [{ title: "A", prompt: "change module A to add retries", kind: "build" }, { title: "B", prompt: "change module B (nothing to do)", kind: "build" }, { title: "C", prompt: "look at module C and summarise", kind: "explore" }] }, { cwd: "/repo", sessionId: "s1" });
  assert.equal(r.ok, true, r.output);
  assert.deepEqual(prepared, ["A", "B"], "explore helpers get no worktree");
  assert.deepEqual(cwds.sort(), ["/repo", "/wt/1", "/wt/2"]);
  assert.match(r.output, /3 of 3 helper\(s\) finished, 1 branch\(es\) with changes/);
  assert.match(r.output, /Branch: daebot\/helper-1 \(1 file changed\): x\.ts/);
  assert.match(r.output, /Branch: none \(no file changed\)/);
  assert.match(r.output, /git merge --no-ff <branch>/);
  const live = hub.list();
  assert.equal(live.helpers.length, 3);
  assert.ok(live.helpers.every((h) => h.status === "done" && h.calls === 1));
  assert.equal(live.helpers.find((h) => h.title === "A")!.branch, "daebot/helper-1");
  const noBuild = createDelegateTool({ spawn: async () => ({ ok: true, text: "x", calls: [], costUsd: 0 }) });
  const refused = await noBuild.run({ tasks: [{ title: "A", prompt: "change module A to add retries", kind: "build" }] }, { cwd: "/repo", sessionId: "s1" });
  assert.equal(refused.ok, false);
  assert.match(refused.output, /build helpers are not available/);
  assert.ok(!JSON.stringify(noBuild.spec.parameters).includes('"build"'), "the build kind is not even offered");
});
