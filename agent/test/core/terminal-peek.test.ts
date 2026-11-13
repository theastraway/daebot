import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { TerminalRegistry, terminalRegistry } from "../../src/tools/terminal.ts";

const BUF_CAP = 256 * 1024;
const READ_CAP = 30_000;

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: (d: string) => boolean; end: () => void };
  kill: () => boolean;
}

function mockSpawn() {
  const children: FakeChild[] = [];
  const written: string[] = [];
  const spawn = () => {
    const child = new EventEmitter() as EventEmitter & FakeChild;
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      write(d: string) { written.push(String(d)); return true; },
      end() {},
    });
    child.kill = () => true;
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return { spawn, children, written };
}

function registry(now?: () => number) {
  const mocked = mockSpawn();
  const reg = new TerminalRegistry({ spawn: mocked.spawn, platform: "win32", reapEveryMs: false, env: () => ({ SystemRoot: "C:\\Windows" }), ...(now ? { now } : {}) });
  return { ...mocked, reg };
}

test("peek does not move the agent's read cursor", async () => {
  let now = 5_000;
  const { reg, children } = registry(() => now);
  const info = reg.open("chatA", "C:\\work", "bash");
  const openedAt = reg.status("chatA", info.id).lastActiveAt;
  children[0].stdout.emit("data", Buffer.from("one"));
  now = 9_000;
  const seen = reg.peek("chatA", info.id);
  assert.equal(seen.text, "one");
  assert.equal(seen.total, 3);
  assert.equal(seen.dropped, 0);
  assert.equal(reg.status("chatA", info.id).lastActiveAt, openedAt, "a look from the pane is not activity");
  const again = reg.peek("chatA", info.id);
  assert.equal(again.text, "one");
  children[0].stdout.emit("data", Buffer.from("two"));
  const tail = reg.peek("chatA", info.id, seen.total);
  assert.equal(tail.text, "two");
  assert.equal(tail.dropped, 0);
  now = 12_000;
  const read = await reg.read("chatA", info.id, { waitMs: 0 });
  assert.equal(read.text, "onetwo", "the agent still receives every byte the pane already showed");
  assert.equal(reg.status("chatA", info.id).lastActiveAt, 12_000);
  const after = await reg.read("chatA", info.id, { waitMs: 0 });
  assert.equal(after.text, "");
});

test("peek from an absolute offset, and a non-offset means the whole buffer", () => {
  const { reg, children } = registry();
  const info = reg.open("chatA", "C:\\work", "bash");
  children[0].stdout.emit("data", Buffer.from("0123456789"));
  const mid = reg.peek("chatA", info.id, 4);
  assert.equal(mid.text, "456789");
  assert.equal(mid.dropped, 0);
  assert.equal(mid.total, 10);
  assert.equal(reg.peek("chatA", info.id).text, "0123456789");
  assert.equal(reg.peek("chatA", info.id, Number.NaN).text, "0123456789");
  const past = reg.peek("chatA", info.id, 99);
  assert.equal(past.text, "");
  assert.equal(past.dropped, 0);
  assert.equal(past.total, 10);
});

test("peek reports bytes the ring dropped and still leaves them for the agent's read", async () => {
  const { reg, children } = registry();
  const info = reg.open("chatA", "C:\\work", "bash");
  const flood = "x".repeat(300_000) + "END";
  children[0].stdout.emit("data", Buffer.from(flood));
  const bufLen = Math.min(BUF_CAP, flood.length);
  const start = flood.length - bufLen;
  const expectedDropped = start + (bufLen - READ_CAP);
  const seen = reg.peek("chatA", info.id, 0);
  assert.equal(seen.total, flood.length);
  assert.equal(seen.text.length, READ_CAP);
  assert.ok(seen.text.endsWith("END"));
  assert.equal(seen.dropped, expectedDropped);
  const read = await reg.read("chatA", info.id, { waitMs: 0 });
  assert.ok(read.text.endsWith("END"));
  assert.ok(read.text.endsWith(seen.text));
  assert.ok(read.text.length > seen.text.length);
});

test("subscribe fires on output and on exit, and unsubscribe stops it", () => {
  const { reg, children } = registry();
  const info = reg.open("chatA", "C:\\work", "bash");
  const seen: string[] = [];
  const un = reg.subscribe("chatA", info.id, () => {
    const s = reg.status("chatA", info.id);
    seen.push(`${s.status}:${s.exitCode ?? ""}:${reg.peek("chatA", info.id).text}`);
  });
  children[0].stdout.emit("data", Buffer.from("hi\n"));
  assert.ok(seen.some((s) => s.startsWith("running:") && s.endsWith("hi\n")));
  children[0].emit("close", 3);
  assert.equal(reg.status("chatA", info.id).status, "exited");
  assert.equal(reg.status("chatA", info.id).exitCode, 3);
  assert.ok(seen.some((s) => s.startsWith("exited:3:")));
  const n = seen.length;
  un();
  children[0].stdout.emit("data", Buffer.from("later"));
  assert.equal(seen.length, n);
  un();
  assert.equal(seen.length, n, "unsubscribe is idempotent");
});

test("unsubscribe during the callback is safe, and close wakes subscribers", () => {
  const { reg, children } = registry();
  const info = reg.open("chatA", "C:\\work", "bash");
  let n = 0;
  let un = (): void => {};
  un = reg.subscribe("chatA", info.id, () => { n++; un(); });
  children[0].stdout.emit("data", Buffer.from("a"));
  children[0].stdout.emit("data", Buffer.from("b"));
  assert.equal(n, 1);

  const info2 = reg.open("chatA", "C:\\work", "bash");
  let closed = 0;
  let status = "";
  reg.subscribe("chatA", info2.id, () => { closed++; status = reg.status("chatA", info2.id).status; });
  reg.close("chatA", info2.id);
  assert.equal(closed, 1);
  assert.equal(status, "closed");
  assert.throws(() => reg.peek("chatA", info2.id), /unknown session/);
});

test("peek and subscribe refuse a session owned by another chat", () => {
  const { reg, children } = registry();
  const info = reg.open("chatA", "C:\\work", "bash");
  children[0].stdout.emit("data", Buffer.from("secret-scrollback"));
  assert.throws(() => reg.peek("chatB", info.id), /unknown session/);
  assert.throws(() => reg.subscribe("chatB", info.id, () => {}), /unknown session/);
  assert.throws(() => reg.peek("chatA", "nope"), /unknown session/);
  assert.equal(reg.peek("chatA", info.id).text, "secret-scrollback");
  assert.equal(reg.list("chatB").length, 0);
  assert.equal(reg.list("chatA").length, 1);
});

test("a throwing subscriber does not stop the agent's wake", () => {
  const { reg, children } = registry();
  const info = reg.open("chatA", "C:\\work", "bash");
  let n = 0;
  reg.subscribe("chatA", info.id, () => { throw new Error("pane broke"); });
  reg.subscribe("chatA", info.id, () => { n++; });
  children[0].stdout.emit("data", Buffer.from("z"));
  assert.equal(n, 1);
  assert.equal(reg.peek("chatA", info.id).text, "z");
});

test("a colour sequence split across chunks is stripped before the pane can see it", () => {
  const { reg, children } = registry();
  const info = reg.open("chatA", "C:\\work", "bash");
  children[0].stdout.emit("data", Buffer.from("\x1b[31"));
  assert.equal(reg.peek("chatA", info.id).text, "", "an unfinished escape is held, not shown");
  children[0].stdout.emit("data", Buffer.from("mred\x1b[0m!\n"));
  assert.equal(reg.peek("chatA", info.id).text, "red!\n");
  children[0].stderr.emit("data", Buffer.from("\x1b]0;title"));
  children[0].stderr.emit("data", Buffer.from("\x07err\n"));
  assert.equal(reg.peek("chatA", info.id).text, "red!\nerr\n");
  const read = reg.read("chatA", info.id, { waitMs: 0 });
  return read.then((r) => assert.equal(r.text, "red!\nerr\n", "the agent sees the same stripped text"));
});

test("terminalRegistry() is one shared registry", () => {
  assert.equal(terminalRegistry(), terminalRegistry());
});
