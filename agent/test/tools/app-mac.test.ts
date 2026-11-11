// The macOS backend of the `app` tool. Every test uses a fake executor: nothing here talks to System Events, clicks, types or captures a screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createAppTool, appToolSupported } from "../../src/tools/app.ts";
import { AX_ROLES, MAC_APP_JXA, buildMacAppScript, macAppArgs, parseMacAppOutput } from "../../src/tools/app-mac.ts";
import type { MacExec } from "../../src/tools/computer-mac.ts";

const ctx = { cwd: "/", sessionId: "s" } as never;
interface Call { cmd: string; args: string[] }
function fake(stdout: string, o: { code?: number; stderr?: string } = {}): { exec: MacExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: MacExec = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "screencapture") { writeFileSync(args[args.length - 1], Buffer.from("PNG")); return { code: 0, stdout: "", stderr: "" }; }
    if (cmd === "sips" && args[0] === "-g") return { code: 0, stdout: "  pixelWidth: 800\n  pixelHeight: 600\n", stderr: "" };
    if (cmd === "sips") { writeFileSync(args[args.length - 1], Buffer.from("JPEGDATA")); return { code: 0, stdout: "", stderr: "" }; }
    return { code: o.code ?? 0, stdout, stderr: o.stderr ?? "" };
  };
  return { exec, calls };
}
const job = (calls: Call[]) => JSON.parse(calls[0].args[calls[0].args.length - 1]);

test("the interpreter is valid JavaScript and uses AX actions only: no mouse, no keys, no activation", () => {
  const script = buildMacAppScript();
  // syntax check without running anything: the interpreter body is wrapped and only parsed.
  assert.doesNotThrow(() => new Function(script.replace(/^ObjC\.import.*$/gm, "")));
  assert.doesNotMatch(script, /keystroke|key code|click at|\.click\(|CGEventCreate|activate\(|SetCursor|mouse/i);
  assert.match(script, /AXPress/);
  assert.match(script, /AXShowMenu/);
  assert.match(script, /AXCancel/);
  assert.match(script, /AXCloseButton/);
  assert.doesNotMatch(script, /%ROLES%/);
});

test("osascript compiles the interpreter (compile only, nothing runs)", { skip: process.platform !== "darwin" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "app-mac-compile-"));
  try {
    const r = spawnSync("osacompile", ["-l", "JavaScript", "-e", buildMacAppScript(), "-o", join(dir, "x.scpt")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("macAppArgs: the steps are ONE argv item of JSON data, never code", () => {
  const evil = `"; do shell script "rm -rf ~" //`;
  const a = macAppArgs([{ action: "set_value", window: "Notes", name: "Body", value: evil }], { dry: true });
  assert.deepEqual(a.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.equal(a[4], "--");
  const j = JSON.parse(a[5]);
  assert.equal(j.steps[0].value, evil);
  assert.equal(j.dry, true);
  assert.equal(a[3].includes("rm -rf"), false);
  assert.ok(j.terminals.includes("terminal") && j.terminals.includes("iterm2"));
});

test("role table: Windows control names map to AX roles", () => {
  assert.deepEqual(AX_ROLES.button, ["AXButton"]);
  assert.ok(AX_ROLES.edit.includes("AXTextField") && AX_ROLES.edit.includes("AXTextArea"));
  assert.ok(AX_ROLES.menuitem.includes("AXMenuItem"));
  assert.ok(MAC_APP_JXA.includes("%ROLES%"));
});

test("parseMacAppOutput: osascript prints console.log on stderr; windowid and blocked lines are lifted out", () => {
  const p = parseMacAppOutput("", '1. list_windows ok\n   Safari "Start" pid:12\nDAEBOT_WINID 4411\nDAEBOT_DONE\n');
  assert.equal(p.done, true);
  assert.equal(p.windowId, 4411);
  assert.match(p.text, /Safari "Start" pid:12/);
  assert.equal(parseMacAppOutput("DAEBOT_BLOCKED Terminal | zsh\nDAEBOT_DONE").blocked, "Terminal | zsh");
});

test("mac app tool: list_windows is class read and runs one osascript call", async () => {
  const f = fake('1. list_windows ok\n   Finder "Downloads" pid:491\nDAEBOT_DONE\n');
  const t = createAppTool(undefined, { platform: "darwin", macExec: f.exec });
  assert.equal(t.classFor!({ action: "list_windows" }), "read");
  const r = await t.run({ action: "list_windows" }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /Finder "Downloads" pid:491/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].cmd, "osascript");
  assert.equal(job(f.calls).dry, false);
  assert.deepEqual((r.meta as any).platform, "darwin");
});

test("mac app tool: a changing step is class write, dry_run reaches the script, and the reply says nothing was done", async () => {
  const f = fake('1. invoke ok: DRY RUN: would press [AXButton] "Save"\nDAEBOT_DONE\n');
  const t = createAppTool(undefined, { platform: "darwin", macExec: f.exec });
  assert.equal(t.classFor!({ action: "invoke", window: "Notes", name: "Save" }), "write");
  const r = await t.run({ action: "invoke", window: "Notes", name: "Save", dry_run: true }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /DRY RUN/);
  assert.equal(job(f.calls).dry, true);
  assert.equal(job(f.calls).steps[0].action, "invoke");
  assert.equal(f.calls.every((c) => c.cmd === "osascript"), true);
});

test("mac app tool: DAEBOT_APP_DRY_RUN=1 makes every call a dry run", async () => {
  const f = fake("1. toggle ok: DRY RUN: would toggle\nDAEBOT_DONE\n");
  const t = createAppTool(undefined, { platform: "darwin", macExec: f.exec, env: { DAEBOT_APP_DRY_RUN: "1" } });
  await t.run({ action: "toggle", window: "Settings", name: "Dark mode", state: "on" }, ctx);
  assert.equal(job(f.calls).dry, true);
});

test("mac app tool: a failed step is reported and not ok; a terminal is refused with the bash hint", async () => {
  const bad = await createAppTool(undefined, { platform: "darwin", macExec: fake('1. invoke FAILED: no control matches "Nope"\nDAEBOT_DONE\n').exec }).run({ action: "invoke", window: "N", name: "Nope" }, ctx);
  assert.equal(bad.ok, false);
  const blocked = await createAppTool(undefined, { platform: "darwin", macExec: fake("DAEBOT_BLOCKED Terminal | zsh\nDAEBOT_DONE\n").exec }).run({ action: "get_text", window: "Terminal", type: "Document" }, ctx);
  assert.equal(blocked.ok, false);
  assert.match(blocked.output, /terminal, console or Run box/);
  assert.match(blocked.output, /bash/);
  let ran = 0;
  const refused = await createAppTool(undefined, { platform: "darwin", macExec: async () => { ran++; return { code: 0, stdout: "", stderr: "" }; } }).run({ action: "launch", app: "iTerm2" }, ctx);
  assert.equal(refused.ok, false);
  assert.equal(ran, 0);
  const refused2 = await createAppTool(undefined, { platform: "darwin", macExec: async () => { ran++; return { code: 0, stdout: "", stderr: "" }; } }).run({ action: "launch", app: "/System/Applications/Utilities/Terminal.app" }, ctx);
  assert.equal(refused2.ok, false);
  assert.equal(ran, 0);
});

test("mac app tool: missing Accessibility permission gets the fix in the message", async () => {
  const t = createAppTool(undefined, { platform: "darwin", macExec: fake("", { code: 1, stderr: "execution error: osascript is not allowed assistive access. (-25211)" }).exec });
  const r = await t.run({ action: "list_windows" }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /Accessibility/);
});

test("mac app tool: screenshot:true shoots the window by id and returns a jpeg", async () => {
  const f = fake('1. invoke ok: pressed\nDAEBOT_WINID 777\nDAEBOT_DONE\n');
  const r = await createAppTool(undefined, { platform: "darwin", macExec: f.exec }).run({ action: "invoke", window: "Notes", name: "Save", screenshot: true }, ctx);
  assert.equal(r.ok, true);
  assert.equal(job(f.calls).shot, true);
  assert.equal(job(f.calls).shotWindow, "Notes");
  const cap = f.calls.find((c) => c.cmd === "screencapture")!;
  assert.deepEqual(cap.args.slice(0, 4), ["-x", "-o", "-l", "777"]);
  assert.match(r.images![0], /^data:image\/jpeg;base64,/);
});

test("platform switch: darwin offers app, an injected PowerShell runner still means Windows", async () => {
  assert.equal(appToolSupported("darwin", {}), true);
  let sawScript = "";
  const win = createAppTool(async (s) => { sawScript = s; return { code: 0, stdout: "1. list_windows ok\nDAEBOT_DONE\n", stderr: "" }; });
  await win.run({ action: "list_windows" }, ctx);
  assert.match(sawScript, /UIAutomationClient/);
});
