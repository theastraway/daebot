import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startGateway } from "../../src/gateway/index.ts";
import { deviceSupport } from "../../src/devices/index.ts";
import type { WhichFn } from "../../src/devices/index.ts";
import { auth, fakeRuntime, http, tmpStatic } from "../gateway/helpers.ts";

const bash: WhichFn = (name) => (name === "bash" ? "/bin/bash" : undefined);

test("deviceSupport: darwin with simctl can offer the iOS Simulator; the terminal is pipes, not a PTY", () => {
  const which: WhichFn = (name) => (name === "bash" || name === "simctl" || name === "xcrun simctl" ? "/usr/bin/" + name.split(" ").pop() : undefined);
  const d = deviceSupport("darwin", which);
  assert.equal(d.ios_simulator.available, true);
  assert.match(d.ios_simulator.note, /xcrun simctl is available/);
  assert.equal(d.terminal.available, true);
  assert.equal(d.terminal.pty, false);
  assert.match(d.terminal.note, /no PTY/);
  assert.equal(d.browser.available, false);
  assert.match(d.browser.note, /persist:daebot-browser/);
  assert.match(d.browser.note, /desktop app/);
  // a boolean hit counts, the same as a path
  const flag = deviceSupport("darwin", (name) => name === "simctl" || name === "bash");
  assert.equal(flag.ios_simulator.available, true);
  assert.equal(flag.terminal.available, true);
});

test("deviceSupport: linux and win32 have no iOS Simulator", () => {
  const linux = deviceSupport("linux", bash);
  assert.equal(linux.ios_simulator.available, false);
  assert.match(linux.ios_simulator.note, /not available/);
  assert.match(linux.ios_simulator.note, /Mac/);
  assert.equal(linux.terminal.pty, false);
  assert.equal(linux.browser.available, false);
  assert.match(linux.browser.note, /desktop app/);
  assert.match(linux.browser.note, /cannot browse/);

  const win = deviceSupport("win32", (name) => name === "powershell" || name === "cmd");
  assert.equal(win.ios_simulator.available, false);
  assert.match(win.ios_simulator.note, /not available/);
  assert.match(win.ios_simulator.note, /Mac|xcrun simctl/);
  assert.equal(win.terminal.available, true);
  assert.equal(win.terminal.pty, false);
});

test("deviceSupport: a Mac without simctl says it was not found; a missing shell is unavailable", () => {
  const mac = deviceSupport("darwin", bash);
  assert.equal(mac.ios_simulator.available, false);
  assert.match(mac.ios_simulator.note, /not found/);
  const none = deviceSupport("linux", () => { throw new Error("no path"); });
  assert.equal(none.terminal.available, false);
  assert.match(none.terminal.note, /No shell/);
  assert.equal(none.ios_simulator.available, false);
  const blank = deviceSupport("darwin", () => "  ");
  assert.equal(blank.terminal.available, false);
  assert.equal(blank.ios_simulator.available, false);
});

test("GET /devices is local, and the hosted deployment does not mount it", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-dev-"));
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir, tokenPath: join(home, "tok") });
  try {
    assert.equal((await http(gw.url, "GET", "/devices")).status, 401);
    const r = await http(gw.url, "GET", "/devices", { headers: auth(gw.token) });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.terminal.pty, false);
    assert.equal(typeof body.terminal.available, "boolean");
    assert.equal(typeof body.terminal.note, "string");
    assert.equal(body.browser.available, false);
    assert.match(body.browser.note, /persist:daebot-browser/);
    assert.match(body.browser.note, /no desktop connected/);
    if (process.platform !== "darwin") {
      assert.equal(body.ios_simulator.available, false);
      assert.match(body.ios_simulator.note, /not available|Mac|simctl/);
    } else {
      assert.equal(typeof body.ios_simulator.available, "boolean");
      assert.match(body.ios_simulator.note, body.ios_simulator.available ? /available/ : /not found/);
    }
    assert.equal((await http(gw.url, "POST", "/devices", { headers: auth(gw.token), body: {} })).status, 405);
  } finally { await gw.close(); }

  const st = tmpStatic();
  writeFileSync(join(st.dir, "login.html"), "<!doctype html><title>login</title>");
  const token = randomBytes(18).toString("hex");
  const hosted = await startGateway({ runtime: fakeRuntime(), port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: { token, allowedHosts: ["daebot.live", "localhost"] } });
  try {
    const H = { host: "daebot.live", "x-forwarded-proto": "https" };
    assert.equal((await http(hosted.url, "GET", "/devices", { headers: H })).status, 401);
    const lr = await http(hosted.url, "POST", "/login", { headers: H, body: { token } });
    assert.equal(lr.status, 200);
    const cookie = String(([] as string[]).concat(lr.headers["set-cookie"] as string[])[0]).split(";")[0];
    const withToken = { ...H, cookie };
    assert.equal((await http(hosted.url, "GET", "/sessions", { headers: withToken })).status, 200);
    assert.equal((await http(hosted.url, "GET", "/devices", { headers: withToken })).status, 404);
  } finally { await hosted.close(); }
});
