// Git worktrees for build helpers: each helper that edits files gets its own checkout of the repo on its own branch, under
// ~/.worktrees/daebot-helpers/ (the isolation gate's home for worktrees), so helpers working at the same time never collide and
// the user's checkout is never touched. When the helper ends, its changes are committed on its branch and the worktree folder is
// removed; the branch is what the caller reviews and merges. A helper that changed nothing leaves no branch behind.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";

export interface Worktree {
  /** The user's repository root. */
  repo: string;
  /** The helper's own checkout. */
  path: string;
  /** Where the helper works inside it (same sub-folder as the caller's working folder). */
  cwd: string;
  branch: string;
  /** The commit the branch starts from. */
  base: string;
}

export interface WorktreeResult { changed: boolean; branch?: string; commit?: string; files: string[]; stat: string; error?: string }

export interface WorktreeOps {
  prepare(cwd: string, label: string): Worktree | { error: string };
  finish(wt: Worktree, message: string): WorktreeResult;
}

type Git = (args: string[], cwd: string) => string;
const realGit: Git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "helper";

export function createWorktreeOps(o: { git?: Git; home?: string; now?: () => number } = {}): WorktreeOps {
  const git = o.git ?? realGit;
  const home = o.home ?? join(homedir(), ".worktrees", "daebot-helpers");
  const now = o.now ?? Date.now;
  let seq = 0;
  return {
    prepare(cwd, label) {
      let repo: string;
      try { repo = git(["rev-parse", "--show-toplevel"], cwd); } catch { return { error: "build helpers need a git checkout: the working folder is not inside a git repository" }; }
      let base: string;
      try { base = git(["rev-parse", "HEAD"], repo); } catch { return { error: "the repository has no commit yet, so a build helper has nothing to branch from" }; }
      const id = `${slug(label)}-${now().toString(36)}${(seq++).toString(36)}`;
      const branch = `daebot/helper-${id}`;
      const path = join(home, `${slug(basename(repo))}-${id}`);
      try {
        mkdirSync(home, { recursive: true });
        git(["worktree", "add", "-b", branch, path, base], repo);
      } catch (e) { return { error: `could not make a worktree: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 160)}` }; }
      // Compare real paths: /tmp and /var are symlinks on macOS, and git answers with the real one.
      let real = cwd;
      try { real = realpathSync(cwd); } catch { /* keep it as given */ }
      const sub = relative(repo, real);
      const inner = sub && !sub.startsWith("..") ? join(path, sub) : path;
      return { repo, path, cwd: existsSync(inner) ? inner : path, branch, base };
    },
    finish(wt, message) {
      let files: string[] = [], stat = "", commit: string | undefined, error: string | undefined;
      try {
        git(["add", "-A"], wt.path);
        const staged = git(["diff", "--cached", "--name-only"], wt.path);
        if (staged) git(["-c", "user.name=Daebot helper", "-c", "user.email=helper@daebot.local", "commit", "-q", "-m", message.slice(0, 200)], wt.path);
        const range = `${wt.base}..${wt.branch}`;
        files = git(["diff", "--name-only", range], wt.repo).split("\n").filter(Boolean);
        stat = files.length ? git(["diff", "--stat", range], wt.repo).split("\n").slice(-1)[0].trim() : "";
        if (files.length) commit = git(["rev-parse", "--short", wt.branch], wt.repo);
      } catch (e) { error = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200); }
      // A failed commit keeps the folder (the work is still in it); otherwise the branch holds everything and the folder goes.
      if (error) return { changed: false, files, stat, error: `${error} (the helper's work is still in ${wt.path} on ${wt.branch})` };
      try { git(["worktree", "remove", "--force", wt.path], wt.repo); } catch { /* the folder stays; the branch is what matters */ }
      if (!files.length) { try { git(["branch", "-D", wt.branch], wt.repo); } catch { /* already gone */ } }
      return { changed: files.length > 0, ...(files.length ? { branch: wt.branch, commit } : {}), files, stat };
    },
  };
}
