import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenFeed } from "../../src/screen/feed.ts";
import { createScreenTool } from "../../src/tools/screen.ts";
import { createComputerTool, desktopPid, ownWindowPrelude } from "../../src/tools/computer.ts";
import { computerSkillLines, routingSection } from "../../src/routing.ts";
import { startGateway } from "../../src/gateway/index.ts";
import { auth, fakeRuntime, http, tmpStatic } from "../gateway/helpers.ts";
import { sig } from "./helpers.ts";

// Daebot's own window covers the screen it is trying to see or click. The tools minimize it first.

const ctx = { cwd: "/", sessionId: "s" };
const jpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(tag), Buffer.from([0xff, 0xd9])]);
const frame = (tag: string, ownVisible?: boolean) => ({ jpeg: jpeg(tag), width: 1366, height: 768, screenWidth: 2732, screenHeight: 1536, cursorX: 1, cursorY: 2, sig: sig(), ...(ownVisible === undefined ? {} : { ownVisible }) });
const b64 = (tag: string) => `data:image/jpeg;base64,${jpeg(tag).toString("base64")}`;
function liveFeed(): ScreenFeed { const f = new ScreenFeed(); f.setState({ watching: true, permission: "granted" }); return f; }
/** Plays the desktop shell: every 20 ms posts a frame; once it was told to hide, the window is down in the next frames. */
function shell(f: ScreenFeed, tags: { up: string; down: string }) {
  let hidden = false;
  const t = setInterval(() => { f.ingest(frame(hidden ? tags.down : tags.up, !hidden)); if (f.takeHide()) hidden = true; }, 20);
  return { stop: () => clearInterval(t), hidden: () => hidden };
}

test("feed: clearOwnWindow does nothing when the window is not showing or an older shell never says", async () => {
  const f = liveFeed();
  f.ingest(frame("a"));
  assert.equal(await f.clearOwnWindow(), false, "older shell: no ownVisible on frames");
  f.ingest(frame("b", false));
  assert.equal(await f.clearOwnWindow(), false, "window already minimized");
  assert.equal(f.takeHide(), false, "no request was left pending");
  assert.equal(await new ScreenFeed().clearOwnWindow(), false, "feed off");
});

test("feed: clearOwnWindow asks the shell once and returns after a frame captured with the window down", async () => {
  const f = liveFeed();
  f.ingest(frame("up", true));
  const sh = shell(f, { up: "up", down: "down" });
  try {
    assert.equal(await f.clearOwnWindow(), true);
    assert.equal(sh.hidden(), true);
    assert.equal(f.latest()!.ownVisible, false);
    assert.equal(f.takeHide(), false, "the request is handed out exactly once");
  } finally { sh.stop(); }
});

test("feed: clearOwnWindow gives up after the timeout and leaves no request pending", async () => {
  const f = liveFeed();
  f.ingest(frame("up", true));
  const t = setInterval(() => f.ingest(frame("up", true)), 20); // a shell that never hides
  try {
    assert.equal(await f.clearOwnWindow(undefined, 150), false);
    assert.equal(f.takeHide(), false);
  } finally { clearInterval(t); }
});

test("screen look: minimizes the Daebot window first and returns the frame without it", async () => {
  const f = liveFeed();
  f.ingest(frame("up", true));
  const sh = shell(f, { up: "up", down: "behind" });
  try {
    const r = await createScreenTool(f).run({ action: "look" }, ctx);
    assert.equal(r.ok, true);
    assert.deepEqual(r.images, [b64("behind")]);
    assert.match(r.output, /^Minimized the Daebot window first/);
    assert.equal(r.meta?.ownWindowMinimized, true);
  } finally { sh.stop(); }
  // window already down: no note, no wait
  const r2 = await createScreenTool(f).run({ action: "look" }, ctx);
  assert.doesNotMatch(r2.output, /Minimized/);
});

test("computer, live feed: a screenshot minimizes the Daebot window first and shows what is behind it", async () => {
  const f = liveFeed();
  f.ingest(frame("up", true));
  const sh = shell(f, { up: "up", down: "behind" });
  const scripts: string[] = [];
  try {
    const r = await createComputerTool(async (s) => { scripts.push(s); return { code: 0, stdout: "", stderr: "" }; }, f, { settleMs: 5, desktopPid: 4242 }).run({ action: "screenshot" }, ctx);
    assert.equal(scripts.length, 0, "live: the shell minimizes, no PowerShell");
    assert.deepEqual(r.images, [b64("behind")]);
    assert.match(r.output, /Minimized the Daebot window first/);
  } finally { sh.stop(); }
});

test("computer, feed off: the script minimizes the Daebot window (by the desktop app's pid) before the actions, and says so", async () => {
  const f = new ScreenFeed();
  const scripts: string[] = [];
  const out = "DAEBOT_OWN_HIDDEN\nDAEBOT_SHOT 1366 768 2732 1536 10 20\nT0xE\nDAEBOT_DONE\n";
  const tool = createComputerTool(async (s) => { scripts.push(s); return { code: 0, stdout: out, stderr: "" }; }, f, { settleMs: 5, desktopPid: 4242 });
  const r = await tool.run({ action: "click", x: 5, y: 6 }, ctx);
  assert.equal(r.ok, true);
  assert.ok(scripts[0].startsWith(ownWindowPrelude(4242)), "the prelude runs first");
  assert.match(scripts[0], /Get-Process -Id 4242/);
  assert.match(scripts[0], /ShowWindowAsync\(\$__own, 6\)/);
  assert.match(r.output, /^Minimized the Daebot window first/);
  // a wait-only call never touches the window; outside the desktop app there is no prelude
  scripts.length = 0;
  await tool.run({ action: "wait", seconds: 1 }, ctx);
  assert.doesNotMatch(scripts[0] ?? "", /DaebotOwn/);
  scripts.length = 0;
  await createComputerTool(async (s) => { scripts.push(s); return { code: 0, stdout: out.replace("DAEBOT_OWN_HIDDEN\n", ""), stderr: "" }; }, f, { settleMs: 5, desktopPid: undefined }).run({ action: "click", x: 5, y: 6 }, ctx);
  assert.doesNotMatch(scripts[0], /DaebotOwn/);
});

test("desktopPid: read from DAEBOT_DESKTOP_PID, only a positive integer counts", () => {
  assert.equal(desktopPid({ DAEBOT_DESKTOP_PID: "1234" }), 1234);
  assert.equal(desktopPid({}), undefined);
  assert.equal(desktopPid({ DAEBOT_DESKTOP_PID: "abc" }), undefined);
  assert.equal(desktopPid({ DAEBOT_DESKTOP_PID: "-3" }), undefined);
});

test("prompt: 'Using the computer' tells Daebot to move its own window and to batch, whenever it has computer", () => {
  const lines = routingSection(["bash", "computer", "screen"], { screenWatching: true }).join("\n");
  assert.match(lines, /## Using the computer/);
  assert.match(lines, /Never tell the user you cannot see because your own window is in the way/);
  assert.match(lines, /minimize button \(the dash\) in the Daebot window's title bar/);
  assert.match(lines, /wait_for_change/);
  assert.doesNotMatch(routingSection(["bash", "web_fetch"]).join("\n"), /Using the computer/);
  assert.match(computerSkillLines(false).join("\n"), /one wait step/);
});

test("gateway /screen/frame: stores own=1/0 and answers 200 {hide:true} exactly once after a tool asked", async () => {
  const feed = new ScreenFeed();
  const home = mkdtempSync(join(tmpdir(), "mc-own-"));
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir, tokenPath: join(home, "tok"), screenFeed: feed });
  const q = (own: string) => new URLSearchParams({ w: "1366", h: "768", sw: "2732", sh: "1536", cx: "1", cy: "2", sig: Buffer.from(sig()).toString("base64url"), own }).toString();
  const post = (path: string, headers: Record<string, string>) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(gw.url); const body = jpeg("f");
    const req = request({ host: u.hostname, port: u.port, method: "POST", path, headers: { "content-type": "image/jpeg", "content-length": String(body.length), ...headers } }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c: string) => (b += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", reject); req.end(body);
  });
  try {
    const a = auth(gw.token);
    await http(gw.url, "PUT", "/screen/state", { headers: a, body: { watching: true, permission: "granted" } });
    assert.equal((await post(`/screen/frame?${q("1")}`, a)).status, 204);
    assert.equal(feed.latest()!.ownVisible, true);
    feed.requestHide();
    const r = await post(`/screen/frame?${q("1")}`, a);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { hide: true });
    assert.equal((await post(`/screen/frame?${q("0")}`, a)).status, 204, "handed out once");
    assert.equal(feed.latest()!.ownVisible, false);
  } finally { await gw.close(); }
});
