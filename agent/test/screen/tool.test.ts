import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenFeed, SIG_LEN } from "../../src/screen/feed.ts";
import { createScreenTool, feedBlocker, screenToolSupported } from "../../src/tools/screen.ts";
import { createComputerTool } from "../../src/tools/computer.ts";
import { createBuiltinTools } from "../../src/tools/index.ts";
import { filterHostedTools, hostedToolAllowed } from "../../src/hosted.ts";
import { routingSection } from "../../src/routing.ts";
import { composeSystemPrompt } from "../../src/runtime.ts";
import { effectiveClass } from "../../src/tool-class.ts";
import { block, sig } from "./helpers.ts";

const ctx = { cwd: "/", sessionId: "s" };
const jpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(tag), Buffer.from([0xff, 0xd9])]);
const frame = (s: Uint8Array, tag = "x") => ({ jpeg: jpeg(tag), width: 1366, height: 768, screenWidth: 2732, screenHeight: 1536, cursorX: 11, cursorY: 22, sig: s });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (tag: string) => `data:image/jpeg;base64,${jpeg(tag).toString("base64")}`;
function liveFeed(): ScreenFeed { const f = new ScreenFeed(); f.setState({ watching: true, permission: "granted" }); return f; }

test("screen tool: refuses with the exact reason when the feed cannot give a frame", async () => {
  const f = new ScreenFeed();
  const tool = createScreenTool(f);
  let r = await tool.run({ action: "look" }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /only available in the Daebot desktop app/);
  f.setState({ permission: "granted" }); // the shell attached, switch still off
  r = await tool.run({ action: "look" }, ctx);
  assert.match(r.output, /Screen watching is OFF/);
  assert.match(r.output, /do not try another way/);
  f.setState({ watching: true, permission: "needs-permission" });
  r = await tool.run({ action: "look" }, ctx);
  assert.match(r.output, /Screen Recording permission/);
  assert.match(r.output, /user has to grant it themselves/);
  f.setState({ permission: "restricted" });
  assert.match((await tool.run({ action: "wait_for_change" }, ctx)).output, /restricted/);
  f.setState({ permission: "granted", error: "no picture" });
  assert.match((await tool.run({ action: "clip" }, ctx)).output, /no picture/);
  assert.equal(feedBlocker(liveFeed()), undefined);
});

test("screen tool: status works even when off and says why", async () => {
  const f = new ScreenFeed();
  f.setState({ permission: "granted" });
  const r = await createScreenTool(f).run({ action: "status" }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /Screen watching: OFF/);
  assert.match(r.output, /Not usable now/);
});

test("screen tool: look returns the newest frame as an image, instantly, with its geometry", async () => {
  const f = liveFeed();
  f.ingest(frame(sig(), "old"));
  f.ingest(frame(sig(), "new"));
  const t0 = Date.now();
  const r = await createScreenTool(f).run({ action: "look" }, ctx);
  assert.ok(Date.now() - t0 < 100, "no waiting, no PowerShell");
  assert.equal(r.ok, true);
  assert.deepEqual(r.images, [b64("new")]);
  assert.match(r.output, /1366x768 \(screen 2732x1536\)/);
  assert.match(r.output, /cursor at 11,22/);
  assert.match(r.output, /same ones the computer tool takes/);
});

test("screen tool: look waits briefly for the first frame right after the switch is turned on", async () => {
  const f = liveFeed();
  setTimeout(() => f.ingest(frame(sig(), "first")), 40);
  const r = await createScreenTool(f).run({ action: "look" }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.images, [b64("first")]);
});

test("screen tool: wait_for_change replaces a sleep: returns the settled new frame, reports how long it waited", async () => {
  const f = liveFeed();
  f.ingest(frame(sig(80), "downloading"));
  const p = createScreenTool(f).run({ action: "wait_for_change", timeout_seconds: 5, threshold: 0.05 }, ctx);
  await sleep(40);
  const done = block(sig(80), 10, 10, 30, 20, 230);
  f.ingest(frame(done, "finished"));
  const keep = setInterval(() => f.ingest(frame(done, "finished")), 100);
  const r = await p;
  clearInterval(keep);
  assert.equal(r.ok, true);
  assert.equal(r.meta?.changed, true);
  assert.deepEqual(r.images, [b64("finished")]);
  assert.match(r.output, /screen changed after/);
});

test("screen tool: wait_for_change times out cleanly with the latest frame and says nothing changed", async () => {
  const f = liveFeed();
  f.ingest(frame(sig(), "static"));
  const r = await createScreenTool(f).run({ action: "wait_for_change", timeout_seconds: 1 }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.meta?.changed, false);
  assert.match(r.output, /timed out/);
  assert.equal(r.images?.length, 1);
});

test("screen tool: wait_for_change validates its region and clamps the timeout", async () => {
  const f = liveFeed();
  f.ingest(frame(sig()));
  const tool = createScreenTool(f);
  const bad = await tool.run({ action: "wait_for_change", region: { x: 1, y: 2, w: 0, h: 5 } }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.output, /region needs numeric x, y, w and h/);
  const spec = JSON.stringify(tool.spec);
  assert.match(spec, /max 120/);
});

test("screen tool: abort ends wait_for_change", async () => {
  const f = liveFeed();
  f.ingest(frame(sig()));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const t0 = Date.now();
  const r = await createScreenTool(f).run({ action: "wait_for_change", timeout_seconds: 60 }, { ...ctx, signal: ac.signal });
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(r.ok, false);
  assert.match(r.output, /aborted/);
});

test("screen tool: clip returns keyframes (first, last, the moments of change), asks the loop for room, and counts what it held", async () => {
  let t = 100_000;
  const f = new ScreenFeed(() => t);
  f.setState({ watching: true, permission: "granted" });
  let cur = sig(60);
  for (let i = 0; i < 16; i++) {
    if (i === 6) cur = sig(210);
    f.ingest(frame(cur, `f${i}`));
    t += 500;
  }
  const r = await createScreenTool(f, { now: () => t }).run({ action: "clip", seconds: 20, frames: 4 }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.images?.length, 4);
  assert.equal(r.images![0], b64("f0"));
  assert.equal(r.images![3], b64("f15"));
  assert.ok(r.images!.includes(b64("f6")), "the frame where the screen changed is in the clip");
  assert.ok(Number(r.meta?.imageCap) >= 4, "tells the loop to pass more than 2 images");
  assert.match(r.output, /16 frames held/);
  const six = await createScreenTool(f, { now: () => t }).run({ action: "clip", frames: 99 }, ctx);
  assert.equal(six.images?.length, 6, "capped at 6");
});

test("screen tool: save is the only thing that touches disk, is classed as a write, and says where", async () => {
  const f = liveFeed();
  f.ingest(frame(sig(), "a")); f.ingest(frame(sig(), "b"));
  const home = mkdtempSync(join(tmpdir(), "screen-home-"));
  const tool = createScreenTool(f, { home });
  assert.equal(effectiveClass(tool, { action: "look" }), "read");
  assert.equal(effectiveClass(tool, { action: "wait_for_change" }), "read");
  assert.equal(effectiveClass(tool, { action: "clip" }), "read");
  assert.equal(effectiveClass(tool, { action: "save" }), "write");
  await tool.run({ action: "look" }, ctx); await tool.run({ action: "clip" }, ctx);
  assert.deepEqual(readdirSync(home), [], "look and clip write nothing");
  const r = await tool.run({ action: "save", seconds: 30 }, ctx);
  assert.equal(r.ok, true);
  const clips = join(home, "Daebot clips");
  const [folder] = readdirSync(clips);
  assert.equal(readdirSync(join(clips, folder)).length, 2);
  assert.match(r.output, /Saved 2 frames/);
  const own = mkdtempSync(join(tmpdir(), "screen-own-"));
  assert.equal((await tool.run({ action: "save", dir: own }, ctx)).ok, true);
  assert.equal(readdirSync(own).length, 2);
});

test("screen tool: unknown action is an error", async () => {
  assert.equal((await createScreenTool(liveFeed()).run({ action: "record" }, ctx)).ok, false);
});

// ---------- hosted exclusion ----------
test("hosted: the screen tool is never allowed through on daebot.live, and the hosted filter drops it", () => {
  assert.equal(hostedToolAllowed("screen"), false);
  assert.equal(hostedToolAllowed("computer"), false);
  const all = createBuiltinTools({ screen: true, computer: true, app: true });
  assert.ok(all.some((t) => t.spec.name === "screen"), "local builds do offer it");
  const hosted = filterHostedTools(all).map((t) => t.spec.name);
  assert.ok(!hosted.includes("screen"));
  assert.ok(!hosted.includes("computer"));
  // a look-alike name cannot sneak through the mind_* / server__tool patterns
  assert.equal(hostedToolAllowed("screen_look"), false);
  assert.equal(hostedToolAllowed("mind_screen"), true, "mind_* is a different, MIND-side family (unchanged)");
});

test("screen tool: on by default for local builds, off with DAEBOT_SCREEN_WATCH=0", () => {
  assert.equal(screenToolSupported({}), true);
  assert.equal(screenToolSupported({ DAEBOT_SCREEN_WATCH: "0" }), false);
  assert.equal(screenToolSupported({ DAEBOT_SCREEN_WATCH: "false" }), false);
  assert.ok(createBuiltinTools({ computer: false, app: false }).some((t) => t.spec.name === "screen"));
  assert.ok(!createBuiltinTools({ computer: false, app: false, screen: false }).some((t) => t.spec.name === "screen"));
});

// ---------- computer uses the live frame ----------
const OLD_SHOT = "DAEBOT_SHOT 1366 768 2732 1536 10 20\nT0xE\nDAEBOT_DONE\n";
function recorder(stdout = "DAEBOT_STEP 1\nDAEBOT_DONE\n") {
  const scripts: string[] = [];
  return { scripts, run: async (script: string) => { scripts.push(script); return { stdout: scripts.length === 1 ? stdout : OLD_SHOT, stderr: "", code: 0 }; } };
}
const shotCalls = (script: string) => script.split("\n").filter((l) => /^Take-Shot\b/.test(l)).length;

test("computer with the feed off: unchanged, one PowerShell script that takes the screenshot", async () => {
  const f = new ScreenFeed();
  const rec = recorder(OLD_SHOT);
  const r = await createComputerTool(rec.run as never, f, { settleMs: 5 }).run({ action: "click", x: 5, y: 6 }, ctx);
  assert.equal(r.ok, true);
  assert.equal(shotCalls(rec.scripts[0]), 1);
  assert.deepEqual(r.images, ["data:image/jpeg;base64,T0xE"]);
  assert.doesNotMatch(r.output, /live/);
});

test("computer with the feed on: a plain screenshot is the latest frame, no PowerShell at all", async () => {
  const f = liveFeed();
  f.ingest(frame(sig(), "now"));
  const rec = recorder();
  const r = await createComputerTool(rec.run as never, f, { settleMs: 5 }).run({ action: "screenshot" }, ctx);
  assert.equal(rec.scripts.length, 0, "no PowerShell process spawned");
  assert.deepEqual(r.images, [b64("now")]);
  assert.match(r.output, /live feed/);
  assert.match(r.output, /cursor at 11,22/);
  assert.equal(r.meta?.live, true);
});

test("computer with the feed on: the action runs without a screenshot step and the picture is a frame captured AFTER the settle", async () => {
  const f = liveFeed();
  f.ingest(frame(sig(), "before"));
  const rec = recorder();
  const tool = createComputerTool(rec.run as never, f, { settleMs: 60 });
  const p = tool.run({ action: "click", x: 100, y: 200 }, ctx);
  setTimeout(() => f.ingest(frame(sig(), "mid")), 10);      // too early: inside the settle window
  setTimeout(() => f.ingest(frame(sig(), "after")), 150);   // after the settle
  const r = await p;
  assert.equal(rec.scripts.length, 1);
  assert.match(rec.scripts[0], /P 100 200/);
  assert.equal(shotCalls(rec.scripts[0]), 0, "the script takes no screenshot");
  assert.deepEqual(r.images, [b64("after")], "not the stale frame already in the buffer");
  assert.match(r.output, /Did click at 100,200 \(live feed\)/);
});

test("computer with the feed on: a batch returns only its final frame, even if steps asked for screenshots", async () => {
  const f = liveFeed();
  f.ingest(frame(sig(), "start"));
  const rec = recorder("DAEBOT_STEP 1\nDAEBOT_STEP 2\nDAEBOT_STEP 3\nDAEBOT_DONE\n");
  const tool = createComputerTool(rec.run as never, f, { settleMs: 5 });
  const p = tool.run({ actions: [{ action: "click", x: 1, y: 2, screenshot: true }, { action: "type", text: "hi", screenshot: true }, { action: "key", keys: "enter" }] }, ctx);
  setTimeout(() => f.ingest(frame(sig(), "end")), 40);
  const r = await p;
  assert.equal(rec.scripts.length, 1, "one process for the whole batch");
  assert.equal(shotCalls(rec.scripts[0]), 0);
  assert.equal(r.images?.length, 1);
  assert.deepEqual(r.images, [b64("end")]);
  assert.match(r.output, /Did 3 actions/);
});

test("computer with the feed on and screenshot:false: runs the actions and sends no picture", async () => {
  const f = liveFeed();
  f.ingest(frame(sig(), "s"));
  const rec = recorder();
  const r = await createComputerTool(rec.run as never, f, { settleMs: 5 }).run({ action: "move", x: 3, y: 4, screenshot: false }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.images, []);
  assert.match(r.output, /No screenshot was taken/);
});

test("computer with the feed on but silent after the action: falls back to a PowerShell screenshot instead of failing", async () => {
  const f = liveFeed();
  f.ingest(frame(sig(), "only"));
  const rec = recorder();
  // settleMs 5 + 3000ms wait would be slow; shrink by switching the feed off mid-wait, which ends next() at once
  const tool = createComputerTool(rec.run as never, f, { settleMs: 5 });
  const p = tool.run({ action: "click", x: 1, y: 1 }, ctx);
  setTimeout(() => f.setState({ watching: false }), 30);
  const r = await p;
  assert.equal(rec.scripts.length, 2, "action script, then the fallback screenshot script");
  assert.equal(shotCalls(rec.scripts[1]), 1);
  assert.deepEqual(r.images, ["data:image/jpeg;base64,T0xE"]);
});

test("computer with a stale feed (no recent frame) behaves like the feed is off", async () => {
  let t = 0;
  const f = new ScreenFeed(() => t);
  f.setState({ watching: true, permission: "granted" });
  f.ingest(frame(sig(), "old"));
  t += 60_000;
  const rec = recorder(OLD_SHOT);
  const r = await createComputerTool(rec.run as never, f, { settleMs: 5 }).run({ action: "click", x: 1, y: 1 }, ctx);
  assert.equal(shotCalls(rec.scripts[0]), 1);
  assert.deepEqual(r.images, ["data:image/jpeg;base64,T0xE"]);
});

test("computer: the terminal ban and argument checks still apply with the feed on", async () => {
  const f = liveFeed();
  f.ingest(frame(sig()));
  const rec = recorder();
  const tool = createComputerTool(rec.run as never, f, { settleMs: 5 });
  assert.equal((await tool.run({ action: "key", keys: "win+r" }, ctx)).ok, false);
  assert.equal((await tool.run({ action: "click" }, ctx)).ok, false);
  assert.equal(rec.scripts.length, 0);
});

// ---------- routing prompt ----------
const desk = ["web_fetch", "bash", "process", "app", "computer", "screen", "mind_query"];
test("routing: the screen-first lines appear only while the feed is on", () => {
  const off = routingSection(desk).join("\n");
  assert.doesNotMatch(off, /watch their screen/);
  const on = routingSection(desk, { screenWatching: true }).join("\n");
  assert.match(on, /## The user is letting you watch their screen/);
  assert.match(on, /screen look/);
  assert.match(on, /wait_for_change/);
  assert.match(on, /instead of a fixed wait/);
  assert.match(on, /Background tools still come first/);
  assert.match(on, /not watching between calls/);
  // background tools still outrank the screen in the numbered list
  assert.ok(on.indexOf("web_fetch for anything") < on.indexOf("## The user is letting you watch"));
  assert.ok(on.indexOf("computer, LAST") < on.indexOf("## The user is letting you watch"));
  // without the screen tool in the session the lines never show
  assert.doesNotMatch(routingSection(["web_fetch", "bash"], { screenWatching: true }).join("\n"), /watch their screen/);
});

test("composeSystemPrompt: passes screenWatching through", () => {
  const base = { bootContext: "", surface: "web", cwd: "/", toolNames: desk };
  assert.doesNotMatch(composeSystemPrompt(base), /watch their screen/);
  assert.match(composeSystemPrompt({ ...base, screenWatching: true }), /watch their screen/);
});

test("signature length contract with the desktop shell", () => {
  assert.equal(SIG_LEN, 64 * 36);
});

// ---------- the loop passes a clip's keyframes to the model ----------
import { createAgentSession } from "../../src/loop.ts";
import { FakeKernel, FakeProvider, FakeSync, baseCfg, call, collect } from "../core/helpers.ts";

async function imagesGiven(n: number, meta?: Record<string, unknown>): Promise<number> {
  const imgs = Array.from({ length: n }, (_, i) => `data:image/jpeg;base64,${i}`);
  const tool = { class: "read" as const, spec: { name: "screen", description: "s", parameters: { type: "object" as const, properties: {} } }, async run() { return { ok: true, output: "ok", images: imgs, meta }; } };
  const provider = new FakeProvider([{ calls: [call("a", "screen", {})] }, { text: "done" }]);
  const session = createAgentSession({ id: "s1", surface: "headless", provider, kernel: new FakeKernel(), tools: [tool], sync: new FakeSync(), cfg: baseCfg(), cwd: process.cwd(), systemPrompt: "SYS", bootContext: "BOOT" });
  await collect(session.send("look"));
  return provider.requests[1].messages.find((m) => m.role === "tool" && m.name === "screen")?.images?.length ?? 0;
}

test("loop: a tool result keeps 2 images by default, and up to the tool's imageCap (never above 6)", async () => {
  assert.equal(await imagesGiven(5), 2);
  assert.equal(await imagesGiven(5, { imageCap: 4 }), 4);
  assert.equal(await imagesGiven(9, { imageCap: 99 }), 6);
  assert.equal(await imagesGiven(1, { imageCap: 4 }), 1);
});
