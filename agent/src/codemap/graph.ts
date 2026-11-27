// The code map: a repository's import graph (files, the symbols they define, who imports whom), built from the files on disk.
// Pure scanning and queries; no model, no network. The code_map tool (codemap/tool.ts) adds MIND around it: recall of what MIND
// remembers about the files a change touches, and a sync that files the map's outline into the user's MIND as a document.
//
// Languages: TypeScript/JavaScript (import/export/require/dynamic import), Python (import/from), Go (import), Rust (mod/use crate::).
// Resolution is by path only (relative imports, Python packages, Go module paths, Rust crate modules); a bare package is "external".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";

export type Lang = "ts" | "js" | "py" | "go" | "rs";

export interface CodeFile {
  /** Path relative to the root, with forward slashes. */
  path: string;
  lang: Lang;
  lines: number;
  /** Top-level symbols this file defines (exported ones first for ts/js). */
  symbols: string[];
  /** Files in the repo this file imports (relative paths). */
  imports: string[];
  /** Packages outside the repo this file imports. */
  external: string[];
  test: boolean;
  mtimeMs: number;
}

export interface CodeMap {
  root: string;
  builtAt: number;
  files: Map<string, CodeFile>;
  /** path -> files that import it. */
  importedBy: Map<string, string[]>;
  /** True when the walk stopped at the file cap. */
  truncated: boolean;
  skipped: number;
}

const EXT: Record<string, Lang> = { ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js", ".py": "py", ".go": "go", ".rs": "rs" };
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target", "vendor", "coverage", ".next", ".nuxt", ".turbo", ".cache",
  "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache", ".pytest_cache", "Pods", "DerivedData", ".gradle", ".idea", ".vscode",
]);
export const MAX_FILES = 6000;
const MAX_BYTES = 512 * 1024;

const posix = (p: string): string => p.split(sep).join("/");

export function isTestPath(p: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /_test\.(go|py)$/.test(p);
}

/** Lists the source files under root (sorted, skipping build output, dependencies and hidden folders). */
export function listSources(root: string, cap = MAX_FILES): { files: string[]; truncated: boolean } {
  const out: string[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    if (truncated) return;
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (out.length >= cap) { truncated = true; return; }
      const full = join(dir, n);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(n) || (n.startsWith(".") && n !== ".github")) continue;
        walk(full);
      } else if (st.isFile() && EXT[extname(n)] && !n.endsWith(".d.ts") && !/\.min\.js$/.test(n) && !n.endsWith(".generated.ts")) {
        out.push(posix(relative(root, full)));
      }
    }
  };
  walk(root);
  return { files: out, truncated };
}

// ---------- parsing (regex, good enough for an outline; never executes anything) ----------

/** Strips comments and the contents of plain strings that could hide an import-looking line. Keeps line count. */
function stripComments(src: string, lang: Lang): string {
  if (lang === "py") return src.replace(/^\s*#.*$/gm, "");
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

export function parseSpecifiers(src: string, lang: Lang): string[] {
  const s = stripComments(src, lang);
  const out = new Set<string>();
  const add = (v: string | undefined) => { if (v && v.length < 300) out.add(v); };
  if (lang === "ts" || lang === "js") {
    for (const m of s.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"'\n]+)["']/g)) add(m[1]);
    for (const m of s.matchAll(/\b(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g)) add(m[1]);
  } else if (lang === "py") {
    // [ \t] not \s: an import list must not run on into the next line (a parenthesised list may).
    for (const m of s.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(?:\(([^)]*)\)|([\w*, \t]+))/gm)) {
      const mod = m[1];
      if (/^\.+$/.test(mod)) for (const name of (m[2] ?? m[3] ?? "").split(",")) { const n = name.trim().split(/\s+/)[0]; if (n && n !== "*") add(`${mod}${n}`); }
      else add(mod);
    }
    for (const m of s.matchAll(/^[ \t]*import[ \t]+([\w., \t]+)$/gm)) for (const part of m[1].split(",")) { const n = part.trim().split(/\s+/)[0]; if (n) add(n); }
  } else if (lang === "go") {
    for (const m of s.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) add(m[1]);
    for (const block of s.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) for (const m of block[1].matchAll(/(?:[\w.]+\s+)?"([^"]+)"/g)) add(m[1]);
  } else if (lang === "rs") {
    for (const m of s.matchAll(/^\s*(?:pub(?:\([\w:]+\))?\s+)?mod\s+(\w+)\s*;/gm)) add(`mod:${m[1]}`);
    for (const m of s.matchAll(/^\s*(?:pub\s+)?use\s+(crate|super|self)::([\w:]+)/gm)) add(`${m[1]}::${m[2]}`);
  }
  return [...out];
}

export function parseSymbols(src: string, lang: Lang): string[] {
  const s = stripComments(src, lang);
  const exported: string[] = [];
  const local: string[] = [];
  const push = (arr: string[], v: string | undefined) => { if (v && !exported.includes(v) && !local.includes(v)) arr.push(v); };
  if (lang === "ts" || lang === "js") {
    for (const m of s.matchAll(/^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) push(exported, m[1]);
    for (const m of s.matchAll(/^\s*export\s*\{([^}]+)\}/gm)) for (const part of m[1].split(",")) { const n = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, "").trim(); if (n && /^[A-Za-z_$][\w$]*$/.test(n)) push(exported, n); }
    for (const m of s.matchAll(/^(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) push(local, m[1]);
  } else if (lang === "py") {
    for (const m of s.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm)) push(m[1].startsWith("_") ? local : exported, m[1]);
  } else if (lang === "go") {
    for (const m of s.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm)) push(/^[A-Z]/.test(m[1]) ? exported : local, m[1]);
    for (const m of s.matchAll(/^type\s+([A-Za-z_]\w*)/gm)) push(/^[A-Z]/.test(m[1]) ? exported : local, m[1]);
  } else if (lang === "rs") {
    for (const m of s.matchAll(/^\s*pub(?:\([\w:]+\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const|static)\s+([A-Za-z_]\w*)/gm)) push(exported, m[1]);
    for (const m of s.matchAll(/^(?:async\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm)) push(local, m[1]);
  }
  return [...exported, ...local].slice(0, 80);
}

// ---------- resolution ----------

const TS_TRY = ["", ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"];

function goModule(root: string): string | undefined {
  try { return /^module\s+(\S+)/m.exec(readFileSync(join(root, "go.mod"), "utf8"))?.[1]; } catch { return undefined; }
}

/** Resolves one import specifier of `from` to a repo file, or returns it as an external package name. */
export function resolveSpecifier(spec: string, from: string, lang: Lang, known: ReadonlySet<string>, ctx: { goMod?: string } = {}): { file?: string; external?: string } {
  const dir = posix(dirname(from)) === "." ? "" : posix(dirname(from));
  const norm = (p: string): string => {
    const parts: string[] = [];
    for (const seg of p.split("/")) { if (!seg || seg === ".") continue; if (seg === "..") parts.pop(); else parts.push(seg); }
    return parts.join("/");
  };
  if (lang === "ts" || lang === "js") {
    if (!spec.startsWith(".") && !spec.startsWith("/")) {
      if (spec.startsWith("node:")) return { external: spec };
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      return { external: pkg };
    }
    const base = norm(spec.startsWith("/") ? spec.slice(1) : `${dir}/${spec}`);
    // "./x.js" written for a .ts source (TypeScript's ESM convention) resolves to x.ts.
    const stems = [base, base.replace(/\.(m|c)?js$/, "")];
    for (const stem of stems) for (const t of TS_TRY) if (known.has(stem + t)) return { file: stem + t };
    return {};
  }
  if (lang === "py") {
    const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
    const rest = spec.slice(dots).split(".").filter(Boolean).join("/");
    let baseDir = dir;
    for (let i = 1; i < dots; i++) baseDir = posix(dirname(baseDir)) === "." ? "" : posix(dirname(baseDir));
    const cands = dots ? [norm(`${baseDir}/${rest}`)] : [rest, ...(dir ? [norm(`${dir}/${rest}`)] : [])];
    // Absolute imports may be rooted at a src/ layout.
    if (!dots) cands.push(`src/${rest}`);
    for (const c of cands) for (const t of [".py", "/__init__.py"]) if (known.has(c + t)) return { file: c + t };
    return dots ? {} : { external: spec.split(".")[0] };
  }
  if (lang === "go") {
    if (ctx.goMod && (spec === ctx.goMod || spec.startsWith(ctx.goMod + "/"))) {
      const pkgDir = spec.slice(ctx.goMod.length).replace(/^\//, "");
      // A Go import names a package (a folder): the edge goes to the folder's first non-test file.
      const hit = [...known].filter((f) => posix(dirname(f)) === (pkgDir || ".") && f.endsWith(".go") && !f.endsWith("_test.go")).sort()[0];
      return hit ? { file: hit } : {};
    }
    return { external: spec };
  }
  if (lang === "rs") {
    if (spec.startsWith("mod:")) {
      const name = spec.slice(4);
      const own = /(^|\/)(main|lib|mod)\.rs$/.test(from) ? dir : norm(`${dir}/${basename(from, ".rs")}`);
      for (const c of [`${own}/${name}.rs`, `${own}/${name}/mod.rs`].map(norm)) if (known.has(c)) return { file: c };
      return {};
    }
    const [head, ...path] = spec.split("::");
    const srcRoot = from.includes("src/") ? from.slice(0, from.indexOf("src/") + 4) : "";
    const startDir = head === "crate" ? srcRoot.replace(/\/$/, "") : head === "super" ? posix(dirname(dir)) : dir;
    for (let n = path.length; n > 0; n--) {
      const p = norm(`${startDir}/${path.slice(0, n).join("/")}`);
      for (const c of [`${p}.rs`, `${p}/mod.rs`]) if (known.has(c)) return { file: c };
    }
    return {};
  }
  return {};
}

// ---------- building and caching ----------

const cache = new Map<string, CodeMap>();

/** Builds (or refreshes) the map of `root`. Unchanged files are reused from the last build of the same root (mtime and size). */
export function buildCodeMap(root: string, o: { cap?: number; now?: () => number; fresh?: boolean } = {}): CodeMap {
  const prev = o.fresh ? undefined : cache.get(root);
  const { files: paths, truncated } = listSources(root, o.cap ?? MAX_FILES);
  const known = new Set(paths);
  const goMod = paths.some((p) => p.endsWith(".go")) ? goModule(root) : undefined;
  const files = new Map<string, CodeFile>();
  let skipped = 0;
  for (const p of paths) {
    const lang = EXT[extname(p)];
    let st;
    try { st = statSync(join(root, p)); } catch { skipped++; continue; }
    if (st.size > MAX_BYTES) { skipped++; continue; }
    const old = prev?.files.get(p);
    if (old && old.mtimeMs === st.mtimeMs) {
      // Imports are re-resolved: a file added elsewhere can turn an unresolved import into an edge.
      files.set(p, old);
      continue;
    }
    let src: string;
    try { src = readFileSync(join(root, p), "utf8"); } catch { skipped++; continue; }
    const specs = parseSpecifiers(src, lang);
    const imports = new Set<string>();
    const external = new Set<string>();
    for (const sp of specs) {
      const r = resolveSpecifier(sp, p, lang, known, { goMod });
      if (r.file && r.file !== p) imports.add(r.file);
      else if (r.external) external.add(r.external);
    }
    files.set(p, { path: p, lang, lines: src.split("\n").length, symbols: parseSymbols(src, lang), imports: [...imports].sort(), external: [...external].sort(), test: isTestPath(p), mtimeMs: st.mtimeMs });
  }
  // A reused file may point at a file that is gone: drop dangling edges.
  for (const f of files.values()) if (f.imports.some((i) => !files.has(i))) files.set(f.path, { ...f, imports: f.imports.filter((i) => files.has(i)) });
  const importedBy = new Map<string, string[]>();
  for (const f of files.values()) for (const i of f.imports) { const arr = importedBy.get(i) ?? []; arr.push(f.path); importedBy.set(i, arr); }
  for (const arr of importedBy.values()) arr.sort();
  const map: CodeMap = { root, builtAt: (o.now ?? Date.now)(), files, importedBy, truncated, skipped };
  cache.set(root, map);
  if (cache.size > 8) cache.delete(cache.keys().next().value as string);
  return map;
}

export function clearCodeMapCache(): void { cache.clear(); }

// ---------- queries ----------

/** Finds a file by exact path, by path suffix, or by unique basename. Returns candidates when ambiguous. */
export function findFile(map: CodeMap, q: string): { file?: string; candidates: string[] } {
  const want = posix(String(q ?? "").trim()).replace(/^\.\//, "");
  if (!want) return { candidates: [] };
  if (map.files.has(want)) return { file: want, candidates: [] };
  const rel = map.root && want.startsWith(posix(map.root) + "/") ? want.slice(posix(map.root).length + 1) : undefined;
  if (rel && map.files.has(rel)) return { file: rel, candidates: [] };
  const all = [...map.files.keys()];
  const bySuffix = all.filter((f) => f.endsWith("/" + want));
  if (bySuffix.length === 1) return { file: bySuffix[0], candidates: [] };
  if (bySuffix.length > 1) return { candidates: bySuffix.slice(0, 10) };
  const stem = want.replace(/\.[a-z]+$/, "");
  const byName = all.filter((f) => basename(f) === want || basename(f).replace(/\.[a-z]+$/, "") === stem);
  if (byName.length === 1) return { file: byName[0], candidates: [] };
  return { candidates: byName.slice(0, 10) };
}

/** Files that define a symbol with this exact name (then case-insensitive). */
export function findSymbol(map: CodeMap, name: string): { file: string; symbol: string }[] {
  const n = String(name ?? "").trim();
  if (!n) return [];
  const exact: { file: string; symbol: string }[] = [];
  const loose: { file: string; symbol: string }[] = [];
  for (const f of map.files.values()) for (const s of f.symbols) {
    if (s === n) exact.push({ file: f.path, symbol: s });
    else if (s.toLowerCase() === n.toLowerCase()) loose.push({ file: f.path, symbol: s });
  }
  return (exact.length ? exact : loose).slice(0, 20);
}

export interface Impact {
  file: string;
  /** Files that import it directly. */
  direct: string[];
  /** Every file that reaches it through imports, with the shortest distance. */
  transitive: { file: string; depth: number }[];
  /** Test files among them (the ones to run after the change). */
  tests: string[];
}

/** What a change to `file` can break: every file that imports it, directly or through others, up to maxDepth. */
export function impactOf(map: CodeMap, file: string, maxDepth = 6): Impact {
  const seen = new Map<string, number>([[file, 0]]);
  let frontier = [file];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier) for (const by of map.importedBy.get(f) ?? []) if (!seen.has(by)) { seen.set(by, d); next.push(by); }
    frontier = next;
  }
  seen.delete(file);
  const transitive = [...seen].map(([f, depth]) => ({ file: f, depth })).sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
  // Tests: importers that are tests, plus a test named after the file (x.ts -> x.test.ts anywhere) when the walk missed it.
  const stem = basename(file).replace(/\.[a-z]+$/, "");
  const tests = new Set(transitive.filter((t) => map.files.get(t.file)?.test).map((t) => t.file));
  for (const f of map.files.values()) if (f.test && new RegExp(`(^|[/_.-])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([._-]|$)`).test(basename(f.path).replace(/\.[a-z]+$/, ""))) tests.add(f.path);
  return { file, direct: map.importedBy.get(file) ?? [], transitive, tests: [...tests].sort() };
}

/** Shortest import chain from `a` to `b` (a imports ... imports b), or undefined. */
export function importPath(map: CodeMap, a: string, b: string): string[] | undefined {
  if (a === b) return [a];
  const prev = new Map<string, string>();
  const q = [a];
  const seen = new Set([a]);
  while (q.length) {
    const cur = q.shift()!;
    for (const n of map.files.get(cur)?.imports ?? []) {
      if (seen.has(n)) continue;
      seen.add(n); prev.set(n, cur);
      if (n === b) {
        const out = [b];
        let x = b;
        while (prev.has(x)) { x = prev.get(x)!; out.unshift(x); }
        return out;
      }
      q.push(n);
    }
  }
  return undefined;
}

/** The files most of the repo leans on (most importers), excluding tests. */
export function hubs(map: CodeMap, n = 12): { file: string; importedBy: number }[] {
  // Only production importers count: a file every test imports is not a hub for that reason.
  return [...map.importedBy].filter(([f]) => !map.files.get(f)?.test).map(([file, by]) => ({ file, importedBy: by.filter((b) => !map.files.get(b)?.test).length })).filter((h) => h.importedBy > 0).sort((a, b) => b.importedBy - a.importedBy || a.file.localeCompare(b.file)).slice(0, n);
}

/** Files nothing imports (entry points, scripts, or dead code), excluding tests. */
export function entryPoints(map: CodeMap, n = 12): string[] {
  return [...map.files.values()].filter((f) => !f.test && !(map.importedBy.get(f.path)?.length)).map((f) => f.path).sort().slice(0, n);
}

/** Import cycles (each listed once, smallest first), found with Tarjan's strongly connected components. */
export function cycles(map: CodeMap, n = 8): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const strong = (v: string): void => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of map.files.get(v)?.imports ?? []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const f of map.files.keys()) if (!idx.has(f)) strong(f);
  return out.sort((a, b) => a.length - b.length || a[0].localeCompare(b[0])).slice(0, n);
}

/** Folders with their file and line counts, biggest first: the shape of the repo at a glance. */
export function modules(map: CodeMap, depth = 2, n = 20): { dir: string; files: number; lines: number }[] {
  const agg = new Map<string, { files: number; lines: number }>();
  for (const f of map.files.values()) {
    const parts = f.path.split("/");
    const dir = parts.length > 1 ? parts.slice(0, Math.min(depth, parts.length - 1)).join("/") : ".";
    const a = agg.get(dir) ?? { files: 0, lines: 0 };
    a.files++; a.lines += f.lines;
    agg.set(dir, a);
  }
  return [...agg].map(([dir, a]) => ({ dir, ...a })).sort((a, b) => b.lines - a.lines || a.dir.localeCompare(b.dir)).slice(0, n);
}

export function stats(map: CodeMap): { files: number; lines: number; edges: number; tests: number; langs: Record<string, number>; external: { name: string; files: number }[] } {
  const langs: Record<string, number> = {};
  const ext = new Map<string, number>();
  let lines = 0, edges = 0, tests = 0;
  for (const f of map.files.values()) {
    langs[f.lang] = (langs[f.lang] ?? 0) + 1;
    lines += f.lines; edges += f.imports.length; if (f.test) tests++;
    for (const e of f.external) ext.set(e, (ext.get(e) ?? 0) + 1);
  }
  const external = [...ext].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)).slice(0, 15);
  return { files: map.files.size, lines, edges, tests, langs, external };
}

/** The repo outline: what `code_map overview` prints and what `sync` files into MIND. Plain text, no file contents. */
export function outline(map: CodeMap, name: string): string {
  const s = stats(map);
  const langs = Object.entries(s.langs).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l} ${c}`).join(", ");
  const lines = [
    `Code map of ${name}: ${s.files} source files, ${s.lines.toLocaleString("en-US")} lines, ${s.edges} import edges, ${s.tests} test files (${langs || "no sources"}).${map.truncated ? ` Stopped at ${MAX_FILES} files.` : ""}`,
    "",
    "Modules (folder: files, lines):",
    ...modules(map).map((m) => `- ${m.dir}: ${m.files} files, ${m.lines.toLocaleString("en-US")} lines`),
    "",
    "Hubs (the files most others import; change with care):",
    ...hubs(map).map((h) => `- ${h.file} (imported by ${h.importedBy})`),
    "",
    "Entry points (nothing imports them):",
    ...entryPoints(map).map((e) => `- ${e}`),
  ];
  const cyc = cycles(map, 5);
  if (cyc.length) lines.push("", "Import cycles:", ...cyc.map((c) => `- ${c.join(" <-> ")}`));
  if (s.external.length) lines.push("", "Main external packages:", ...s.external.map((e) => `- ${e.name} (${e.files} files)`));
  return lines.join("\n");
}
