import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createBuiltinTools, htmlToText } from "../../src/tools/index.ts";
import { grepJs } from "../../src/tools/fs.ts";

const tools = Object.fromEntries(createBuiltinTools().map((t) => [t.spec.name, t]));
let dir: string;
const ctx = () => ({ cwd: dir, sessionId: "t" });

before(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-tools-"));
  mkdirSync(join(dir, "src/sub"), { recursive: true });
  mkdirSync(join(dir, "node_modules/x"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
  writeFileSync(join(dir, "src/main.ts"), "export const x = 1;\nconst needle = 'Findme';\n");
  writeFileSync(join(dir, "src/sub/util.ts"), "// findme again\n");
  writeFileSync(join(dir, "src/readme.md"), "Findme in md\n");
  writeFileSync(join(dir, "node_modules/x/skip.ts"), "Findme\n");
});

test("tool classes and receipts", () => {
  const cls = (n: string) => tools[n].class;
  assert.deepEqual(["read_file", "glob", "grep", "web_fetch"].map(cls), ["read", "read", "read", "read"]);
  assert.deepEqual(["write_file", "edit_file", "bash"].map(cls), ["write", "write", "write"]);
  for (const n of ["read_file", "glob", "grep", "web_fetch", "bash"]) assert.equal(tools[n].receipt, "surface", n);
});

test("read_file: numbered lines, offset/limit, missing file", async () => {
  const r = await tools.read_file.run({ path: "a.txt" }, ctx());
  assert.ok(r.ok);
  assert.match(r.output, /1\tone/);
  const part = await tools.read_file.run({ path: "a.txt", offset: 2, limit: 2 }, ctx());
  assert.match(part.output, /2\ttwo/);
  assert.match(part.output, /3\tthree/);
  assert.doesNotMatch(part.output, /4\tfour/);
  const miss = await tools.read_file.run({ path: "nope.txt" }, ctx());
  assert.equal(miss.ok, false);
  assert.match(miss.output, /not found/);
  assert.equal((await tools.read_file.run({}, ctx())).ok, false);
});

test("write_file creates parents; edit_file exact + uniqueness", async () => {
  const w = await tools.write_file.run({ path: "deep/er/f.txt", content: "aa bb aa" }, ctx());
  assert.ok(w.ok);
  assert.equal(readFileSync(join(dir, "deep/er/f.txt"), "utf8"), "aa bb aa");
  const dup = await tools.edit_file.run({ path: "deep/er/f.txt", old_string: "aa", new_string: "cc" }, ctx());
  assert.equal(dup.ok, false);
  assert.match(dup.output, /2 places/);
  const none = await tools.edit_file.run({ path: "deep/er/f.txt", old_string: "zz", new_string: "cc" }, ctx());
  assert.match(none.output, /not found/);
  const one = await tools.edit_file.run({ path: "deep/er/f.txt", old_string: "bb", new_string: "$&" }, ctx());
  assert.ok(one.ok);
  assert.equal(readFileSync(join(dir, "deep/er/f.txt"), "utf8"), "aa $& aa");
  const all = await tools.edit_file.run({ path: "deep/er/f.txt", old_string: "aa", new_string: "cc", replace_all: true }, ctx());
  assert.ok(all.ok);
  assert.equal(readFileSync(join(dir, "deep/er/f.txt"), "utf8"), "cc $& cc");
});

test("glob: patterns, skips node_modules", async () => {
  const r = await tools.glob.run({ pattern: "src/**/*.ts" }, ctx());
  assert.deepEqual(r.output.split("\n").sort(), ["src/main.ts", "src/sub/util.ts"]);
  const base = await tools.glob.run({ pattern: "*.md" }, ctx());
  assert.equal(base.output, "src/readme.md");
  const brace = await tools.glob.run({ pattern: "src/*.{ts,md}" }, ctx());
  assert.deepEqual(brace.output.split("\n").sort(), ["src/main.ts", "src/readme.md"]);
  assert.equal((await tools.glob.run({ pattern: "*.nothing" }, ctx())).output, "(no matches)");
});

test("grep (tool, ripgrep if present) and JS fallback agree", async () => {
  const r = await tools.grep.run({ pattern: "findme", ignore_case: true }, ctx());
  assert.ok(r.ok);
  const lines = r.output.split("\n").map((l) => l.split(":").slice(0, 2).join(":")).sort();
  assert.deepEqual(lines, ["src/main.ts:2", "src/readme.md:1", "src/sub/util.ts:1"]);
  const js = await grepJs({ pattern: "findme", root: dir, ignoreCase: true, maxResults: 50 });
  assert.deepEqual(js.map((l) => l.split(":").slice(0, 2).join(":")).sort(), lines);
  const g = await tools.grep.run({ pattern: "Findme", glob: "*.md" }, ctx());
  assert.equal(g.output.split(":")[0], "src/readme.md");
  assert.equal((await tools.grep.run({ pattern: "(" }, ctx())).ok, false);
  assert.equal((await tools.grep.run({ pattern: "zzzz" }, ctx())).output, "(no matches)");
});

test("bash: output, cwd, exit code, timeout, cap, abort", async () => {
  const r = await tools.bash.run({ command: "pwd && echo hi" }, ctx());
  assert.ok(r.ok);
  assert.match(r.output, /hi/);
  assert.ok(r.output.includes("mc-tools-"));
  const bad = await tools.bash.run({ command: "echo oops >&2; exit 3" }, ctx());
  assert.equal(bad.ok, false);
  assert.match(bad.output, /oops/);
  assert.match(bad.output, /exit code 3/);
  const slow = await tools.bash.run({ command: "sleep 5", timeout_ms: 150 }, ctx());
  assert.equal(slow.ok, false);
  assert.match(slow.output, /timed out/);
  const big = await tools.bash.run({ command: "yes x | head -c 200000" }, ctx());
  assert.ok(big.output.length < 31_000);
  assert.match(big.output, /truncated/);
  const ctl = new AbortController();
  const p = tools.bash.run({ command: "sleep 5" }, { ...ctx(), signal: ctl.signal });
  setTimeout(() => ctl.abort(), 100);
  const ab = await p;
  assert.equal(ab.ok, false);
  assert.match(ab.output, /aborted/);
});

test("htmlToText and web_fetch (local server)", async () => {
  assert.equal(htmlToText("<html><head><title>t</title></head><body><script>x()</script><p>Hello &amp; <b>world</b></p><p>two</p></body></html>"), "Hello & world\ntwo");
  const srv = createServer((req, res) => {
    if (req.url === "/big") { res.setHeader("content-type", "text/plain"); res.end("a".repeat(80_000)); }
    else if (req.url === "/404") { res.statusCode = 404; res.end("gone"); }
    else { res.setHeader("content-type", "text/html"); res.end("<h1>Title</h1><p>Body</p>"); }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  try {
    const ok = await tools.web_fetch.run({ url: `http://127.0.0.1:${port}/` }, ctx());
    assert.ok(ok.ok);
    assert.equal(ok.output, "Title\nBody");
    const big = await tools.web_fetch.run({ url: `http://127.0.0.1:${port}/big` }, ctx());
    assert.ok(big.output.length <= 50_100);
    const nf = await tools.web_fetch.run({ url: `http://127.0.0.1:${port}/404` }, ctx());
    assert.equal(nf.ok, false);
    assert.match(nf.output, /404/);
    assert.equal((await tools.web_fetch.run({ url: "file:///etc/passwd" }, ctx())).ok, false);
  } finally {
    srv.close();
  }
});
