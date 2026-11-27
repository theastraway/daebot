// code_map: the repository as a graph, with MIND around it. Before a change, Daebot asks what depends on the file, which tests
// cover it and what the user's MIND already remembers about it (decisions, bugs, lessons); after mapping a repo it can file the
// outline into MIND so every later session, helper and bot starts from it. Reading is class read with a SURFACE receipt (it reads
// the files on disk); `sync` writes one private MIND document and is class write.
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { MindClient, Tool, ToolResult } from "../types.ts";
import { done, failed } from "../tools/contract.ts";
import { MIND_RECALL_HEADER, withOriginTag } from "../mind/origin.ts";
import { screenUntrustedText, withScreenNotice } from "../tools/text-screen.ts";
import { repoSlug } from "../learn/scope.ts";
import { execFileSync } from "node:child_process";
import {
  buildCodeMap, cycles, findFile, findSymbol, hubs, impactOf, importPath, outline, stats, type CodeMap,
} from "./graph.ts";

export const CODE_MAP_ACTIONS = ["overview", "file", "impact", "find", "path", "cycles", "sync"] as const;
type Action = (typeof CODE_MAP_ACTIONS)[number];

export interface CodeMapOptions {
  /** The session's MIND (home). Absent: impact has no recall and sync is refused. */
  mind?: () => MindClient | undefined;
  /** Repo name for a root (owner/repo from the git origin, else the folder name). Injected by tests. */
  repoName?: (root: string) => string;
  /** How long the recall may take before impact answers without it. */
  recallMs?: number;
  now?: () => number;
}

function defaultRepoName(root: string): string {
  try {
    const remote = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] });
    const slug = repoSlug(remote);
    if (slug) return slug;
  } catch { /* not a git checkout, or no git */ }
  return basename(root) || root;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
const list = (xs: readonly string[], n: number): string => xs.length ? xs.slice(0, n).map((x) => `- ${x}`).join("\n") + (xs.length > n ? `\n- … ${xs.length - n} more` : "") : "- (none)";

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => { t = setTimeout(() => r(undefined), ms); })]);
  } catch { return undefined; } finally { if (t) clearTimeout(t); }
}

export function createCodeMapTool(o: CodeMapOptions = {}): Tool {
  const repoName = o.repoName ?? defaultRepoName;
  return {
    class: "read",
    receipt: "surface",
    classFor: (a) => (a.action === "sync" ? "write" : "read"),
    spec: {
      name: "code_map",
      description:
        "The repository as a graph: files, the symbols they define and who imports whom (TypeScript/JavaScript, Python, Go, Rust). Use it BEFORE you change code. " +
        "overview: modules, hub files, entry points, cycles. file: one file's symbols, imports and importers. impact: everything a change to a file (or a symbol's file) can break, " +
        "the tests to run, and what the user's MIND remembers about those files. find: where a symbol is defined. path: the import chain from one file to another. cycles: import cycles. " +
        "sync: file the repo outline into the user's MIND as a private document, so later sessions and helpers start from it. root defaults to the working folder.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...CODE_MAP_ACTIONS], description: "What to do (default overview)" },
          root: { type: "string", description: "Repository folder (absolute, or relative to the working folder). Default: the working folder" },
          file: { type: "string", description: "file, impact, path: a path relative to the root, a path suffix, or a unique file name" },
          symbol: { type: "string", description: "find, impact: a function, class or type name" },
          to: { type: "string", description: "path: the file the chain should reach" },
          depth: { type: "number", description: "impact: how many import hops to follow (1-10, default 6)" },
          recall: { type: "boolean", description: "impact: also ask MIND what it remembers about these files (default true)" },
        },
        additionalProperties: false,
      },
    },
    async run(args, ctx): Promise<ToolResult> {
      const action = (String(args.action ?? "overview").trim() || "overview") as Action;
      if (!CODE_MAP_ACTIONS.includes(action)) return failed(`unknown action "${action}"`, { retry: "pointless", next: `use one of: ${CODE_MAP_ACTIONS.join(", ")}` });
      const rawRoot = String(args.root ?? "").trim();
      const root = rawRoot ? (isAbsolute(rawRoot) ? rawRoot : resolve(ctx.cwd, rawRoot)) : ctx.cwd;
      if (!existsSync(root) || !statSync(root).isDirectory()) return failed(`no such folder: ${root}`, { retry: "pointless", next: "pass root as the repository folder" });
      let map: CodeMap;
      try { map = buildCodeMap(root, { now: o.now }); } catch (e) { return failed(`could not read ${root}: ${String((e as Error)?.message ?? e).split("\n")[0]}`, { retry: "pointless" }); }
      if (map.files.size === 0) return failed(`no source files under ${root} (TypeScript, JavaScript, Python, Go or Rust)`, { retry: "pointless", next: "pass root as the repository folder" });
      const name = repoName(root);
      const meta = { root, files: map.files.size };

      const pickFile = (key: "file" | "to"): { file?: string; err?: ToolResult } => {
        const q = String(args[key] ?? "").trim();
        if (!q) return { err: failed(`${action} needs ${key}`, { retry: "pointless" }) };
        const r = findFile(map, q);
        if (r.file) return { file: r.file };
        if (r.candidates.length) return { err: failed(`"${q}" matches several files`, { retry: "pointless", next: "pass one of these paths", output: list(r.candidates, 10) }) };
        return { err: failed(`no source file matches "${q}" in ${name}`, { retry: "pointless", next: "use find with a symbol name, or overview to see the modules" }) };
      };

      switch (action) {
        case "overview": {
          return done(`${name}: ${map.files.size} files mapped`, { output: outline(map, name), meta });
        }
        case "cycles": {
          const cyc = cycles(map, 20);
          return done(cyc.length ? `${cyc.length} import cycle(s) in ${name}` : `no import cycles in ${name}`, { output: cyc.map((c) => `- ${c.join(" <-> ")}`).join("\n"), meta });
        }
        case "find": {
          const sym = String(args.symbol ?? "").trim();
          if (!sym) return failed("find needs symbol", { retry: "pointless" });
          const hits = findSymbol(map, sym);
          if (!hits.length) return failed(`no file in ${name} defines "${sym}" at top level`, { retry: "pointless", next: "try grep for the name; it may be a method or defined dynamically" });
          const lines = hits.map((h) => `- ${h.symbol} in ${h.file} (imported by ${map.importedBy.get(h.file)?.length ?? 0})`);
          return done(`"${sym}" is defined in ${hits.length} file(s)`, { output: lines.join("\n"), artifacts: hits.map((h) => h.file), meta });
        }
        case "file": {
          const p = pickFile("file");
          if (p.err) return p.err;
          const f = map.files.get(p.file!)!;
          const by = map.importedBy.get(f.path) ?? [];
          const out = [
            `${f.path} (${f.lang}, ${f.lines} lines${f.test ? ", test" : ""})`,
            `Symbols: ${f.symbols.length ? f.symbols.join(", ") : "(none at top level)"}`,
            `Imports (${f.imports.length}):`, list(f.imports, 40),
            `Imported by (${by.length}):`, list(by, 40),
            `External packages: ${f.external.length ? f.external.join(", ") : "(none)"}`,
          ];
          return done(`${f.path}: imports ${f.imports.length}, imported by ${by.length}`, { output: out.join("\n"), artifacts: [f.path], meta });
        }
        case "path": {
          const a = pickFile("file"); if (a.err) return a.err;
          const b = pickFile("to"); if (b.err) return b.err;
          const chain = importPath(map, a.file!, b.file!);
          if (!chain) return done(`${a.file} does not reach ${b.file} through imports`, { output: `Reverse: ${importPath(map, b.file!, a.file!)?.join(" -> ") ?? "no chain either way"}`, meta });
          return done(`${a.file} reaches ${b.file} in ${chain.length - 1} hop(s)`, { output: chain.join(" -> "), meta });
        }
        case "impact": {
          let target: string | undefined;
          if (String(args.file ?? "").trim()) { const p = pickFile("file"); if (p.err) return p.err; target = p.file; }
          else if (String(args.symbol ?? "").trim()) {
            const hits = findSymbol(map, String(args.symbol));
            if (!hits.length) return failed(`no file in ${name} defines "${String(args.symbol)}"`, { retry: "pointless", next: "pass file instead" });
            if (hits.length > 1) return failed(`"${String(args.symbol)}" is defined in several files`, { retry: "pointless", next: "pass file with one of these", output: list(hits.map((h) => h.file), 10) });
            target = hits[0].file;
          } else return failed("impact needs file or symbol", { retry: "pointless" });
          const depth = Math.max(1, Math.min(10, Math.round(Number(args.depth) || 6)));
          const imp = impactOf(map, target!, depth);
          const risk = imp.transitive.length >= 25 ? "high" : imp.transitive.length >= 6 ? "medium" : "low";
          const out = [
            `Change to ${imp.file}: ${imp.direct.length} direct importer(s), ${imp.transitive.length} file(s) reachable within ${depth} hop(s). Blast radius: ${risk}.`,
            "Direct importers:", list(imp.direct, 30),
            "Further out (depth):", list(imp.transitive.filter((t) => t.depth > 1).map((t) => `${t.file} (${t.depth})`), 30),
            "Tests to run:", list(imp.tests, 30),
          ];
          let withheld = 0;
          const client = args.recall === false ? undefined : o.mind?.();
          if (client) {
            const names = [imp.file, ...imp.direct.slice(0, 4)].map((f) => basename(f)).join(" ");
            const q = `${name} ${names}: past decisions, bugs, incidents, lessons or rules about these files`;
            const text = await withTimeout(client.query(q, { maxContextTokens: 1200, signal: ctx.signal }), o.recallMs ?? 8000);
            if (text && text.trim()) {
              const sc = screenUntrustedText(clip(text.trim(), 3500));
              withheld = sc.withheld;
              out.push("", "What MIND remembers:", MIND_RECALL_HEADER, withScreenNotice(sc));
            } else out.push("", "What MIND remembers: nothing came back in time (answer without it, or ask mind_query).");
          }
          return done(`impact of ${imp.file}: ${imp.transitive.length} dependent file(s), ${imp.tests.length} test(s), risk ${risk}`, {
            output: out.join("\n"), artifacts: [imp.file, ...imp.tests.slice(0, 10)], meta: { ...meta, dependents: imp.transitive.length, tests: imp.tests.length, risk, ...(withheld ? { withheld } : {}) },
          });
        }
        case "sync": {
          const client = o.mind?.();
          if (!client) return failed("MIND is not connected in this session, so the map cannot be filed", { retry: "pointless" });
          const day = new Date((o.now ?? Date.now)()).toISOString().slice(0, 10);
          const s = stats(map);
          const body = [
            outline(map, name),
            "",
            `Root on the machine that mapped it: ${root}`,
            `Mapped by Daebot's code_map on ${day}. Ask code_map impact before changing a hub file.`,
          ].join("\n");
          const tags = withOriginTag(["daebot-codemap", `repo:${name}`.slice(0, 80), ...hubs(map, 3).map((h) => `hub:${basename(h.file)}`)], "tool");
          try {
            const r = await client.remember({ type: "document", title: `Code map - ${name} - ${day}`, content: body, tags, source: "daebot-codemap", origin: "tool" }, ctx.signal);
            return done(`filed the code map of ${name} in MIND (${s.files} files, ${s.edges} edges)`, { output: String(r ?? "").split("\n")[0].slice(0, 300), meta });
          } catch (e) {
            return failed(`MIND did not take the code map: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200)}`, { retry: "safe", stop: "after one retry, tell the user" });
          }
        }
      }
    },
  };
}
