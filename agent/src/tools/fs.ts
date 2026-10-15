import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { Tool } from "../types.ts";
import { cap, errMsg, fail, globToRegExp, ok, resolvePath } from "./util.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", ".next", ".cache", "__pycache__"]);
const MAX_READ_CHARS = 100_000;

async function* walk(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  const stack = [root];
  while (stack.length) {
    if (signal?.aborted) return;
    const dir = stack.pop()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(full); }
      else if (e.isFile()) yield full;
    }
  }
}

const rel = (root: string, p: string) => relative(root, p).split(sep).join("/");

export const readFileTool: Tool = {
  class: "read",
  receipt: "surface",
  spec: {
    name: "read_file",
    description: "Read a text file. Returns numbered lines. Use offset/limit (1-based line numbers) for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute or relative to the working directory)" },
        offset: { type: "number", description: "First line to return (1-based, default 1)" },
        limit: { type: "number", description: "Max lines to return (default 2000)" },
      },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    const p = resolvePath(ctx.cwd, args.path);
    if (!p) return fail("read_file: path is required");
    try {
      const buf = await readFile(p);
      if (buf.subarray(0, 4096).includes(0)) return fail(`read_file: ${args.path} looks binary`);
      const lines = buf.toString("utf8").split("\n");
      const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
      const limit = Math.max(1, Math.floor(Number(args.limit) || 2000));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const body = slice.map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join("\n");
      const more = offset - 1 + limit < lines.length ? `\n[${lines.length - (offset - 1 + limit)} more lines; use offset=${offset + limit}]` : "";
      return ok(cap(body, MAX_READ_CHARS) + more, { lines: lines.length });
    } catch (e) {
      return fail(`read_file: ${errMsg(e)}`);
    }
  },
};

export const writeFileTool: Tool = {
  class: "write",
  spec: {
    name: "write_file",
    description: "Create or overwrite a file with the given content. Parent directories are created.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  async run(args, ctx) {
    const p = resolvePath(ctx.cwd, args.path);
    if (!p) return fail("write_file: path is required");
    if (typeof args.content !== "string") return fail("write_file: content must be a string");
    try {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, args.content, "utf8");
      return ok(`wrote ${args.content.length} chars to ${p}`);
    } catch (e) {
      return fail(`write_file: ${errMsg(e)}`);
    }
  },
};

export const editFileTool: Tool = {
  class: "write",
  spec: {
    name: "edit_file",
    description: "Replace an exact string in a file. old_string must appear exactly once unless replace_all is true.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  async run(args, ctx) {
    const p = resolvePath(ctx.cwd, args.path);
    if (!p) return fail("edit_file: path is required");
    const oldS = args.old_string;
    const newS = args.new_string;
    if (typeof oldS !== "string" || typeof newS !== "string") return fail("edit_file: old_string and new_string must be strings");
    if (oldS === "") return fail("edit_file: old_string must not be empty");
    if (oldS === newS) return fail("edit_file: old_string and new_string are identical");
    try {
      const text = await readFile(p, "utf8");
      const count = text.split(oldS).length - 1;
      if (count === 0) return fail("edit_file: old_string not found");
      if (count > 1 && args.replace_all !== true) return fail(`edit_file: old_string matches ${count} places; add context to make it unique or set replace_all`);
      const next = args.replace_all === true ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
      await writeFile(p, next, "utf8");
      return ok(`edited ${p} (${args.replace_all === true ? count : 1} replacement${count > 1 && args.replace_all === true ? "s" : ""})`);
    } catch (e) {
      return fail(`edit_file: ${errMsg(e)}`);
    }
  },
};

export const globTool: Tool = {
  class: "read",
  receipt: "surface",
  spec: {
    name: "glob",
    description: "Find files by glob pattern (supports **, *, ?, {a,b}). Skips node_modules and .git. Returns paths relative to the search root.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "e.g. src/**/*.ts" },
        path: { type: "string", description: "Directory to search (default: working directory)" },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    if (typeof args.pattern !== "string" || !args.pattern) return fail("glob: pattern is required");
    const root = resolvePath(ctx.cwd, args.path ?? ".")!;
    try {
      const st = await stat(root);
      if (!st.isDirectory()) return fail(`glob: not a directory: ${root}`);
      // A pattern without a slash matches basenames anywhere, like most globbers.
      const pat = args.pattern.includes("/") ? args.pattern : `**/${args.pattern}`;
      const re = globToRegExp(pat);
      const hits: string[] = [];
      for await (const f of walk(root, ctx.signal)) {
        const r = rel(root, f);
        if (re.test(r)) { hits.push(r); if (hits.length >= 1000) break; }
      }
      return ok(hits.length ? hits.join("\n") : "(no matches)", { count: hits.length });
    } catch (e) {
      return fail(`glob: ${errMsg(e)}`);
    }
  },
};

let rgAvailable: boolean | undefined;
export function hasRipgrep(): boolean {
  if (rgAvailable === undefined) {
    try { rgAvailable = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0; } catch { rgAvailable = false; }
  }
  return rgAvailable;
}

export interface GrepOpts { pattern: string; root: string; glob?: string; ignoreCase?: boolean; maxResults: number; signal?: AbortSignal }

export async function grepJs(o: GrepOpts): Promise<string[]> {
  let re: RegExp;
  re = new RegExp(o.pattern, o.ignoreCase ? "i" : "");
  const fileRe = o.glob ? globToRegExp(o.glob.includes("/") ? o.glob : `**/${o.glob}`) : undefined;
  const out: string[] = [];
  const st = await stat(o.root);
  const files = st.isFile() ? (async function* () { yield o.root; })() : walk(o.root, o.signal);
  const base = st.isFile() ? dirname(o.root) : o.root;
  for await (const f of files) {
    const r = rel(base, f);
    if (fileRe && !fileRe.test(r)) continue;
    let text: string;
    try {
      const buf = await readFile(f);
      if (buf.subarray(0, 4096).includes(0)) continue;
      text = buf.toString("utf8");
    } catch { continue; }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push(`${r}:${i + 1}:${lines[i].slice(0, 400)}`);
        if (out.length >= o.maxResults) return out;
      }
    }
  }
  return out;
}

function grepRg(o: GrepOpts): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const a = ["--line-number", "--no-heading", "--color", "never", "--max-columns", "400", "--max-count", String(o.maxResults)];
    for (const d of SKIP_DIRS) a.push("-g", `!${d}/`);
    if (o.ignoreCase) a.push("-i");
    if (o.glob) a.push("-g", o.glob);
    a.push("-e", o.pattern, "--", ".");
    const child = spawn("rg", a, { cwd: o.root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const onAbort = () => child.kill("SIGKILL");
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      o.signal?.removeEventListener("abort", onAbort);
      if (code === 0 || code === 1) resolve(out.split("\n").filter(Boolean).map((l) => l.replace(/^\.\//, "")).slice(0, o.maxResults));
      else reject(new Error(err.split("\n")[0] || `rg exited ${code}`));
    });
  });
}

export const grepTool: Tool = {
  class: "read",
  receipt: "surface",
  spec: {
    name: "grep",
    description: "Search file contents with a regular expression. Returns path:line:text. Uses ripgrep when installed.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression" },
        path: { type: "string", description: "File or directory (default: working directory)" },
        glob: { type: "string", description: "Only search files matching this glob, e.g. *.ts" },
        ignore_case: { type: "boolean" },
        max_results: { type: "number", description: "Default 200" },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    if (typeof args.pattern !== "string" || !args.pattern) return fail("grep: pattern is required");
    const root = resolvePath(ctx.cwd, args.path ?? ".")!;
    const o: GrepOpts = {
      pattern: args.pattern,
      root,
      glob: typeof args.glob === "string" ? args.glob : undefined,
      ignoreCase: args.ignore_case === true,
      maxResults: Math.min(1000, Math.max(1, Math.floor(Number(args.max_results) || 200))),
      signal: ctx.signal,
    };
    try {
      new RegExp(o.pattern);
    } catch (e) {
      return fail(`grep: invalid regex: ${errMsg(e)}`);
    }
    try {
      const st = await stat(root);
      let lines: string[];
      if (hasRipgrep() && st.isDirectory()) {
        try { lines = await grepRg(o); } catch { lines = await grepJs(o); }
      } else {
        lines = await grepJs(o);
      }
      return ok(lines.length ? cap(lines.join("\n"), 30_000) : "(no matches)", { count: lines.length });
    } catch (e) {
      return fail(`grep: ${errMsg(e)}`);
    }
  },
};
