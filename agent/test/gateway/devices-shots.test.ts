import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { TerminalRegistry } from "../../src/tools/terminal.ts";
import type { TermBackend, TermHandle, TermSpawnSpec } from "../../src/tools/terminal.ts";
import { seedDevicesShot, PTY_SHOT, TERMINAL_SHOT, IOS_SIM_SHOT } from "../../src/gateway/devices-shots.ts";

function restoreFake(prev: string | undefined): void {
  if (prev === undefined) delete process.env.MINDCLAW_DESKTOP_FAKE;
  else process.env.MINDCLAW_DESKTOP_FAKE = prev;
}

test("devices shots refuse to run outside the smoke fake gateway", async () => {
  const prev = process.env.MINDCLAW_DESKTOP_FAKE;
  delete process.env.MINDCLAW_DESKTOP_FAKE;
  let opened = 0;
  try {
    await assert.rejects(
      seedDevicesShot({ async open() { opened++; return { id: "s", async *send() {} }; } }, "terminal"),
      /smoke/,
    );
    assert.equal(opened, 0);
  } finally { restoreFake(prev); }
});

test("the ios-sim seed opens a chat and does not start a shell", async () => {
  const prev = process.env.MINDCLAW_DESKTOP_FAKE;
  process.env.MINDCLAW_DESKTOP_FAKE = "1";
  const opened: string[] = [];
  let sent = 0;
  try {
    await seedDevicesShot({
      async open(surface, title) {
        opened.push(`${surface}:${title ?? ""}`);
        return { id: "s-sim", async *send() { sent++; yield { type: "done" }; } };
      },
    }, "ios-sim");
    assert.deepEqual(opened, [`web:${IOS_SIM_SHOT.title}`]);
    assert.equal(sent, 0);
  } finally { restoreFake(prev); }
});

test("an unknown pane is rejected and the browser seed does not open a chat", async () => {
  const prev = process.env.MINDCLAW_DESKTOP_FAKE;
  process.env.MINDCLAW_DESKTOP_FAKE = "1";
  let opened = 0;
  const host = { async open() { opened++; return { id: "s", async *send() {} }; } };
  try {
    await assert.rejects(seedDevicesShot(host, "nope-pane"), /nope-pane/);
    assert.equal(opened, 0);
    await seedDevicesShot(host, "browser");
    assert.equal(opened, 0);
  } finally { restoreFake(prev); }
});

test("the terminal seed types into bash stdin and never uses a shell -c wrapper", async () => {
  const prev = process.env.MINDCLAW_DESKTOP_FAKE;
  process.env.MINDCLAW_DESKTOP_FAKE = "1";
  const spawns: { file: string; args: string[]; stdin: string[] }[] = [];
  const spawn = (file: string, args: string[]) => {
    const stdin: string[] = [];
    const child = new EventEmitter() as EventEmitter & {
      pid: number; stdout: EventEmitter; stderr: EventEmitter;
      stdin: { write: (d: string) => boolean; end: () => void }; kill: () => boolean;
    };
    child.pid = 2_000_000_001 + spawns.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { write(d: string) { stdin.push(String(d)); return true; }, end() {} });
    child.kill = () => true;
    spawns.push({ file, args: [...args], stdin });
    return child as unknown as ChildProcess;
  };
  const reg = new TerminalRegistry({ spawn, platform: "linux", reapEveryMs: false, env: () => ({ PATH: "/usr/bin" }) });
  const opened: string[] = [];
  const sent: string[] = [];
  try {
    await seedDevicesShot({
      async open(surface, title) {
        opened.push(`${surface}:${title ?? ""}`);
        return { id: "s-shot", async *send(text) { sent.push(text); yield { type: "done" }; } };
      },
    }, "terminal", { registry: reg, commandWaitMs: 0 });
    assert.deepEqual(opened, [`web:${TERMINAL_SHOT.title}`]);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Open the terminal/);
    assert.equal(spawns.length, 3);
    for (const s of spawns) {
      assert.equal(s.file, "bash");
      assert.deepEqual(s.args, ["--noprofile", "--norc"]);
      assert.equal(s.args.includes("-c"), false);
    }
    const live = spawns[0].stdin.join("");
    assert.match(live, /printf/);
    assert.match(live, new RegExp(TERMINAL_SHOT.liveMarker));
    assert.match(live, /<script>alert\(1\)<\/script>/);
    assert.match(live, /ls -1/);
    assert.match(live, /line %02d/);
    assert.match(live, new RegExp(`-le ${TERMINAL_SHOT.bottomMarker.replace(/\D/g, "")}`));
    const closed = spawns[1].stdin.join("");
    assert.match(closed, new RegExp(TERMINAL_SHOT.closedMarker));
    assert.match(closed, /^exit\n/m);
    assert.equal(spawns[2].stdin.length, 0);
  } finally {
    for (const s of reg.list("s-shot")) reg.close("s-shot", s.id);
    reg.killAll();
    restoreFake(prev);
  }
});

function hasBash(): boolean {
  try { execFileSync("bash", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

test("a real bash seed prints stripped colour text, then an exited shell and an empty one", { skip: !hasBash() }, async () => {
  const prev = process.env.MINDCLAW_DESKTOP_FAKE;
  process.env.MINDCLAW_DESKTOP_FAKE = "1";
  const reg = new TerminalRegistry({ reapEveryMs: false });
  const id = "s-real";
  try {
    await seedDevicesShot({
      async open() { return { id, async *send() { yield { type: "done" }; } }; },
    }, "terminal", { registry: reg, commandWaitMs: 8000 });
    const listed = reg.list(id);
    assert.equal(listed.length, 3);
    const live = listed.find((s) => s.cwd.includes(TERMINAL_SHOT.liveDir));
    const closed = listed.find((s) => s.cwd.includes(TERMINAL_SHOT.closedDir));
    const empty = listed.find((s) => s.cwd.includes(TERMINAL_SHOT.emptyDir));
    assert.ok(live && closed && empty);
    const text = reg.peek(id, live.id).text;
    assert.match(text, /green red blue/);
    assert.match(text, new RegExp(TERMINAL_SHOT.liveMarker));
    assert.match(text, /<script>alert\(1\)<\/script>/);
    assert.match(text, /README\.txt/);
    assert.match(text, /notes\.txt/);
    assert.match(text, new RegExp(TERMINAL_SHOT.bottomMarker));
    assert.equal(text.includes("\x1b"), false, "escape codes are stripped before the pane sees them");
    assert.equal(closed.status, "exited");
    assert.equal(closed.exitCode, 0);
    assert.match(reg.peek(id, closed.id).text, new RegExp(TERMINAL_SHOT.closedMarker));
    assert.equal(empty.status, "running");
    assert.equal(reg.peek(id, empty.id).text, "");
  } finally {
    try { for (const s of reg.list(id)) reg.close(id, s.id); } catch { /* already gone */ }
    reg.killAll();
    restoreFake(prev);
  }
});

test("the pty seed refuses a pipe registry and, with a pty backend, opens three interactive shells", async () => {
  const prev = process.env.MINDCLAW_DESKTOP_FAKE;
  process.env.MINDCLAW_DESKTOP_FAKE = "1";
  const opened: string[] = [];
  const host = { async open(_surface: string, title?: string) { opened.push(title ?? ""); return { id: "s-pty", async *send() { yield { type: "done" }; } }; } };
  const pipe = new TerminalRegistry({ reapEveryMs: false, platform: "linux", env: () => ({ PATH: "/bin" }) });
  const specs: TermSpawnSpec[] = [];
  const backend: TermBackend = {
    kind: "pty",
    typeable: true,
    async openAsync(spec) {
      specs.push(spec);
      const handle: TermHandle = {
        pid: 80 + specs.length,
        write() {},
        resize() {},
        onStdout() {},
        onStderr() {},
        onError() {},
        onExit() {},
        interrupt() { return { sent: true, note: "sent Ctrl-C" }; },
        kill() {},
      };
      return handle;
    },
  };
  const reg = new TerminalRegistry({ backend, reapEveryMs: false, platform: "linux", env: () => ({ PATH: "/usr/bin" }) });
  try {
    await assert.rejects(seedDevicesShot(host, "pty", { registry: pipe }), /PTY host/);
    assert.deepEqual(opened, []);
    await seedDevicesShot(host, "pty", { registry: reg, commandWaitMs: 0 });
    assert.deepEqual(opened, [PTY_SHOT.title]);
    assert.equal(specs.length, 3);
    const dirs = specs.map((s) => s.cwd);
    assert.ok(dirs.some((d) => d.endsWith(PTY_SHOT.colorDir)));
    assert.ok(dirs.some((d) => d.endsWith(PTY_SHOT.tuiDir)));
    assert.ok(dirs.some((d) => d.endsWith(PTY_SHOT.closedDir)));
    for (const s of specs) {
      assert.equal(s.file, "bash");
      assert.deepEqual(s.args, ["--noprofile", "--norc", "-i"]);
      assert.equal(s.env.TERM, "xterm-256color");
    }
    const listed = reg.list("s-pty");
    assert.equal(listed.length, 3);
    assert.ok(listed.every((s) => s.backend === "pty" && s.typeable));
  } finally {
    reg.killAll();
    pipe.killAll();
    restoreFake(prev);
  }
});
