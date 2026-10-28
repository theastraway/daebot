import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Gate } from "../types.ts";

export interface IsolationOptions {
  enabled?: boolean;
  cwd?: string;
  githubRoot?: string;     // default ~/Documents/GitHub
  worktreesRoot?: string;  // default ~/.worktrees
}

const FILE_TOOLS = new Set(["write_file", "edit_file"]);
const REASON = "cut a worktree first: mwt <topic>";

// realpath of the deepest existing ancestor + the remainder (tolerates missing paths).
function realish(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    rest.unshift(cur.slice(up.length + (up.endsWith(sep) ? 0 : 1)));
    cur = up;
  }
  try { cur = realpathSync(cur); } catch { /* keep */ }
  return rest.length ? join(cur, ...rest) : cur;
}

function within(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

// Returns the git root and whether .git is a directory (real clone) or a file (worktree).
function findGit(start: string): { root: string; isDir: boolean } | undefined {
  let cur = start;
  for (let i = 0; i < 64; i++) {
    const g = join(cur, ".git");
    try {
      const st = lstatSync(g);
      return { root: cur, isDir: st.isDirectory() };
    } catch { /* not here */ }
    const up = dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
  return undefined;
}

const WRITE_VERBS = /(^|[\s;&|(])(rm|mv|cp|touch|mkdir|rmdir|tee|truncate|ln|install|chmod|chown|patch)\s/;
const GIT_WRITE = /\bgit\s+(commit|add|push|checkout|switch|reset|merge|rebase|stash|apply|am|cherry-pick|clean|restore|rm|mv|pull|revert|tag)\b/;
const SED_INPLACE = /\bsed\s+(-[A-Za-z]*i|--in-place)/;

function stripQuotes(t: string): string {
  return t.replace(/^['"]|['"]$/g, "");
}

const INTERP = /(?:^|[\s;&|(`])(?:python[0-9.]*|node|perl|ruby)\b/;
const INTERP_INLINE = /(?:^|[\s;&|(`])(?:python[0-9.]*|node|perl|ruby)\s+(?:-[A-Za-z]*[ceE][A-Za-z]*\b|-\s*(?:<<|$)|[^\n]*<<)/;
const INTERP_PIPED = /\|\s*(?:python[0-9.]*|node|perl|ruby)\b/;
const ABS_PATH = /(?<![\w.:~$-])\/[^\s'"`;,)(\][<>|&*?{}]+/g;

// An interpreter one-liner or heredoc can write anywhere: every absolute path it mentions is a candidate write target.
export function interpreterPaths(command: string): string[] {
  if (!INTERP.test(command)) return [];
  if (!INTERP_INLINE.test(command) && !INTERP_PIPED.test(command)) return [];
  const out: string[] = [];
  for (const m of command.matchAll(ABS_PATH)) out.push(m[0].replace(/[.:]+$/, ""));
  return out;
}

// Light scan, not a shell parser: returns candidate write target paths (absolute), or [] if it looks read-only.
export function bashWriteTargets(command: string, cwd: string): string[] {
  const out: string[] = interpreterPaths(command);
  let base = cwd;
  const cd = /(?:^|[;&|]\s*|&&\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(command);
  if (cd) {
    const d = stripQuotes(cd[1]).replace(/^~(?=$|\/)/, homedir());
    base = isAbsolute(d) ? d : resolve(cwd, d);
  }
  const abs = (t: string) => {
    const x = stripQuotes(t).replace(/^~(?=$|\/)/, homedir());
    return isAbsolute(x) ? x : resolve(base, x);
  };
  for (const m of command.matchAll(/(?:^|[^<>&0-9])>>?\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)) {
    if (!m[1].startsWith("/dev/")) out.push(abs(m[1]));
  }
  let writey = false;
  if (WRITE_VERBS.test(command) || SED_INPLACE.test(command)) {
    writey = true;
    for (const seg of command.split(/&&|\|\||;|\|/)) {
      const toks = seg.trim().split(/\s+/);
      const verbIdx = toks.findIndex((t) => /^(rm|mv|cp|touch|mkdir|rmdir|tee|truncate|ln|install|chmod|chown|patch|sed)$/.test(t));
      if (verbIdx < 0) continue;
      for (const t of toks.slice(verbIdx + 1)) {
        if (t.startsWith("-") || t === "" || /^['"]?[sy]\//.test(t)) continue;
        if (/[/.~]/.test(t) || existsSync(abs(t))) out.push(abs(t));
      }
    }
  }
  if (GIT_WRITE.test(command)) { writey = true; out.push(base); }
  if (writey && out.length === 0) out.push(base);
  return out;
}

export function createIsolationGate(opts: IsolationOptions = {}): Gate {
  const enabled = opts.enabled !== false;
  const home = homedir();
  const githubRoot = realish(opts.githubRoot ?? join(home, "Documents", "GitHub"));
  const worktreesRoot = realish(opts.worktreesRoot ?? join(home, ".worktrees"));
  const defaultCwd = () => opts.cwd ?? process.cwd();

  function violates(target: string): boolean {
    const p = realish(target);
    if (within(p, worktreesRoot)) return false;
    const start = existsSync(p) && lstatSync(p).isDirectory() ? p : dirname(p);
    const git = findGit(start);
    if (!git || !git.isDir) return false;           // not in a repo, or a worktree (.git file)
    return within(realish(git.root), githubRoot);
  }

  return {
    name: "isolation",
    preTool(_s, call) {
      if (!enabled) return undefined;
      const cwdArg = typeof call.args.cwd === "string" ? call.args.cwd : undefined;
      const cwd = cwdArg ? resolve(defaultCwd(), cwdArg) : defaultCwd();
      let targets: string[] = [];
      if (FILE_TOOLS.has(call.name)) {
        const p = call.args.path ?? call.args.file_path ?? call.args.file;
        if (typeof p === "string") targets = [isAbsolute(p) ? p : resolve(cwd, p)];
      } else if (call.name === "bash" || (call.name === "process" && call.args.action === "start")) {
        const cmd = call.args.command ?? call.args.cmd;
        if (typeof cmd === "string") targets = bashWriteTargets(cmd, cwd);
      } else {
        return undefined;
      }
      for (const t of targets) {
        if (violates(t)) return { gate: "isolation", action: "block", reason: REASON };
      }
      return undefined;
    },
  };
}

export const isolationGate: Gate = createIsolationGate();
