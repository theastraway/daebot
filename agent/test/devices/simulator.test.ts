import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBuiltinTools } from "../../src/tools/index.ts";
import { createSimulatorTool, runSimulatorJob, simulatorToolSupported } from "../../src/tools/simulator.ts";
import { createSimulatorService, runSimExec, spawnSim } from "../../src/devices/simulator-service.ts";
import type { SimSpawn } from "../../src/devices/simulator-service.ts";
import {
  MSG_IDB, MSG_INSTALL_RUNTIME, MSG_INSTALL_XCODE, MSG_JXA, MSG_NEEDS_MAC, MSG_NOT_A_SIMULATOR, MSG_UNAVAILABLE, MSG_XCODE_SELECT,
  checkAppBundle, checkOpenUrl, mapDeviceToWindow, parseSimctlList, parseWindowBounds,
} from "../../src/devices/simulator-mac.ts";
import type { SimExec } from "../../src/devices/simulator-mac.ts";
import { createFakeSimulatorService, simulatorFakeEnabled } from "../../src/devices/simulator-fake.ts";
import { routeSimulatorRequest } from "../../src/devices/simulator-remote.ts";
import { RemoteHub } from "../../src/remote/hub.ts";
import { deviceSupport } from "../../src/devices/index.ts";
import { hostedToolAllowed } from "../../src/hosted.ts";
import { tierAllows } from "../../src/kernel/tier.ts";
import { effectiveClass } from "../../src/tool-class.ts";
import { botSessionTools } from "../../src/runtime.ts";
import { routingSection } from "../../src/routing.ts";

const FIXTURE = readFileSync(fileURLToPath(new URL("./fixtures/simctl-list.json", import.meta.url)), "utf8");
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgGBgcGBwgICAgICAkJCQoKCgkJCQkKCgoKCgoMDAwKCgoKCgoKDAwMDA0ODQ0NDA0ODg8PDxISEREVFRUZGR//xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAAAAEQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAIAAgDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCNgKP/2Q==",
  "base64",
);
const PHONE = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const SE = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
const XCODE = "/Applications/Xcode.app/Contents/Developer";
const ctx = { cwd: "/tmp", sessionId: "s" };

interface Call { cmd: string; args: string[] }

function harness(o: { idb?: boolean; xcode?: "ok" | "missing" | "clt" | "no-simctl" | "bad-json" | "watch-only" | "list-fail"; list?: string } = {}) {
  const calls: Call[] = [];
  const exec: SimExec = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    assert.equal(typeof cmd, "string");
    assert.ok(Array.isArray(args));
    if (cmd === "xcode-select") {
      if (o.xcode === "missing") return { code: 1, stdout: "", stderr: "xcode-select: error" };
      if (o.xcode === "clt") return { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" };
      return { code: 0, stdout: XCODE + "\n", stderr: "" };
    }
    if (cmd === "xcrun" && args[0] === "--find") {
      if (o.xcode === "no-simctl") return { code: 1, stdout: "", stderr: "unable to find" };
      return { code: 0, stdout: "/Applications/Xcode.app/Contents/Developer/usr/bin/simctl\n", stderr: "" };
    }
    if (cmd === "xcrun" && args[1] === "list") {
      if (o.xcode === "list-fail") return { code: 1, stdout: "", stderr: "failed" };
      if (o.xcode === "bad-json") return { code: 0, stdout: "{", stderr: "" };
      if (o.xcode === "watch-only") return { code: 0, stdout: JSON.stringify({ devices: {}, runtimes: [{ identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-10-5", name: "watchOS 10.5", platform: "watchOS", version: "10.5", isAvailable: true }] }), stderr: "" };
      return { code: 0, stdout: o.list ?? FIXTURE, stderr: "" };
    }
    if (cmd === "which") return o.idb ? { code: 0, stdout: "/usr/local/bin/idb\n", stderr: "" } : { code: 1, stdout: "", stderr: "not found" };
    if (cmd === "xcrun" && args.includes("screenshot")) {
      writeFileSync(args[args.length - 1], JPEG);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "osascript" && args[0] === "-e" && String(args[1]).includes("window 1")) return { code: 0, stdout: "120, 40, 400, 860\n", stderr: "" };
    if (cmd === "idb" && args[0] === "ui" && args[1] === "describe-all") {
      return { code: 0, stdout: JSON.stringify([{ AXLabel: "Allow", frame: { x: 10, y: 20, width: 40, height: 20 } }]), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

function service(h: ReturnType<typeof harness>, extra: { spawn?: SimSpawn; home?: string; mediaDir?: string } = {}) {
  return createSimulatorService({ platform: "darwin", exec: h.exec, spawn: extra.spawn, home: extra.home, tmp: extra.home, mediaDir: extra.mediaDir, now: () => 1 });
}

test("parseSimctlList keeps available iOS simulators and ignores a watchOS runtime by itself", () => {
  const parsed = parseSimctlList(FIXTURE);
  assert.equal(parsed.iosRuntime, true);
  assert.equal(parsed.devices.filter((d) => d.available).length, 3);
  assert.equal(parsed.devices.find((d) => d.udid === PHONE)?.state, "Booted");
  assert.equal(parsed.devices.some((d) => d.udid.startsWith("CCCCCCCC")), true);
  assert.equal(parsed.devices.find((d) => d.udid.startsWith("CCCCCCCC"))?.available, false);
  const watch = parseSimctlList(JSON.stringify({ devices: {}, runtimes: [{ name: "watchOS 10.5", platform: "watchOS", identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-10-5", isAvailable: true }] }));
  assert.equal(watch.iosRuntime, false);
});

test("mapDeviceToWindow letterboxes device points into the Simulator window", () => {
  assert.deepEqual(mapDeviceToWindow({ x: 10, y: 20 }, { w: 100, h: 200 }, { x: 10, y: 20, w: 400, h: 860 }), { x: 50, y: 144 });
  assert.deepEqual(parseWindowBounds("{120, 40}, {400, 860}"), { x: 120, y: 40, w: 400, h: 860 });
  assert.equal(parseWindowBounds("nope"), undefined);
});

test("each missing-Xcode case returns its exact fix, and a tap does not touch the screen", async () => {
  const cases: { xcode: "missing" | "clt" | "no-simctl" | "bad-json" | "watch-only" | "list-fail"; message: string }[] = [
    { xcode: "missing", message: MSG_INSTALL_XCODE },
    { xcode: "clt", message: MSG_XCODE_SELECT },
    { xcode: "no-simctl", message: MSG_INSTALL_XCODE },
    { xcode: "list-fail", message: MSG_INSTALL_XCODE },
    { xcode: "bad-json", message: MSG_INSTALL_RUNTIME },
    { xcode: "watch-only", message: MSG_INSTALL_RUNTIME },
  ];
  for (const c of cases) {
    const h = harness({ xcode: c.xcode });
    const tool = createSimulatorTool({ platform: "darwin", service: service(h) });
    const r = await tool.run({ action: "tap", x: 1, y: 1 }, ctx);
    assert.equal(r.ok, false, c.xcode);
    assert.equal(r.output, c.message);
    assert.equal(h.calls.some((call) => call.cmd === "osascript"), false, c.xcode);
    assert.equal(h.calls.some((call) => call.cmd === "idb"), false, c.xcode);
  }
  assert.equal(MSG_XCODE_SELECT, "Xcode is not selected: run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` (needs your Mac password)");
  assert.equal(MSG_INSTALL_XCODE, "Install Xcode from the App Store");
  assert.equal(MSG_INSTALL_RUNTIME, "Install an iOS Simulator runtime in Xcode > Settings > Platforms");
  assert.equal(MSG_IDB, "brew install idb-companion && pip3 install fb-idb for taps (optional)");
  assert.equal(MSG_NEEDS_MAC, "needs a Mac with Xcode; on Windows/Linux ask Daebot on your paired Mac (remote hub)");
});

test("argv is an array for every action, and a udid that is not a simulator is refused", async () => {
  const h = harness({ idb: true });
  const home = realpathSync(mkdtempSync(join(tmpdir(), "sim-app-"))); // macOS tmpdir is a symlink (/var -> /private/var)
  writeFileSync(join(home, "note"), "x");
  const app = join(home, "Demo.app");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(app);
  const tool = createSimulatorTool({ platform: "darwin", service: service(h, { home, mediaDir: join(home, "media") }) });
  const list = await tool.run({ action: "list" }, { ...ctx, cwd: home });
  assert.equal(list.ok, true);
  assert.match(list.output, /iPhone 16/);
  assert.doesNotMatch(list.output, new RegExp(MSG_IDB));
  const boot = await tool.run({ action: "boot", name: "iPhone SE (3rd generation)" }, ctx);
  assert.equal(boot.ok, true);
  const bootCall = h.calls.find((c) => c.args[1] === "boot");
  assert.deepEqual(bootCall, { cmd: "xcrun", args: ["simctl", "boot", SE] });
  const ambiguous = await tool.run({ action: "boot", name: "iPhone 16" }, ctx);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.output, /udid/);
  const physical = await tool.run({ action: "shutdown", udid: "11111111-1111-1111-1111-111111111111" }, ctx);
  assert.equal(physical.ok, false);
  assert.equal(physical.output, MSG_NOT_A_SIMULATOR);
  const flag = await tool.run({ action: "boot", udid: "--erase" }, ctx);
  assert.equal(flag.ok, false);
  assert.equal(flag.output, MSG_NOT_A_SIMULATOR);
  const shot = await tool.run({ action: "screenshot", udid: PHONE }, ctx);
  assert.equal(shot.ok, true);
  assert.match(shot.images?.[0] ?? "", /^data:image\/jpeg;base64,/);
  const shotCall = h.calls.find((c) => c.args.includes("screenshot"));
  assert.deepEqual(shotCall?.args.slice(0, 5), ["simctl", "io", PHONE, "screenshot", "--type=jpeg"]);
  const launched = await tool.run({ action: "launch", udid: PHONE, bundle_id: "com.example.app" }, ctx);
  assert.equal(launched.ok, true);
  assert.deepEqual(h.calls.find((c) => c.args[1] === "launch")?.args, ["simctl", "launch", PHONE, "com.example.app"]);
  const url = checkOpenUrl("http://localhost:8080/hi");
  assert.equal(url, "http://localhost:8080/hi");
  const opened = await tool.run({ action: "openurl", udid: PHONE, url: "http://localhost:8080/hi" }, ctx);
  assert.equal(opened.ok, true);
  assert.deepEqual(h.calls.find((c) => c.args[1] === "openurl")?.args, ["simctl", "openurl", PHONE, "http://localhost:8080/hi"]);
  const fileUrl = await tool.run({ action: "openurl", udid: PHONE, url: "file:///etc/passwd" }, ctx);
  assert.equal(fileUrl.ok, false);
  assert.match(fileUrl.output, /file:/);
  const installed = await tool.run({ action: "install", udid: PHONE, app }, { ...ctx, cwd: home });
  assert.equal(installed.ok, true, installed.output);
  assert.deepEqual(h.calls.find((c) => c.args[1] === "install")?.args, ["simctl", "install", PHONE, app]);
  for (const call of h.calls) assert.equal(call.cmd === "sh" || call.args[0] === "-c", false);
});

test("install refuses an .ipa, a URL, and a path outside the user's folders", () => {
  const home = "/home/ada";
  const o = { home, cwd: home, tmp: "/tmp", stat: () => ({ isDirectory: () => true }), realpath: (p: string) => p };
  assert.match(checkAppBundle("https://example.com/App.ipa", o).ok ? "" : (checkAppBundle("https://example.com/App.ipa", o) as { error: string }).error, /internet/);
  assert.match((checkAppBundle(join(home, "Foo.ipa"), o) as { error: string }).error, /\.ipa/);
  assert.match((checkAppBundle("/Applications/Demo.app", o) as { error: string }).error, /outside/);
  const ok = checkAppBundle(join(home, "Demo.app"), o);
  assert.equal(ok.ok, true);
});

test("idb taps and describes; without idb a coordinate tap uses the Simulator window and says so", async () => {
  const withIdb = harness({ idb: true });
  const idbTool = createSimulatorTool({ platform: "darwin", service: service(withIdb) });
  const tap = await idbTool.run({ action: "tap", udid: PHONE, label: "Allow" }, ctx);
  assert.equal(tap.ok, true, tap.output);
  assert.match(tap.output, /idb/);
  const tapCall = withIdb.calls.find((c) => c.cmd === "idb" && c.args[1] === "tap");
  assert.deepEqual(tapCall?.args, ["ui", "tap", "30", "30", "--udid", PHONE]);
  assert.equal(withIdb.calls.some((c) => c.cmd === "osascript"), false);
  const described = await idbTool.run({ action: "describe", udid: PHONE }, ctx);
  assert.equal(described.ok, true);
  assert.match(described.output, /UNTRUSTED/);
  assert.deepEqual(withIdb.calls.find((c) => c.cmd === "idb" && c.args[1] === "describe-all")?.args, ["ui", "describe-all", "--udid", PHONE]);
  const swiped = await idbTool.run({ action: "swipe", udid: PHONE, x: 1, y: 2, to_x: 3, to_y: 4 }, ctx);
  assert.equal(swiped.ok, true);
  assert.deepEqual(withIdb.calls.find((c) => c.cmd === "idb" && c.args[1] === "swipe")?.args, ["ui", "swipe", "1", "2", "3", "4", "--udid", PHONE]);

  const noIdb = harness({ idb: false });
  const jxa = createSimulatorTool({ platform: "darwin", service: service(noIdb) });
  const listed = await jxa.run({ action: "list" }, ctx);
  assert.match(listed.output, new RegExp(MSG_IDB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const shot = await jxa.run({ action: "screenshot", udid: PHONE }, ctx);
  assert.equal(shot.ok, true);
  const clicked = await jxa.run({ action: "tap", udid: PHONE, x: 10, y: 20 }, ctx);
  assert.equal(clicked.ok, true, clicked.output);
  assert.match(clicked.output, new RegExp(MSG_JXA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(clicked.output, /brew install idb-companion/);
  const scripts = noIdb.calls.filter((c) => c.cmd === "osascript");
  assert.ok(scripts.some((c) => c.args[0] === "-l" && c.args[1] === "JavaScript"));
  const labeled = await jxa.run({ action: "tap", udid: PHONE, label: "Allow" }, ctx);
  assert.equal(labeled.ok, false);
  assert.match(labeled.output, /brew install idb-companion/);
  const swipe = await jxa.run({ action: "swipe", udid: PHONE, x: 1, y: 2, to_x: 3, to_y: 4 }, ctx);
  assert.equal(swipe.ok, false);
  assert.match(swipe.output, /not done by moving the mouse/);
  const before = noIdb.calls.filter((c) => c.cmd === "osascript").length;
  assert.equal(noIdb.calls.filter((c) => c.cmd === "osascript").length, before);
});

test("erase is irreversible and record stops the child with SIGINT", async () => {
  const h = harness({ idb: true });
  let killed = "";
  const spawn: SimSpawn = (cmd, args) => {
    h.calls.push({ cmd, args: [...args] });
    return { pid: 7, kill(sig) { killed = sig ?? ""; }, exited: Promise.resolve({ code: null, signal: "SIGINT" }) };
  };
  const home = mkdtempSync(join(tmpdir(), "sim-rec-"));
  const tool = createSimulatorTool({ platform: "darwin", service: service(h, { spawn, mediaDir: join(home, "media", "simulator") }) });
  assert.equal(effectiveClass(tool, { action: "erase" }), "irreversible");
  assert.equal(effectiveClass(tool, { action: "list" }), "read");
  assert.equal(effectiveClass(tool, { action: "screenshot" }), "read");
  assert.equal(effectiveClass(tool, { action: "describe" }), "read");
  assert.equal(effectiveClass(tool, { action: "boot" }), "write");
  assert.equal(tool.class, "write");
  const erased = await tool.run({ action: "erase", udid: PHONE }, ctx);
  assert.equal(erased.ok, true, erased.output);
  assert.deepEqual(h.calls.find((c) => c.args[1] === "erase")?.args, ["simctl", "erase", PHONE]);
  const started = await tool.run({ action: "record", udid: PHONE, op: "start" }, ctx);
  assert.equal(started.ok, true, started.output);
  const rec = h.calls.find((c) => c.args.includes("recordVideo"));
  assert.equal(rec?.cmd, "xcrun");
  assert.ok(rec?.args.includes("--codec=h264"));
  assert.match(rec?.args.at(-1) ?? "", /simulator-AAAAAAAA-1\.mov$/);
  const stopped = await tool.run({ action: "record", op: "stop" }, ctx);
  assert.equal(stopped.ok, true, stopped.output);
  assert.equal(killed, "SIGINT");
  assert.match(stopped.output, /\.mov/);
});

test("the tool is not offered on win32 or linux, and the public tier and hosted server never get it", async () => {
  assert.equal(simulatorToolSupported("darwin"), true);
  assert.equal(simulatorToolSupported("linux"), false);
  assert.equal(simulatorToolSupported("win32"), false);
  assert.equal(createBuiltinTools().some((t) => t.spec.name === "simulator"), simulatorToolSupported()); // default follows the host: on only on a Mac
  assert.equal(createBuiltinTools({ simulator: true }).some((t) => t.spec.name === "simulator"), true);
  const linux = createSimulatorTool({ platform: "linux" });
  const missed = await linux.run({ action: "list" }, ctx);
  assert.equal(missed.ok, false);
  assert.equal(missed.output, MSG_UNAVAILABLE);
  const win = await createSimulatorTool({ platform: "win32" }).run({ action: "boot", name: "iPhone 16" }, ctx);
  assert.equal(win.output, MSG_UNAVAILABLE);
  assert.equal(hostedToolAllowed("simulator"), false);
  const tool = createSimulatorTool({ platform: "darwin", service: service(harness()) });
  assert.equal(tierAllows("public", tool), false);
  assert.equal(tierAllows("public", tool, { action: "list" }), false);
  assert.equal(botSessionTools([tool]).some((t) => t.spec.name === "simulator"), false);
  assert.equal(botSessionTools([tool], { localTools: true }).some((t) => t.spec.name === "simulator"), true);
  const linuxSvc = createSimulatorService({ platform: "linux", exec: async () => { throw new Error("should not run"); } });
  assert.equal((await linuxSvc.status()).available, false);
  assert.ok((await linuxSvc.status()).note.includes(MSG_NEEDS_MAC));
  assert.ok(deviceSupport("linux", () => "/bin/bash").ios_simulator.note.includes(MSG_NEEDS_MAC));
  const steps = routingSection(["bash", "terminal", "simulator", "app"]);
  const simAt = steps.findIndex((s) => s.includes("simulator for an iOS Simulator"));
  const termAt = steps.findIndex((s) => s.includes("terminal for an interactive"));
  const appAt = steps.findIndex((s) => s.startsWith("4. app") || s.includes("app (background"));
  assert.ok(simAt > termAt && simAt < appAt);
});

test("runSimExec and spawnSim pass argv with no shell", async () => {
  const r = await runSimExec(process.execPath, ["-e", "process.stdout.write('ARGV_OK')"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "ARGV_OK");
  const child = spawnSim(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  assert.ok(child.pid);
  await new Promise((res) => setTimeout(res, 80));
  const cmd = process.platform === "linux"
    ? readFileSync(`/proc/${child.pid}/cmdline`, "utf8")
    : (await runSimExec("ps", ["-o", "command=", "-p", String(child.pid)])).stdout;
  assert.match(cmd, /node|ARGV|setInterval/);
  assert.doesNotMatch(cmd, /^sh\0|-c\0/);
  child.kill("SIGINT");
  const done = await Promise.race([child.exited, new Promise<undefined>((res) => setTimeout(() => res(undefined), 2000))]);
  assert.ok(done, "SIGINT stopped the record-style child");
});

test("a simulator request becomes a hub job for the paired Mac, and erase does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "sim-hub-"));
  const hub = new RemoteHub({ dir });
  hub.heartbeat("owner", { id: "d_" + "a".repeat(16), name: "Studio Mac", slugs: [], os: "mac", kind: "machine" });
  const no = routeSimulatorRequest(hub, "owner", { sessionId: "s1", action: "erase", args: { udid: PHONE } });
  assert.equal(no.ok, false);
  if (!no.ok) assert.equal(no.status, 409);
  assert.equal(hub.devices("owner").length, 1);
  const yes = routeSimulatorRequest(hub, "owner", { sessionId: "s1", action: "boot", args: { name: "iPhone 16" } });
  assert.equal(yes.ok, true);
  if (yes.ok) {
    assert.equal(yes.deviceName, "Studio Mac");
    assert.equal(yes.job.simulator?.action, "boot");
    assert.deepEqual(yes.job.simulator?.args, { name: "iPhone 16" });
  }
  const queued = hub.devices("owner");
  assert.equal(queued[0].online, true);
  const none = routeSimulatorRequest(new RemoteHub({ dir: mkdtempSync(join(tmpdir(), "sim-hub2-")) }), "owner", { sessionId: "s1", action: "list" });
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.error, MSG_UNAVAILABLE);
});

test("the fixture simulator is off unless every smoke flag is set", async () => {
  assert.equal(simulatorFakeEnabled({}), false);
  assert.equal(simulatorFakeEnabled({ DAEBOT_SIMULATOR_FAKE: "1", DAEBOT_DEV_SHOTS: "1" }), false);
  assert.equal(simulatorFakeEnabled({ DAEBOT_SIMULATOR_FAKE: "1", DAEBOT_DEV_SHOTS: "1", MINDCLAW_DESKTOP_FAKE: "1" }, true), false);
  assert.equal(simulatorFakeEnabled({ DAEBOT_SIMULATOR_FAKE: "1", DAEBOT_DEV_SHOTS: "1", MINDCLAW_DESKTOP_FAKE: "1" }), true);
  const fake = createFakeSimulatorService();
  const st = await fake.status();
  assert.equal(st.fixture, true);
  assert.equal(st.available, true);
  assert.match(st.note, /Fixture/);
  const shot = await fake.screenshot();
  assert.equal(shot.ok, true);
  if (shot.ok) assert.ok(shot.jpeg.length > 10);
});

test("runSimulatorJob on a non-Mac throws instead of calling simctl", { skip: process.platform === "darwin" && "this host is a Mac" }, async () => {
  const events: string[] = [];
  await assert.rejects(() => runSimulatorJob({ sessionId: "s", simulator: { action: "list", args: {} } }, (e) => events.push(e.type), new AbortController().signal));
  assert.deepEqual(events, []);
});
