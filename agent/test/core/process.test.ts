import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRegistry, createProcessTool } from "../../src/tools/process.ts";
import { createBuiltinTools } from "../../src/tools/index.ts";
import { hostedToolAllowed, filterHostedTools } from "../../src/hosted.ts";
import { tierAllows } from "../../src/kernel/tier.ts";

const dir = mkdtempSync(join(tmpdir(), "mc-proc-"));
const ctx = () => ({ cwd: dir, sessionId: "t" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 5000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await sleep(25); } }

test("process: start returns an id at once; tail shows output; exit code is recorded", async () => {
  const reg = new ProcessRegistry();
  const tool = createProcessTool(reg);
  const s = await tool.run({ action: "start", command: "echo hello; echo oops >&2; exit 3" }, ctx());
  assert.ok(s.ok);
  const id = String((s.meta as any).id);
  await until(() => reg.status(id)?.status === "exited");
  const st = await tool.run({ action: "status", id }, ctx());
  assert.match(st.output, /exited exit=3/);
  const t = await tool.run({ action: "tail", id }, ctx());
  assert.match(t.output, /hello/);
  assert.match(t.output, /oops/);
  assert.equal((await tool.run({ action: "tail", id: "nope" }, ctx())).ok, false);
});

test("process: a long job keeps running, can be polled, then killed", async () => {
  const reg = new ProcessRegistry();
  const tool = createProcessTool(reg);
  const id = String(((await tool.run({ action: "start", command: "echo up; sleep 30" }, ctx())).meta as any).id);
  await until(() => (reg.tail(id)?.text ?? "").includes("up"));
  assert.equal(reg.status(id)?.status, "running");
  assert.match((await tool.run({ action: "status" }, ctx())).output, new RegExp(`${id} .*running`));
  const k = await tool.run({ action: "kill", id }, ctx());
  assert.ok(k.ok);
  await until(() => reg.status(id)?.endedAt !== null);
  assert.equal(reg.status(id)?.status, "killed");
  reg.killAll();
});

test("process: tail keeps only the last N lines and caps the buffer", async () => {
  const reg = new ProcessRegistry();
  const info = reg.start("for i in 1 2 3 4 5; do echo line$i; done", dir);
  await until(() => reg.status(info.id)?.status === "exited");
  const t = reg.tail(info.id, 2)!;
  assert.match(t.text, /line4/);
  assert.match(t.text, /line5/);
  assert.doesNotMatch(t.text, /line3/);
  const big = reg.start("yes x | head -c 300000", dir);
  await until(() => reg.status(big.id)?.status === "exited");
  const b = reg.tail(big.id)!;
  assert.ok(b.text.length <= 64 * 1024);
  assert.ok(b.dropped > 0);
});

test("process: spawn options set windowsHide and detached, and win32 uses the Windows shell", () => {
  const seen: any[] = [];
  const fake = (file: string, args: string[], opts: any) => {
    seen.push({ file, args, opts });
    const c: any = new EventEmitter();
    c.pid = 4242; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true;
    return c;
  };
  const reg = new ProcessRegistry({ spawn: fake as any, platform: "win32", env: () => ({ SystemRoot: "C:\\Windows" }) });
  const info = reg.start("npm run dev", "C:\\app");
  assert.equal(info.pid, 4242);
  assert.equal(seen[0].opts.windowsHide, true);
  assert.equal(seen[0].opts.detached, true);
  assert.equal(seen[0].opts.cwd, "C:\\app");
  assert.deepEqual(seen[0].opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.match(seen[0].file, /bash|powershell/);
  assert.equal(seen[0].opts.env.SystemRoot, "C:\\Windows");
});

test("process: simulated child streams, close sets the exit code and signal", () => {
  let child: any;
  const fake = () => { child = new EventEmitter(); child.pid = 7; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true; return child; };
  const reg = new ProcessRegistry({ spawn: fake as any, platform: "linux" });
  const { id } = reg.start("x", dir);
  child.stdout.emit("data", Buffer.from("a\n"));
  child.stderr.emit("data", Buffer.from("b\n"));
  assert.equal(reg.tail(id)!.text, "a\nb\n");
  child.emit("close", 0, null);
  assert.deepEqual([reg.status(id)!.status, reg.status(id)!.exitCode], ["exited", 0]);
});

test("process: input validation and the running cap", () => {
  const reg = new ProcessRegistry({ spawn: (() => { const c: any = new EventEmitter(); c.pid = 1; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true; return c; }) as any, platform: "linux" });
  for (let i = 0; i < 16; i++) reg.start("x", dir);
  assert.throws(() => reg.start("x", dir), /already running/);
});

test("process: tool args validated; read/write classes", async () => {
  const tool = createProcessTool(new ProcessRegistry());
  assert.equal((await tool.run({ action: "start" }, ctx())).ok, false);
  assert.equal((await tool.run({ action: "dance" }, ctx())).ok, false);
  assert.equal(tool.classFor!({ action: "tail" }), "read");
  assert.equal(tool.classFor!({ action: "kill" }), "write");
  assert.equal(tool.classFor!({ action: "start" }), "write");
});

test("process is a desktop/CLI tool: offered locally, never on the hosted allowlist or the public tier", () => {
  const names = createBuiltinTools().map((t) => t.spec.name);
  assert.ok(names.includes("process"));
  assert.equal(hostedToolAllowed("process"), false);
  assert.equal(hostedToolAllowed("bash"), false);
  assert.ok(!filterHostedTools(createBuiltinTools()).some((t) => t.spec.name === "process"));
  const t = createBuiltinTools().find((x) => x.spec.name === "process")!;
  assert.equal(tierAllows("public", t), false);
});
