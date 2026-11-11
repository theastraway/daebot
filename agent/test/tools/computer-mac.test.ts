// The macOS backend of the `computer` tool. Every test uses a fake executor: nothing here clicks, types or captures the real screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { computerToolSupported, createComputerTool } from "../../src/tools/computer.ts";
import { isMacTerminalApp, keyArgs, macScreenshot, mouseJxa, parseMacState, planAction, toMacKey, typeArgs } from "../../src/tools/computer-mac.ts";
import type { MacExec } from "../../src/tools/computer-mac.ts";

const ctx = { cwd: "/", sessionId: "s" };
// 1440x900 points, Retina 2x -> the capture is 2880x1800; the screenshot is 1366 wide, so one screenshot pixel is 1440/1366 points.
const STATE = (rec = 1, ax = 1, front = "Safari") => `1440 900 100 200 ${rec} ${ax}`;

interface Call { cmd: string; args: string[] }
function fakeMac(o: { front?: string; ax?: number; rec?: number; failShot?: boolean } = {}): { exec: MacExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: MacExec = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "screencapture") { if (o.failShot) return { code: 1, stdout: "", stderr: "could not create image from display" }; writeFileSync(args[args.length - 1], Buffer.from("PNG")); return { code: 0, stdout: "", stderr: "" }; }
    if (cmd === "sips" && args[0] === "-g") return { code: 0, stdout: "  pixelWidth: 2880\n  pixelHeight: 1800\n", stderr: "" };
    if (cmd === "sips") { writeFileSync(args[args.length - 1], Buffer.from("JPEGDATA")); return { code: 0, stdout: "", stderr: "" }; }
    if (cmd === "osascript") {
      const src = args.join(" ");
      if (src.includes("backingScaleFactor")) return { code: 0, stdout: "2\n", stderr: "" };
      if (src.includes("NSScreen.screens.objectAtIndex(0).frame")) return { code: 0, stdout: STATE(o.rec ?? 1, o.ax ?? 1) + "\n", stderr: "" };
      if (src.includes("whose frontmost is true")) return { code: 0, stdout: `${o.front ?? "Safari"}\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}
const inputCalls = (calls: Call[]) => calls.filter((c) => c.cmd === "osascript" && !c.args.join(" ").includes("frame.size") && !c.args.join(" ").includes("frontmost") && !c.args.join(" ").includes("backingScale") && !c.args.join(" ").includes("visible"));

test("computerToolSupported: Windows and Mac, never Linux, and the env switch turns it off", () => {
  assert.equal(computerToolSupported("darwin", {}), true);
  assert.equal(computerToolSupported("win32", {}), true);
  assert.equal(computerToolSupported("linux", {}), false);
  assert.equal(computerToolSupported("darwin", { DAEBOT_COMPUTER_USE: "0" }), false);
});

test("toMacKey: names, modifiers and one character", () => {
  assert.deepEqual(toMacKey("enter"), { code: 36, mods: [] });
  assert.deepEqual(toMacKey("Cmd+Shift+S"), { char: "s", mods: ["command down", "shift down"] });
  assert.deepEqual(toMacKey("ctrl+alt+delete"), { code: 117, mods: ["control down", "option down"] });
  assert.deepEqual(toMacKey("backspace"), { code: 51, mods: [] });
  assert.ok("error" in toMacKey("hyper+x"));
  assert.ok("error" in toMacKey("cmd+banana"));
  assert.ok("error" in toMacKey("+"));
});

test("keyArgs and typeArgs: the text is an argv item, never part of the script", () => {
  const evil = `"; do shell script "rm -rf ~" --`;
  const t = typeArgs(`${evil}\nsecond`);
  const dash = t.indexOf("--");
  assert.deepEqual(t.slice(dash + 1), [evil, "second"]);
  assert.equal(t.slice(0, dash).join(" ").includes("rm -rf"), false);
  const k = keyArgs({ char: evil[0], mods: ["command down"] });
  assert.equal(k.slice(0, k.indexOf("--")).join(" ").includes("rm"), false);
  assert.match(keyArgs({ code: 36, mods: [] }).join(" "), /key code 36$/);
  assert.match(keyArgs({ code: 36, mods: ["command down"] }).join(" "), /key code 36 using \{command down\}/);
});

test("planAction scales screenshot pixels to points and validates arguments", () => {
  const f = 1440 / 1366;
  const click = planAction("click", { x: 683, y: 100 }, f);
  assert.ok(!("error" in click));
  const script = (click as any).calls[0].args[3] as string;
  assert.match(script, /ev\(5,720,105,0,1\)/); // 683 * 1.054 = 720, 100 * 1.054 = 105
  assert.match(script, /ev\(1,720,105,0,1\)/);
  assert.match(script, /ev\(2,720,105,0,1\)/);
  assert.match(mouseJxa({ op: "click", x: 1, y: 2, count: 2 }), /ev\(1,1,2,0,2\)/);
  assert.match(mouseJxa({ op: "click", x: 1, y: 2, right: true }), /ev\(3,1,2,1,1\)/);
  assert.match(mouseJxa({ op: "scroll", amount: -3 }), /CGEventCreateScrollWheelEvent2\(null,1,1,-3,0,0\)/);
  for (const bad of [planAction("click", {}, 1), planAction("click", { x: -1, y: 5 }, 1), planAction("drag", { x: 1, y: 1 }, 1), planAction("type", { text: "" }, 1), planAction("scroll", { amount: 0 }, 1), planAction("key", {}, 1)]) assert.ok("error" in bad);
  assert.deepEqual((planAction("wait", { seconds: 99 }, 1) as any).waitMs, 10_000);
});

test("parseMacState and isMacTerminalApp", () => {
  assert.deepEqual(parseMacState("1440 900 10.5 20 1 0"), { pointsW: 1440, pointsH: 900, cursorX: 10.5, cursorY: 20, screenRecording: true, accessibility: false });
  assert.equal(parseMacState("nonsense"), undefined);
  assert.equal(isMacTerminalApp("iTerm2"), true);
  assert.equal(isMacTerminalApp("Terminal"), true);
  assert.equal(isMacTerminalApp("Safari"), false);
});

test("macScreenshot: capture, resize, state; a failed capture explains the Screen Recording permission", async () => {
  const { exec, calls } = fakeMac();
  const r = await macScreenshot(exec);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual([r.shot.width, r.shot.height, r.shot.screenWidth, r.shot.screenHeight], [1366, 854, 2880, 1800]);
  assert.equal(r.shot.jpegBase64, Buffer.from("JPEGDATA").toString("base64"));
  assert.equal(r.shot.cursorX, Math.round(100 * (1366 / 1440)));
  const cap = calls.find((c) => c.cmd === "screencapture")!;
  assert.deepEqual(cap.args.slice(0, 4), ["-x", "-m", "-t", "png"]);
  const bad = await macScreenshot(fakeMac({ failShot: true }).exec);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /Screen Recording/);
});

test("the tool on darwin: a screenshot returns the image and takes no input action", async () => {
  const { exec, calls } = fakeMac();
  const tool = createComputerTool(undefined, undefined, { platform: "darwin", macExec: exec, desktopPid: undefined });
  const r = await tool.run({ action: "screenshot" }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.images?.[0], `data:image/jpeg;base64,${Buffer.from("JPEGDATA").toString("base64")}`);
  assert.match(r.output, /Screenshot taken\. Screenshot 1366x854 \(screen 2880x1800\)/);
  assert.equal(inputCalls(calls).length, 0);
  assert.equal(tool.class, "write");
});

test("the tool on darwin: a batch clicks, types and keys through osascript, then screenshots", async () => {
  const { exec, calls } = fakeMac();
  const tool = createComputerTool(undefined, undefined, { platform: "darwin", macExec: exec, desktopPid: undefined, settleMs: 0 });
  const r = await tool.run({ actions: [{ action: "click", x: 10, y: 20 }, { action: "type", text: "hello" }, { action: "key", keys: "cmd+s" }] }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /Did 3 actions \(click at 10,20; type 5 chars; key cmd\+s\)/);
  const ins = inputCalls(calls);
  assert.equal(ins.length, 3);
  assert.ok(ins[0].args[3].includes("CGEventCreateMouseEvent"));
  assert.equal(ins[1].args.at(-1), "hello");
  assert.match(ins[2].args.join(" "), /keystroke \(item 1 of argv\) using \{command down\}/);
  assert.equal(r.images?.length, 1);
});

test("the tool on darwin: dry run describes input and executes none of it, but still takes the screenshot", async () => {
  const { exec, calls } = fakeMac();
  const tool = createComputerTool(undefined, undefined, { platform: "darwin", macExec: exec, desktopPid: undefined });
  const r = await tool.run({ dry_run: true, actions: [{ action: "click", x: 5, y: 6 }, { action: "type", text: "secret" }] }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /DRY RUN \(not executed\) click at 5,6/);
  assert.match(r.output, /Dry run: nothing was clicked or typed/);
  assert.equal(inputCalls(calls).length, 0);
  assert.equal(r.images?.length, 1);
  assert.equal(r.meta?.dryRun, true);
  // the env switch does the same without the argument
  const env = createComputerTool(undefined, undefined, { platform: "darwin", macExec: fakeMac().exec, desktopPid: undefined, env: { DAEBOT_COMPUTER_DRY_RUN: "1" } });
  assert.equal((await env.run({ action: "click", x: 1, y: 1 }, ctx)).meta?.dryRun, true);
});

test("the tool on darwin: nothing is clicked or typed while a terminal is frontmost", async () => {
  const { exec, calls } = fakeMac({ front: "iTerm2" });
  const tool = createComputerTool(undefined, undefined, { platform: "darwin", macExec: exec, desktopPid: undefined });
  const r = await tool.run({ action: "type", text: "hello" }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /terminal, console or Run box \(iTerm2\)/);
  assert.equal(inputCalls(calls).length, 0);
  // a screenshot of a terminal is only a read, so it is still allowed
  assert.equal((await tool.run({ action: "screenshot" }, ctx)).ok, true);
});

test("the tool on darwin: no Accessibility permission stops input with the fix, URL typing is still refused by the background guard", async () => {
  const noAx = createComputerTool(undefined, undefined, { platform: "darwin", macExec: fakeMac({ ax: 0 }).exec, desktopPid: undefined });
  const r = await noAx.run({ action: "click", x: 1, y: 1 }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /Accessibility/);
  const guard = await createComputerTool(undefined, undefined, { platform: "darwin", macExec: fakeMac().exec, desktopPid: undefined }).run({ action: "type", text: "https://example.com/page" }, ctx);
  assert.equal(guard.ok, false);
  assert.match(guard.output, /web_fetch/);
});

test("the tool on darwin: warns when Screen Recording is missing, hides the desktop app by pid only when told to", async () => {
  const warned = await createComputerTool(undefined, undefined, { platform: "darwin", macExec: fakeMac({ rec: 0 }).exec, desktopPid: undefined }).run({ action: "screenshot" }, ctx);
  assert.match(warned.output, /no Screen Recording permission/);
  const { exec, calls } = fakeMac();
  await createComputerTool(undefined, undefined, { platform: "darwin", macExec: exec, desktopPid: 4242, settleMs: 0 }).run({ action: "click", x: 1, y: 1 }, ctx);
  assert.ok(calls.some((c) => c.args.join(" ").includes("unix id is 4242")));
  const { exec: e2, calls: c2 } = fakeMac();
  await createComputerTool(undefined, undefined, { platform: "darwin", macExec: e2, desktopPid: 4242 }).run({ dry_run: true, action: "click", x: 1, y: 1 }, ctx);
  assert.equal(c2.some((c) => c.args.join(" ").includes("unix id is")), false);
});
