import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TerminalRegistry, createTerminalTool, shellSpec, stripAnsi } from "../../src/tools/terminal.ts";
import { createBuiltinTools } from "../../src/tools/index.ts";
import { hostedToolAllowed, filterHostedTools } from "../../src/hosted.ts";
import { tierAllows } from "../../src/kernel/tier.ts";
import { botSessionTools } from "../../src/runtime.ts";
import { evaluate, factsOf } from "../../src/permissions/rules.ts";
import type { PermissionRule } from "../../src/permissions/rules.ts";
import { effectiveClass } from "../../src/tool-class.ts";
import { createIsolationGate } from "../../src/kernel/isolation.ts";
import { routingSection } from "../../src/routing.ts";

const posix = process.platform !== "win32";
const dir = mkdtempSync(join(tmpdir(), "mc-term-"));
const ctxFor = (sessionId = "chatA") => ({ cwd: dir, sessionId });
const sid = (r: { meta?: Record<string, unknown> }) => String(r.meta?.session);
const mk = (o: ConstructorParameters<typeof TerminalRegistry>[0] = {}) => new TerminalRegistry({ reapEveryMs: false, ...o });
const t = (reg: TerminalRegistry) => createTerminalTool(reg);
const has = (cmd: string) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

// ---- real shells (macOS / Linux). Windows is covered by the unit tests below and is unverified on a real machine. ----

test("terminal: open, send, read, close against a real bash; cd and variables persist", { skip: !posix }, async () => {
  const reg = mk(); const tool = t(reg);
  const o = await tool.run({ action: "open", cwd: dir }, ctxFor());
  assert.ok(o.ok, o.output);
  const id = sid(o);
  const s = await tool.run({ action: "send", session: id, text: "cd /tmp && FOO=bar && echo here=$(pwd -P) foo=$FOO", wait_ms: 3000 }, ctxFor());
  assert.match(s.output, /here=\/(private\/)?tmp foo=bar/);
  const s2 = await tool.run({ action: "send", session: id, text: "echo again=$FOO; pwd -P", wait_ms: 3000 }, ctxFor());
  assert.match(s2.output, /again=bar/);
  assert.match(s2.output, /\/(private\/)?tmp/);
  const l = await tool.run({ action: "list" }, ctxFor());
  assert.match(l.output, new RegExp(`${id} bash pid=\\d+ running`));
  const c = await tool.run({ action: "close", session: id }, ctxFor());
  assert.ok(c.ok);
  assert.match((await tool.run({ action: "list" }, ctxFor())).output, /no terminal sessions/);
  assert.equal((await tool.run({ action: "read", session: id }, ctxFor())).ok, false);
  reg.killAll();
});

test("terminal: reads return only the new output; read with no output says so", { skip: !posix }, async () => {
  const reg = mk(); const tool = t(reg);
  const id = sid(await tool.run({ action: "open" }, ctxFor()));
  await tool.run({ action: "send", session: id, text: "echo first" }, ctxFor());
  const r1 = await tool.run({ action: "read", session: id, until: "first" }, ctxFor());
  assert.match(r1.output, /first/);
  const r2 = await tool.run({ action: "read", session: id, wait_ms: 100 }, ctxFor());
  assert.equal(r2.output, "[no new output]");
  await tool.run({ action: "send", session: id, text: "echo second" }, ctxFor());
  const r3 = await tool.run({ action: "read", session: id, until: "second" }, ctxFor());
  assert.match(r3.output, /second/);
  assert.doesNotMatch(r3.output, /first/);
  reg.killAll();
});

test("terminal use case: answering a y/n prompt", { skip: !posix }, async () => {
  const reg = mk(); const tool = t(reg);
  const id = sid(await tool.run({ action: "open", cwd: dir }, ctxFor()));
  const script = join(dir, "install.sh");
  writeFileSync(script, "#!/bin/bash\nprintf 'Continue? [y/N] '\nread -r ans\nif [ \"$ans\" = y ]; then echo installed; else echo aborted; fi\n");
  chmodSync(script, 0o755);
  await tool.run({ action: "send", session: id, text: script }, ctxFor());
  const prompt = await tool.run({ action: "read", session: id, until: "\\[y/N\\]", wait_ms: 5000 }, ctxFor());
  assert.match(prompt.output, /Continue\? \[y\/N\]/);
  assert.equal(prompt.meta?.matched, true);
  const ans = await tool.run({ action: "send", session: id, text: "y", until: "installed|aborted", wait_ms: 5000 }, ctxFor());
  assert.match(ans.output, /installed/);
  reg.killAll();
});

test("terminal use case: an ssh session (mock ssh on PATH): banner, remote commands, exit", { skip: !posix }, async () => {
  const bin = mkdtempSync(join(tmpdir(), "mc-term-bin-"));
  writeFileSync(join(bin, "ssh"), "#!/bin/bash\necho \"Welcome to $1 (mock)\"\nwhile true; do printf 'remote$ '; IFS= read -r l || exit 0; [ \"$l\" = exit ] && { echo logout; exit 0; }; echo \"ran: $l\"; done\n");
  chmodSync(join(bin, "ssh"), 0o755);
  const reg = mk({ env: () => ({ PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME }) }); const tool = t(reg);
  const id = sid(await tool.run({ action: "open" }, ctxFor()));
  const login = await tool.run({ action: "send", session: id, text: "ssh deploy@build-box", until: "remote\\$ ", wait_ms: 5000 }, ctxFor());
  assert.match(login.output, /Welcome to deploy@build-box \(mock\)/);
  const r = await tool.run({ action: "send", session: id, text: "uptime", until: "ran: uptime", wait_ms: 5000 }, ctxFor());
  assert.match(r.output, /ran: uptime/);
  const out = await tool.run({ action: "send", session: id, text: "exit", until: "logout", wait_ms: 5000 }, ctxFor());
  assert.match(out.output, /logout/);
  // back in the local shell, the session is still alive
  const back = await tool.run({ action: "send", session: id, text: "echo local-again", until: "local-again", wait_ms: 5000 }, ctxFor());
  assert.match(back.output, /local-again/);
  reg.killAll();
});

test("terminal use case: a Python REPL keeps state between sends", { skip: !posix || !has("python3") }, async () => {
  const reg = mk(); const tool = t(reg);
  const id = sid(await tool.run({ action: "open" }, ctxFor()));
  await tool.run({ action: "send", session: id, text: "python3 -iu", until: ">>> ", wait_ms: 8000 }, ctxFor());
  await tool.run({ action: "send", session: id, text: "x = 2**100", wait_ms: 1000 }, ctxFor());
  const r = await tool.run({ action: "send", session: id, text: "print('x is', x)", until: "x is \\d+", wait_ms: 5000 }, ctxFor());
  assert.match(r.output, /x is 1267650600228229401496703205376/);
  await tool.run({ action: "send", session: id, text: "exit()", wait_ms: 500 }, ctxFor());
  reg.killAll();
});

test("terminal use case: a long-running dev server is tailed in pieces, then Ctrl-C stops it and the shell lives on", { skip: !posix }, async () => {
  const reg = mk(); const tool = t(reg);
  const id = sid(await tool.run({ action: "open" }, ctxFor()));
  // a "dev server": announces itself, then logs a request line every 150ms until interrupted
  await tool.run({ action: "send", session: id, text: "(echo 'server ready on :3000'; n=0; while true; do n=$((n+1)); echo \"GET /page$n 200\"; sleep 0.15; done)", wait_ms: 0 }, ctxFor());
  const up = await tool.run({ action: "read", session: id, until: "server ready on :3000", wait_ms: 5000 }, ctxFor());
  assert.match(up.output, /server ready/);
  const a = await tool.run({ action: "read", session: id, until: "GET /page3 ", wait_ms: 5000 }, ctxFor());
  assert.match(a.output, /GET \/page3 200/);
  const b = await tool.run({ action: "read", session: id, until: "GET /page8 ", wait_ms: 5000 }, ctxFor());
  assert.match(b.output, /GET \/page8 200/);
  assert.doesNotMatch(b.output, /server ready|GET \/page1 /, "a second read tails only what is new");
  const sig = await tool.run({ action: "signal", session: id }, ctxFor());
  assert.ok(sig.ok, sig.output);
  await new Promise((r) => setTimeout(r, 400));
  await tool.run({ action: "read", session: id }, ctxFor()); // drain
  await tool.run({ action: "send", session: id, text: "echo alive-after-ctrl-c", until: "alive-after-ctrl-c", wait_ms: 5000 }, ctxFor());
  assert.equal(reg.status("chatA", id).status, "running");
  reg.killAll();
});

test("terminal: signal with nothing running does not kill the shell", { skip: !posix }, async () => {
  const reg = mk(); const tool = t(reg);
  const id = sid(await tool.run({ action: "open" }, ctxFor()));
  const sig = await tool.run({ action: "signal", session: id }, ctxFor());
  assert.equal(sig.ok, false);
  assert.match(sig.output, /nothing is running/);
  assert.equal(reg.status("chatA", id).status, "running");
  reg.killAll();
});

test("terminal: a shell that exits is reported with its exit code", { skip: !posix }, async () => {
  const reg = mk(); const tool = t(reg);
  const id = sid(await tool.run({ action: "open" }, ctxFor()));
  const r = await tool.run({ action: "send", session: id, text: "exit 7", wait_ms: 3000 }, ctxFor());
  assert.match(r.output, /session exited, exit 7|session closed|exit 7/);
  const again = await tool.run({ action: "send", session: id, text: "echo hi" }, ctxFor());
  assert.equal(again.ok, false);
  assert.match(again.output, /exited/);
  reg.killAll();
});

// ---- isolation, limits, reaping ----

test("terminal: a session belongs to the chat that opened it", { skip: !posix }, async () => {
  const reg = mk(); const tool = t(reg);
  const id = sid(await tool.run({ action: "open" }, ctxFor("chatA")));
  for (const action of ["read", "send", "signal", "close"]) {
    const r = await tool.run({ action, session: id, text: "echo stolen" }, ctxFor("chatB"));
    assert.equal(r.ok, false, action);
    assert.match(r.output, /unknown session/);
  }
  assert.match((await tool.run({ action: "list" }, ctxFor("chatB"))).output, /no terminal sessions/);
  assert.match((await tool.run({ action: "list" }, ctxFor("chatA"))).output, new RegExp(id));
  reg.killAll();
});

test("terminal: per-chat session cap", { skip: !posix }, async () => {
  const reg = mk(); const tool = t(reg);
  for (let i = 0; i < 8; i++) assert.ok((await tool.run({ action: "open" }, ctxFor())).ok);
  const r = await tool.run({ action: "open" }, ctxFor());
  assert.equal(r.ok, false);
  assert.match(r.output, /8 sessions already open/);
  assert.ok((await tool.run({ action: "open" }, ctxFor("other"))).ok, "another chat is not capped by the first");
  reg.killAll();
});

test("terminal: idle sessions are reaped after 30 minutes and their process is gone", { skip: !posix }, async () => {
  let now = 1_000_000;
  const reg = mk({ now: () => now }); const tool = t(reg);
  const o = await tool.run({ action: "open" }, ctxFor());
  const id = sid(o); const pid = Number(o.meta?.pid);
  now += 29 * 60_000;
  assert.deepEqual(reg.reap(), []);
  await tool.run({ action: "read", session: id }, ctxFor()); // activity resets the idle clock
  now += 29 * 60_000;
  assert.deepEqual(reg.reap(), []);
  now += 2 * 60_000;
  assert.deepEqual(reg.reap(), [id]);
  assert.equal((await tool.run({ action: "read", session: id }, ctxFor())).ok, false);
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0), "the shell process is dead");
  reg.killAll();
});

test("terminal: killAll (app quit) kills every shell, children included", { skip: !posix }, async () => {
  const reg = mk(); const tool = t(reg);
  const pids: number[] = [];
  for (const owner of ["a", "b"]) {
    const o = await tool.run({ action: "open" }, ctxFor(owner));
    pids.push(Number(o.meta?.pid));
    await tool.run({ action: "send", session: sid(o), text: "sleep 300" }, ctxFor(owner));
  }
  await new Promise((r) => setTimeout(r, 300));
  reg.killAll();
  await new Promise((r) => setTimeout(r, 300));
  for (const p of pids) assert.throws(() => process.kill(p, 0), `shell ${p} is dead`);
  const left = spawnSync("pgrep", ["-f", "sleep 300"], { encoding: "utf8" }).stdout.trim();
  assert.equal(left, "", "no orphaned sleep");
});

test("terminal: output is capped, and dropped bytes are reported", { skip: !posix }, async () => {
  const reg = mk(); const tool = t(reg);
  const id = sid(await tool.run({ action: "open" }, ctxFor()));
  await tool.run({ action: "send", session: id, text: "head -c 400000 /dev/zero | tr '\\0' 'x'; echo; echo done-flood", until: "done-flood", wait_ms: 10000 }, ctxFor());
  const next = await tool.run({ action: "send", session: id, text: "echo after", until: "after", wait_ms: 5000 }, ctxFor());
  assert.match(next.output, /after/);
  assert.ok(next.output.length < 31_000);
  reg.killAll();
});

// ---- input validation ----

test("terminal: bad input is refused with a plain message", async () => {
  const reg = mk(); const tool = t(reg);
  assert.match((await tool.run({ action: "bogus" }, ctxFor())).output, /action must be/);
  assert.match((await tool.run({ action: "send" }, ctxFor())).output, /session is required/);
  assert.match((await tool.run({ action: "send", session: "t9", text: "x" }, ctxFor())).output, /unknown session/);
  assert.match((await tool.run({ action: "open", shell: "fish" }, ctxFor())).output, /unknown shell/);
  assert.match((await tool.run({ action: "read", session: "t9", until: "(" }, ctxFor())).output, /not a valid regular expression/);
  reg.killAll();
});

test("terminal: shells per platform", () => {
  assert.deepEqual(shellSpec("bash", "darwin"), { name: "bash", file: "bash", args: ["--noprofile", "--norc"], eol: "\n" });
  assert.ok("error" in shellSpec("cmd", "linux"));
  assert.ok("error" in shellSpec("powershell", "darwin"));
  const cmd = shellSpec("cmd", "win32") as { file: string; eol: string };
  assert.equal(cmd.file, "cmd.exe"); assert.equal(cmd.eol, "\r\n");
  const ps = shellSpec("powershell", "win32") as { file: string; args: string[] };
  assert.equal(ps.file, "powershell.exe"); assert.ok(ps.args.includes("-NonInteractive"));
  assert.equal((shellSpec("pwsh", "win32") as { file: string }).file, "pwsh");
  assert.equal((shellSpec(undefined, "linux") as { name: string }).name, "bash");
  assert.equal((shellSpec(undefined, "win32") as { name: string }).name === "bash" || (shellSpec(undefined, "win32") as { name: string }).name === "powershell", true);
});

test("terminal (Windows shape, mocked spawn): hidden window, piped stdin, no detach, CRLF for cmd, taskkill on close", async () => {
  const { EventEmitter } = await import("node:events");
  const calls: { file: string; args: string[]; opts: any }[] = [];
  const written: string[] = [];
  const spawned: any[] = [];
  const spawn = (file: string, args: string[], opts: any) => {
    calls.push({ file, args, opts });
    const c: any = new EventEmitter();
    c.pid = 4242; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.stdin = Object.assign(new EventEmitter(), { write: (d: string) => { written.push(d); return true; }, end: () => {} });
    c.kill = () => true;
    spawned.push(c);
    return c;
  };
  const reg = mk({ spawn, platform: "win32", env: () => ({ SystemRoot: "C:\\Windows" }) });
  const info = reg.open("o", "C:\\work", "cmd");
  assert.equal(calls[0].file, "cmd.exe");
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.detached, false);
  assert.deepEqual(calls[0].opts.stdio, ["pipe", "pipe", "pipe"]);
  reg.send("o", info.id, "dir");
  assert.deepEqual(written, ["dir\r\n"]);
  spawned[0].stdout.emit("data", Buffer.from("Volume in drive C\r\n"));
  const r = await reg.read("o", info.id, { waitMs: 0 });
  assert.equal(r.text, "Volume in drive C\n");
  reg.close("o", info.id);
});

test("stripAnsi removes colour and cursor codes and normalises CRLF", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m\r\nline\x1b]0;title\x07!"), "red\nline!");
});

// ---- same safety classes and gates as bash; never hosted ----

test("terminal is never allowed on the hosted server, and not for public identities or bots", () => {
  assert.equal(hostedToolAllowed("terminal"), false);
  assert.equal(hostedToolAllowed("bash"), false);
  const all = createBuiltinTools();
  assert.ok(all.some((x) => x.spec.name === "terminal"), "desktop/CLI sessions are offered terminal");
  assert.equal(filterHostedTools(all).some((x) => x.spec.name === "terminal"), false);
  const term = all.find((x) => x.spec.name === "terminal")!;
  assert.equal(tierAllows("public", term), false);
  assert.equal(tierAllows("public", term, { action: "read" }), false);
  assert.equal(botSessionTools(all).some((x) => x.spec.name === "terminal"), false);
});

test("terminal send is a write (like bash); read and list are reads", () => {
  const term = createTerminalTool(mk());
  assert.equal(term.class, "write");
  for (const a of ["open", "send", "signal", "close"]) assert.equal(effectiveClass(term, { action: a }), "write", a);
  for (const a of ["read", "list"]) assert.equal(effectiveClass(term, { action: a }), "read", a);
});

const rule = (effect: "allow" | "deny", tool: string, kind: any, value?: string): PermissionRule =>
  ({ id: `r-${effect}-${tool}-${kind}`, effect, tool, matcher: value === undefined ? { kind } : { kind, value }, scope: "t", createdAt: 1, uses: 0 });

test("permission rules see what send types as a command; a bash ban covers it; a bash allow does not", () => {
  const send = (text: string) => factsOf("terminal", "write", { action: "send", session: "t1", text }, "/proj");
  assert.equal(send("git push origin main\n").command, "git push origin main");
  assert.equal(send("ls\nrm -rf x").command, "ls ; rm -rf x", "a multi-line paste is not one simple command");
  assert.equal(factsOf("terminal", "read", { action: "read", session: "t1" }, "/proj").command, undefined);
  assert.equal(evaluate([rule("deny", "bash", "prefix", "git push")], send("echo hi && git push --force")).effect, "deny");
  assert.equal(evaluate([rule("deny", "bash", "prefix", "git push")], send("ls")).effect, "none");
  assert.equal(evaluate([rule("allow", "bash", "prefix", "ls")], send("ls")).effect, "none", "an allow for bash never auto-allows terminal");
  assert.equal(evaluate([rule("allow", "terminal", "prefix", "ls")], send("ls -la")).effect, "allow");
  assert.equal(evaluate([rule("allow", "terminal", "prefix", "ls")], send("ls\nrm -rf x")).effect, "none");
  assert.equal(evaluate([rule("deny", "bash", "prefix", "rm")], send("ls\nrm -rf x")).effect, "deny");
});

test("isolation gate checks what send types, like bash", () => {
  const gate = createIsolationGate({ githubRoot: join(dir, "gh"), worktreesRoot: join(dir, "wt"), cwd: dir });
  const v = gate.preTool!({} as never, { id: "1", name: "terminal", args: { action: "send", session: "t1", text: "echo hi" } }, {} as never);
  assert.equal(v, undefined);
});

test("routing: terminal is offered after process and before computer, bash is for one-shot", () => {
  const r = routingSection(["web_fetch", "bash", "process", "terminal", "computer"]).join("\n");
  assert.match(r, /terminal for an interactive session/);
  assert.ok(r.indexOf("process for anything") < r.indexOf("terminal for an interactive"));
  assert.ok(r.indexOf("terminal for an interactive") < r.indexOf("computer, LAST"));
  assert.match(r, /bash is for one-shot commands, process for a long background job you only poll, terminal for back-and-forth/);
  assert.match(r, /never into a terminal window/);
  assert.doesNotMatch(routingSection(["bash", "process"]).join("\n"), /terminal for an interactive/);
});

test("the shell never inherits secrets from the gateway environment", { skip: !posix }, async () => {
  process.env.OPENROUTER_API_KEY = "sk-secret-do-not-leak";
  const reg = mk(); const tool = t(reg);
  const id = sid(await tool.run({ action: "open" }, ctxFor()));
  const r = await tool.run({ action: "send", session: id, text: "echo key=[$OPENROUTER_API_KEY]", until: "key=", wait_ms: 3000 }, ctxFor());
  assert.match(r.output, /key=\[\]/);
  delete process.env.OPENROUTER_API_KEY;
  reg.killAll();
});
