import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildCodeMap, clearCodeMapCache, cycles, entryPoints, findFile, findSymbol, hubs, impactOf, importPath, isTestPath, outline, parseSpecifiers, parseSymbols, stats,
} from "../../src/codemap/graph.ts";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "codemap-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

const TS_REPO = {
  "src/types.ts": "export interface Tool { name: string }\nexport type Id = string;\n",
  "src/util.ts": "import type { Tool } from './types.ts';\nexport function clip(s: string) { return s; }\nexport const MAX = 3;\n",
  "src/loop.ts": "import { clip } from './util.js';\nimport type { Tool } from \"./types.ts\";\nimport { readFileSync } from 'node:fs';\nexport function createLoop() {}\n",
  "src/runtime.ts": "import { createLoop } from './loop.ts';\nimport x from 'lodash/fp';\nexport class Runtime {}\n",
  "src/cli.ts": "// import { nope } from './gone.ts'\nconst r = await import('./runtime.ts');\nexport {};\n",
  "src/a.ts": "import { b } from './b.ts';\nexport const a = 1;\n",
  "src/b.ts": "import { a } from './a.ts';\nexport const b = 2;\n",
  "test/loop.test.ts": "import { createLoop } from '../src/loop.ts';\n",
  "node_modules/pkg/index.js": "export const z = 1;\n",
  "dist/out.js": "export const y = 1;\n",
  "src/types.d.ts": "declare const q: number;\n",
};

test("parse: ts/js specifiers (static, type-only, dynamic, require) and comments ignored", () => {
  const s = parseSpecifiers("import a from 'x';\nimport type { T } from \"./t.ts\";\nexport * from './e.js';\nconst m = require('fs');\nawait import('./dyn.ts');\n// import z from './no.ts'\n/* import w from './no2.ts' */\n", "ts");
  assert.deepEqual(s.sort(), ["./dyn.ts", "./e.js", "./t.ts", "fs", "x"]);
});

test("parse: python, go and rust specifiers", () => {
  assert.deepEqual(parseSpecifiers("import os, sys\nfrom .models import User, Item\nfrom . import (\n  views,\n  forms as f)\nfrom pkg.sub import thing\n# import nope\n", "py").sort(), [".forms", ".models", ".views", "os", "pkg.sub", "sys"]);
  assert.deepEqual(parseSpecifiers('import "fmt"\nimport (\n  "os"\n  h "example.com/m/handlers"\n)\n', "go").sort(), ["example.com/m/handlers", "fmt", "os"]);
  assert.deepEqual(parseSpecifiers("mod net;\npub mod db;\nuse crate::db::pool;\nuse std::io;\n", "rs").sort(), ["crate::db::pool", "mod:db", "mod:net"]);
});

test("parse: symbols, exported first", () => {
  assert.deepEqual(parseSymbols("function local() {}\nexport async function go() {}\nexport class K {}\nexport { a as b, type C };\n", "ts"), ["go", "K", "b", "C", "local"]);
  assert.deepEqual(parseSymbols("def run():\n  pass\nclass Model:\n  def inner(self): pass\ndef _hidden(): pass\n", "py"), ["run", "Model", "_hidden"]);
  assert.deepEqual(parseSymbols("func (s *S) Serve() {}\nfunc helper() {}\ntype Config struct{}\n", "go"), ["Serve", "Config", "helper"]);
});

test("build: walks sources, skips deps/build output/.d.ts, resolves .js to .ts, finds externals", () => {
  clearCodeMapCache();
  const root = repo(TS_REPO);
  const map = buildCodeMap(root);
  const paths = [...map.files.keys()].sort();
  assert.deepEqual(paths, ["src/a.ts", "src/b.ts", "src/cli.ts", "src/loop.ts", "src/runtime.ts", "src/types.ts", "src/util.ts", "test/loop.test.ts"]);
  assert.deepEqual(map.files.get("src/loop.ts")!.imports, ["src/types.ts", "src/util.ts"]);
  assert.deepEqual(map.files.get("src/loop.ts")!.external, ["node:fs"]);
  assert.deepEqual(map.files.get("src/runtime.ts")!.external, ["lodash"]);
  assert.deepEqual(map.files.get("src/cli.ts")!.imports, ["src/runtime.ts"], "dynamic import counts, commented import does not");
  assert.equal(map.files.get("test/loop.test.ts")!.test, true);
  assert.deepEqual(map.importedBy.get("src/types.ts"), ["src/loop.ts", "src/util.ts"]);
});

test("queries: impact walks importers transitively and names the tests", () => {
  clearCodeMapCache();
  const map = buildCodeMap(repo(TS_REPO));
  const imp = impactOf(map, "src/util.ts");
  assert.deepEqual(imp.direct, ["src/loop.ts"]);
  assert.deepEqual(imp.transitive.map((t) => `${t.file}@${t.depth}`), ["src/loop.ts@1", "src/runtime.ts@2", "test/loop.test.ts@2", "src/cli.ts@3"]);
  assert.deepEqual(imp.tests, ["test/loop.test.ts"]);
  assert.equal(impactOf(map, "src/util.ts", 1).transitive.length, 1, "depth limits the walk");
  assert.deepEqual(importPath(map, "src/cli.ts", "src/types.ts"), ["src/cli.ts", "src/runtime.ts", "src/loop.ts", "src/types.ts"]);
  assert.equal(importPath(map, "src/types.ts", "src/cli.ts"), undefined);
  assert.deepEqual(cycles(map), [["src/a.ts", "src/b.ts"]]);
  assert.equal(hubs(map)[0].file, "src/types.ts");
  assert.ok(entryPoints(map).includes("src/cli.ts"));
  assert.deepEqual(findSymbol(map, "createLoop"), [{ file: "src/loop.ts", symbol: "createLoop" }]);
  assert.deepEqual(findSymbol(map, "runtime"), [{ file: "src/runtime.ts", symbol: "Runtime" }], "falls back to case-insensitive");
});

test("findFile: exact, suffix, basename, ambiguity", () => {
  clearCodeMapCache();
  const root = repo({ ...TS_REPO, "lib/util.ts": "export const u = 1;\n" });
  const map = buildCodeMap(root);
  assert.equal(findFile(map, "src/loop.ts").file, "src/loop.ts");
  assert.equal(findFile(map, "./src/loop.ts").file, "src/loop.ts");
  assert.equal(findFile(map, join(root, "src/loop.ts")).file, "src/loop.ts");
  assert.equal(findFile(map, "loop").file, "src/loop.ts");
  assert.deepEqual(findFile(map, "util.ts").candidates.sort(), ["lib/util.ts", "src/util.ts"]);
  assert.equal(findFile(map, "nothing.ts").file, undefined);
});

test("python packages, go module paths and rust modules resolve to repo files", () => {
  clearCodeMapCache();
  const map = buildCodeMap(repo({
    "app/__init__.py": "",
    "app/models.py": "class User: pass\n",
    "app/views.py": "from .models import User\nfrom app import models\nimport requests\n",
    "go.mod": "module example.com/svc\n\ngo 1.22\n",
    "main.go": 'package main\nimport (\n  "fmt"\n  "example.com/svc/handlers"\n)\nfunc main() {}\n',
    "handlers/http.go": "package handlers\nfunc Serve() {}\n",
    "handlers/http_test.go": "package handlers\n",
    "crate/src/main.rs": "mod db;\nuse crate::db::pool;\nfn main() {}\n",
    "crate/src/db/mod.rs": "pub mod pool;\n",
    "crate/src/db/pool.rs": "pub fn get() {}\n",
  }));
  assert.deepEqual(map.files.get("app/views.py")!.imports, ["app/__init__.py", "app/models.py"]);
  assert.deepEqual(map.files.get("app/views.py")!.external, ["requests"]);
  assert.deepEqual(map.files.get("main.go")!.imports, ["handlers/http.go"]);
  assert.deepEqual(map.files.get("main.go")!.external, ["fmt"]);
  assert.equal(map.files.get("handlers/http_test.go")!.test, true);
  assert.deepEqual(map.files.get("crate/src/main.rs")!.imports, ["crate/src/db/mod.rs", "crate/src/db/pool.rs"]);
  assert.deepEqual(map.files.get("crate/src/db/mod.rs")!.imports, ["crate/src/db/pool.rs"]);
  assert.deepEqual(stats(map).langs, { py: 3, go: 3, rs: 3 });
});

test("rebuild reuses unchanged files and picks up an edit", () => {
  clearCodeMapCache();
  const root = repo(TS_REPO);
  const first = buildCodeMap(root);
  const second = buildCodeMap(root);
  assert.equal(second.files.get("src/loop.ts"), first.files.get("src/loop.ts"), "unchanged file object reused");
  writeFileSync(join(root, "src/runtime.ts"), "import { clip } from './util.ts';\nexport class Runtime {}\n");
  const later = new Date(Date.now() + 5000);
  utimesSync(join(root, "src/runtime.ts"), later, later);
  const third = buildCodeMap(root);
  assert.deepEqual(third.files.get("src/runtime.ts")!.imports, ["src/util.ts"]);
  assert.deepEqual(third.importedBy.get("src/util.ts"), ["src/loop.ts", "src/runtime.ts"]);
});

test("outline: counts, modules, hubs, cycles; never file contents", () => {
  clearCodeMapCache();
  const map = buildCodeMap(repo({ ...TS_REPO, "src/secret.ts": "export const KEY = 'sk-or-v1-abcdefabcdefabcdefabcdef';\n" }));
  const text = outline(map, "acme/app");
  assert.match(text, /^Code map of acme\/app: 9 source files/);
  assert.match(text, /Hubs/);
  assert.match(text, /src\/a\.ts <-> src\/b\.ts/);
  assert.ok(!text.includes("sk-or-v1"), "outline carries no source text");
});

test("isTestPath", () => {
  for (const p of ["test/x.ts", "src/__tests__/a.js", "a.test.ts", "b.spec.js", "pkg/test_mod.py", "h_test.go", "m_test.py"]) assert.equal(isTestPath(p), true, p);
  for (const p of ["src/testing.ts", "src/contest.ts", "latest.py"]) assert.equal(isTestPath(p), false, p);
});
