import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScript, computerToolSupported, createComputerTool, escapeSendKeys, parseShot, toSendKeys } from "../../src/tools/computer.ts";
import { shellCommand, shellEnv } from "../../src/tools/bash.ts";
import { toWireMessages } from "../../src/provider/openrouter.ts";
import type { Message } from "../../src/types.ts";

const ctx = { cwd: "/", sessionId: "s" };
const SHOT_OUT = "noise\r\nDAEBOT_SHOT 1366 768 2732 1536 10 20\r\nQUJD\r\n";

test("computer: SendKeys escaping and key combos", () => {
  assert.equal(escapeSendKeys("a+b (x) {y} 50%~^[z]"), "a{+}b {(}x{)} {{}y{}} 50{%}{~}{^}{[}z{]}");
  assert.equal(escapeSendKeys("line1\nline2"), "line1{ENTER}line2");
  assert.deepEqual(toSendKeys("ctrl+s"), { keys: "^s" });
  assert.deepEqual(toSendKeys("Ctrl+Shift+S"), { keys: "^+s" });
  assert.deepEqual(toSendKeys("alt+f4"), { keys: "%{F4}" });
  assert.deepEqual(toSendKeys("enter"), { keys: "{ENTER}" });
  assert.deepEqual(toSendKeys("+"), { error: "key: empty key" });
  assert.deepEqual(toSendKeys("win+r"), { win: "r" });
  assert.deepEqual(toSendKeys("win"), { win: "" });
  assert.ok("error" in toSendKeys("hyper+x"));
  assert.ok("error" in toSendKeys("ctrl+banana"));
});

test("computer: scripts validate arguments and always end with a screenshot", () => {
  assert.ok("error" in buildScript("click", {}));
  assert.ok("error" in buildScript("click", { x: -1, y: 5 }));
  assert.ok("error" in buildScript("drag", { x: 1, y: 1 }));
  assert.ok("error" in buildScript("type", { text: "" }));
  assert.ok("error" in buildScript("scroll", { amount: 0 }));
  const click = buildScript("click", { x: 100, y: "200" });
  assert.ok("script" in click && click.script.includes("P 100 200") && click.script.includes("Btn 2 4") && click.script.includes("DAEBOT_SHOT"));
  const right = buildScript("right_click", { x: 1, y: 2 });
  assert.ok("script" in right && right.script.includes("Btn 8 16"));
  const dbl = buildScript("double_click", { x: 1, y: 2 });
  assert.ok("script" in dbl && dbl.script.split("Btn 2 4").length === 3);
  // A quote in typed text cannot break out of the PowerShell string.
  const typed = buildScript("type", { text: "O'Brien; Remove-Item x" });
  assert.ok("script" in typed && typed.script.includes("SendWait('O''Brien; Remove-Item x')"));
  const win = buildScript("key", { keys: "win+r" });
  assert.ok("script" in win && win.script.includes("keybd_event(0x5B") && win.script.includes("keybd_event(82"));
  const wait = buildScript("wait", { seconds: 99 });
  assert.ok("script" in wait && wait.script.includes("Start-Sleep -Milliseconds 10000"));
});

test("computer: parses the screenshot block and returns it as an image", async () => {
  assert.deepEqual(parseShot(SHOT_OUT), { width: 1366, height: 768, screenWidth: 2732, screenHeight: 1536, cursorX: 10, cursorY: 20, jpegBase64: "QUJD" });
  assert.equal(parseShot("nothing here"), undefined);
  assert.equal(parseShot("DAEBOT_SHOT 1 2 3 4 5 6\nnot base64!"), undefined);
  let seen = "";
  const tool = createComputerTool(async (script) => { seen = script; return { code: 0, stdout: SHOT_OUT, stderr: "" }; });
  const r = await tool.run({ action: "click", x: 5, y: 6 }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.images, ["data:image/jpeg;base64,QUJD"]);
  assert.match(r.output, /Did click at 5,6\. Screenshot 1366x768 \(screen 2732x1536\)/);
  assert.ok(seen.includes("P 5 6"));
  const bad = await createComputerTool(async () => ({ code: 1, stdout: "", stderr: "Access is denied." })).run({ action: "screenshot" }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.output, /Access is denied/);
  assert.equal((await tool.run({ action: "fly" }, ctx)).ok, false);
});

test("computer: offered on Windows only, and can be switched off", () => {
  assert.equal(computerToolSupported("win32", {}), true);
  assert.equal(computerToolSupported("darwin", {}), false);
  assert.equal(computerToolSupported("linux", {}), false);
  assert.equal(computerToolSupported("win32", { DAEBOT_COMPUTER_USE: "0" }), false);
});

test("bash on Windows: falls back to PowerShell and keeps the Windows system env", () => {
  assert.deepEqual(shellCommand("ls", "darwin").file, "bash");
  assert.equal(shellCommand("dir", "win32", () => false).file, "powershell.exe");
  assert.equal(shellCommand("ls", "win32", () => true).file, "bash");
  const env = shellEnv({ PATH: "p", SystemRoot: "C:\\Windows", OPENROUTER_API_KEY: "x", MIND_API_KEY: "y" }, "win32");
  assert.deepEqual(env, { PATH: "p", SystemRoot: "C:\\Windows" });
  assert.deepEqual(shellEnv({ PATH: "p", SystemRoot: "C:\\Windows" }, "darwin"), { PATH: "p" });
});

test("wire: screenshots follow the tool results as a user image turn; only the newest two are sent", () => {
  const img = (n: number) => `data:image/jpeg;base64,${n}`;
  const msgs: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
  ];
  for (let i = 1; i <= 3; i++) {
    msgs.push({ role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "computer", args: {} }, { id: `d${i}`, name: "read_file", args: {} }] });
    msgs.push({ role: "tool", toolCallId: `c${i}`, name: "computer", content: "shot", images: [img(i)] });
    msgs.push({ role: "tool", toolCallId: `d${i}`, name: "read_file", content: "file" });
  }
  const wire = toWireMessages(msgs) as any[];
  const imageTurns = wire.filter((m) => Array.isArray(m.content));
  assert.equal(imageTurns.length, 2);
  assert.deepEqual(imageTurns.map((m) => m.content[1].image_url.url), [img(2), img(3)]);
  // Every tool result stays directly after its assistant turn; the image turn comes after both tool results.
  const i3 = wire.findIndex((m) => m.tool_call_id === "c3");
  assert.equal(wire[i3 + 1].tool_call_id, "d3");
  assert.ok(Array.isArray(wire[i3 + 2].content));
  assert.equal(wire[i3 + 2].role, "user");
});
