import { test } from "node:test";
import assert from "node:assert/strict";
import { appToolSupported, buildAppScript, createAppTool, normalizeSteps, parseAppOutput } from "../../src/tools/app.ts";
import { buildBatchScript, buildScript, createComputerTool } from "../../src/tools/computer.ts";
import { CONSOLE_CHECK_PS } from "../../src/tools/ps.ts";
import { CONSOLE_PROCESSES, backgroundGuard, isConsoleWindow, isTerminalProgram, routingSection, terminalGuard } from "../../src/routing.ts";
import { createBuiltinTools } from "../../src/tools/index.ts";

const ctx = { cwd: ".", sessionId: "s" } as never;
const ALL_ACTIONS = ["list_windows", "tree", "find", "invoke", "set_value", "get_text", "select", "toggle", "expand", "collapse", "launch", "close", "wait"];

function steps(args: Record<string, unknown>) {
  const n = normalizeSteps(args);
  assert.ok(!("error" in n), "error" in n ? n.error : "");
  return n.steps;
}

test("app: every action has a handler in the generated script and its step reaches the JSON data", () => {
  const ok: Array<Record<string, unknown>> = [
    { action: "list_windows" },
    { action: "tree", window: "Notepad", depth: 2 },
    { action: "find", window: "Notepad", name: "Save", type: "Button" },
    { action: "invoke", window: "Notepad", name: "Save" },
    { action: "set_value", window: "Notepad", id: "txtName", value: "Dana" },
    { action: "get_text", window: "Notepad", type: "Document", max: 500 },
    { action: "select", window: "Notepad", name: "Tab 2", add: true },
    { action: "toggle", window: "Notepad", name: "Word wrap", state: "on" },
    { action: "expand", window: "Notepad", name: "File" },
    { action: "collapse", window: "Notepad", name: "File" },
    { action: "launch", app: "notepad.exe", args: "C:\\a.txt" },
    { action: "close", window: "Notepad" },
    { action: "wait", window: "Notepad", name: "Save", timeout_s: 3 },
  ];
  assert.deepEqual(ok.map((o) => o.action), ALL_ACTIONS);
  for (const o of ok) {
    const s = steps(o);
    const script = buildAppScript(s);
    assert.match(script, new RegExp(`'${o.action}' \\{`), `${o.action} handler`);
    assert.ok(script.includes(`"action":"${o.action}"`), `${o.action} in data`);
  }
  const s = buildAppScript(steps({ action: "invoke", window: "Notepad", name: "Save" }));
  // The no-mouse, no-keyboard promise: the script uses UI Automation patterns only.
  assert.doesNotMatch(s, /SendKeys|SendWait|mouse_event|keybd_event|SetCursorPos|SetForegroundWindow|AppActivate/);
  assert.match(s, /InvokePattern/);
  assert.match(s, /ValuePattern/);
  assert.match(s, /TogglePattern/);
  assert.match(s, /SelectionItemPattern/);
  assert.match(s, /ExpandCollapsePattern/);
  assert.match(s, /TextPattern/);
  assert.match(s, /WindowPattern/);
  assert.match(s, /UIAutomationClient/);
});

test("app: a batch runs in one script, carries the window forward, and stops on the first failure by default", () => {
  const n = normalizeSteps({
    steps: [
      { action: "launch", app: "notepad" },
      { action: "wait", window: "Notepad", type: "Document" },
      { action: "set_value", type: "Document", value: "hello" },
      { action: "invoke", name: "Save" },
    ],
  });
  assert.ok(!("error" in n));
  if ("error" in n) return;
  assert.deepEqual(n.steps.map((x) => x.window), [undefined, "Notepad", "Notepad", "Notepad"]);
  const script = buildAppScript(n.steps, { stopOnError: n.stopOnError });
  assert.equal((script.match(/ConvertFrom-Json/g) ?? []).length, 1);
  assert.match(script, /"stopOnError":true/);
  assert.equal(buildAppScript(n.steps, { stopOnError: false }).includes('"stopOnError":false'), true);
  assert.equal(normalizeSteps({ steps: [{ action: "list_windows" }], continue_on_error: true }).hasOwnProperty("stopOnError"), true);
});

test("app: step text can never become code (quotes, here-string end, newlines stay inside the JSON data)", () => {
  const evil = "x'@\nRemove-Item -Recurse C:\\ ; '@\n$(calc)";
  const script = buildAppScript(steps({ action: "set_value", window: "W", name: "Name", value: evil }));
  const open = script.indexOf("$job = ConvertFrom-Json @'\n");
  assert.ok(open > 0);
  const dataStart = open + "$job = ConvertFrom-Json @'\n".length;
  const dataEnd = script.indexOf("\n'@\n", dataStart);
  const data = script.slice(dataStart, dataEnd);
  assert.ok(!data.includes("\n"), "the data is one line, so no line can start with '@");
  assert.equal(JSON.parse(data).steps[0].value, evil);
  // exactly one line-start '@ closes the job here-string (the other here-string is the fixed Add-Type block)
  assert.equal(script.slice(dataEnd).split("\n'@\n").length - 1 >= 1, true);
});

test("app: argument validation gives the model a fix", () => {
  const bad = (a: Record<string, unknown>, re: RegExp) => { const n = normalizeSteps(a); assert.ok("error" in n && re.test(n.error), JSON.stringify(n)); };
  bad({ action: "fly" }, /action must be one of/);
  bad({ action: "invoke", name: "Save" }, /needs window/);
  bad({ action: "invoke", window: "N" }, /needs name, type or id/);
  bad({ action: "set_value", window: "N", name: "x" }, /needs value/);
  bad({ action: "tree" }, /needs window/);
  bad({ action: "find", window: "N", type: "Bad Type;" }, /control type/);
  bad({ action: "tree", window: "N", depth: 99 }, /depth/);
  bad({ action: "wait", window: "N" }, /needs name, type or id/);
  bad({ action: "launch" }, /needs app/);
  bad({ steps: [] }, /empty/);
  bad({ steps: new Array(41).fill({ action: "list_windows" }) }, /at most 40/);
  bad({ steps: [{ action: "list_windows" }, { action: "invoke", window: "N" }] }, /^step 2: /);
});

test("app: terminals, consoles and shells cannot be launched or targeted", () => {
  for (const exe of ["powershell", "powershell.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "cmd", "cmd.exe", "pwsh", "wt", "wt.exe", "conhost.exe", "WindowsTerminal.exe", "bash", "wsl.exe"]) {
    const n = normalizeSteps({ action: "launch", app: exe });
    assert.ok("error" in n && /terminal or shell/.test(n.error) && /bash/.test(n.error), exe);
    assert.equal(isTerminalProgram(exe), true, exe);
  }
  assert.equal(isTerminalProgram("notepad.exe"), false);
  assert.equal(isTerminalProgram("C:\\Program Files\\Xactware\\Xactimate.exe"), false);
  // the generated script re-checks the target window and the launch name (defence in depth)
  const script = buildAppScript(steps({ action: "invoke", window: "x", name: "y" }));
  assert.match(script, /Guard-Window \$w/);
  assert.match(script, /\$ConsoleProcs -contains \$base/);
  assert.match(script, /Block-IfConsole/);
});

test("app: the tool parses compact output, a screenshot, a console refusal and a failure", async () => {
  let seen = "";
  const ok = createAppTool(async (script) => {
    seen = script;
    return { code: 0, stdout: "1. invoke ok: invoked [Button] \"Save\"\r\nDAEBOT_APPSHOT 10 20\r\nQUJD\r\nDAEBOT_DONE\r\n", stderr: "" };
  });
  const r = await ok.run({ action: "invoke", window: "Notepad", name: "Save", screenshot: true }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.output, '1. invoke ok: invoked [Button] "Save"');
  assert.deepEqual(r.images, ["data:image/jpeg;base64,QUJD"]);
  assert.match(seen, /"shot":true/);
  assert.match(seen, /"shotWindow":"Notepad"/);
  const noShot = await createAppTool(async () => ({ code: 0, stdout: "1. list_windows ok\nDAEBOT_DONE\n", stderr: "" })).run({ action: "list_windows" }, ctx);
  assert.equal(noShot.images, undefined);
  const failed = await createAppTool(async () => ({ code: 0, stdout: "1. invoke FAILED: no control matches name \"Nope\"\nDAEBOT_DONE\n", stderr: "" })).run({ action: "invoke", window: "N", name: "Nope" }, ctx);
  assert.equal(failed.ok, false);
  const blocked = await createAppTool(async () => ({ code: 3, stdout: "DAEBOT_BLOCKED powershell | ConsoleWindowClass | Windows PowerShell\n", stderr: "" })).run({ action: "get_text", window: "PowerShell", type: "Document" }, ctx);
  assert.equal(blocked.ok, false);
  assert.match(blocked.output, /terminal, console or Run box/);
  assert.match(blocked.output, /bash/);
  const crash = await createAppTool(async () => ({ code: 1, stdout: "", stderr: "Cannot find type UIAutomationClient" })).run({ action: "list_windows" }, ctx);
  assert.equal(crash.ok, false);
  assert.match(crash.output, /UIAutomationClient/);
  let ran = 0;
  const refused = await createAppTool(async () => { ran++; return { code: 0, stdout: "", stderr: "" }; }).run({ action: "launch", app: "powershell.exe" }, ctx);
  assert.equal(refused.ok, false);
  assert.equal(ran, 0);
  const p = parseAppOutput("a\nDAEBOT_APPSHOT 3 4\nnot base64!\nDAEBOT_DONE");
  assert.equal(p.shot, undefined);
});

test("app: read-only calls are class read, anything that changes an app is write", () => {
  const t = createAppTool();
  assert.equal(t.classFor!({ action: "tree", window: "x" }), "read");
  assert.equal(t.classFor!({ steps: [{ action: "list_windows" }, { action: "get_text" }] }), "read");
  assert.equal(t.classFor!({ steps: [{ action: "tree" }, { action: "invoke" }] }), "write");
  assert.equal(t.classFor!({ action: "launch" }), "write");
});

test("app: offered on Windows only, listed before computer, and switchable off", () => {
  assert.equal(appToolSupported("win32", {}), true);
  assert.equal(appToolSupported("darwin", {}), false);
  assert.equal(appToolSupported("win32", { DAEBOT_APP_CONTROL: "0" }), false);
  const names = createBuiltinTools({ computer: true, app: true }).map((t) => t.spec.name);
  assert.ok(names.indexOf("app") > names.indexOf("process") && names.indexOf("app") < names.indexOf("computer"));
  const by = Object.fromEntries(createBuiltinTools({ computer: true, app: true }).map((t) => [t.spec.name, t.spec.description]));
  assert.match(by.app, /BEFORE the `computer` tool/);
  assert.match(by.app, /BATCH/);
  assert.match(by.computer, /Try the `app` tool first/);
  assert.match(by.computer, /BATCH/);
});

test("routing prompt: order is connector, web_fetch, bash, process, app, computer last; terminal requests mean bash", () => {
  const p = routingSection(["mind_query", "web_fetch", "bash", "process", "app", "computer"]).join("\n");
  const at = (s: string) => p.indexOf(s);
  assert.ok(at("A connector, MCP server") < at("web_fetch for anything") && at("web_fetch for anything") < at("bash, read_file") && at("bash, read_file") < at("process for anything") && at("process for anything") < at("app (background UI Automation)") && at("app (background UI Automation)") < at("computer, LAST"));
  assert.match(p, /Open PowerShell/);
  assert.match(p, /Never open, focus, click into or type into a terminal/);
  assert.match(p, /app cannot reach it/);
  assert.match(p, /actions:\[\.\.\.\]/);
  assert.doesNotMatch(routingSection(["bash", "process"]).join("\n"), /app \(background/);
});

// ---- the terminal ban on `computer` ----

test("terminal guard: refused even with screen_required:true", () => {
  const refusals: Array<Record<string, unknown>> = [
    { action: "type", text: "powershell" },
    { action: "type", text: "PowerShell" },
    { action: "type", text: "cmd" },
    { action: "type", text: "cmd.exe" },
    { action: "type", text: "pwsh" },
    { action: "type", text: "wt" },
    { action: "type", text: "Windows Terminal" },
    { action: "type", text: "windows powershell" },
    { action: "type", text: "powershell -NoProfile -Command Get-Process" },
    { action: "type", text: "cmd /c dir" },
    { action: "type", text: "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5" },
    { action: "type", text: "Start-Process notepad" },
    { action: "type", text: "Get-PSDrive C\nGet-Volume" },
    { action: "key", keys: "win+r" },
    { action: "key", keys: "Win+R" },
    { action: "key", keys: "win + x" },
  ];
  for (const a of refusals) {
    for (const sr of [false, true]) {
      const args = { ...a, screen_required: sr };
      const msg = terminalGuard(args);
      assert.ok(msg && /bash/.test(msg) && /no override/.test(msg), JSON.stringify(args));
      assert.equal(backgroundGuard(args), msg, JSON.stringify(args));
    }
  }
  // ordinary typing is untouched
  for (const t of ["Dear Dana, the estimate is attached.", "Run the report", "Terminal velocity is 120 mph", "Dana Smith", "1234", "get started"]) assert.equal(backgroundGuard({ action: "type", text: t }), undefined, t);
  assert.equal(backgroundGuard({ action: "key", keys: "ctrl+s" }), undefined);
  assert.equal(backgroundGuard({ action: "key", keys: "win" }), undefined);
});

test("terminal guard: the computer tool refuses single actions and any step of a batch, and never runs a script", async () => {
  let ran = 0;
  const tool = createComputerTool(async () => { ran++; return { code: 0, stdout: "", stderr: "" }; });
  const one = await tool.run({ action: "type", text: "powershell", screen_required: true }, ctx);
  assert.equal(one.ok, false);
  assert.match(one.output, /no override/);
  const winr = await tool.run({ action: "key", keys: "win+r", screen_required: true }, ctx);
  assert.equal(winr.ok, false);
  const batch = await tool.run({ screen_required: true, actions: [{ action: "click", x: 5, y: 5 }, { action: "key", keys: "win" }, { action: "type", text: "powershell" }, { action: "key", keys: "enter" }] }, ctx);
  assert.equal(batch.ok, false);
  assert.match(batch.output, /^step 3: /);
  assert.equal(ran, 0);
});

test("foreground console check: every input action of computer is preceded by it, in single and batch scripts", () => {
  for (const [action, args] of [["type", { text: "hi" }], ["key", { keys: "enter" }], ["key", { keys: "win" }], ["scroll", { amount: -3 }]] as const) {
    const b = buildScript(action, args);
    assert.ok("script" in b);
    if (!("script" in b)) continue;
    const at = (re: RegExp) => b.script.search(re);
    assert.ok(at(/Block-IfForegroundConsole\n/) > at(/function Block-IfForegroundConsole/), action);
    const call = b.script.slice(b.script.indexOf("\n", b.script.lastIndexOf("function Take-Shot") + 600));
    assert.match(call, /Block-IfForegroundConsole/, action);
  }
  for (const action of ["click", "double_click", "right_click", "drag"] as const) {
    const b = buildScript(action, { x: 1, y: 2, to_x: 5, to_y: 6 });
    assert.ok("script" in b && /P 1 2\nBlock-IfConsoleAtCursor\n/.test(b.script), action);
    // the check comes BEFORE any button event
    if ("script" in b) assert.ok(b.script.indexOf("Block-IfConsoleAtCursor\n") < b.script.indexOf("Btn ") || action === "drag", action);
  }
  const move = buildScript("move", { x: 1, y: 2 });
  assert.ok("script" in move && !/\nBlock-IfConsole/.test(move.script.split("function Take-Shot")[1] ?? ""));
  // the check script itself: foreground window, window under the pointer, exit code 3, DAEBOT_BLOCKED marker
  assert.match(CONSOLE_CHECK_PS, /GetForegroundWindow/);
  assert.match(CONSOLE_CHECK_PS, /WindowFromPoint/);
  assert.match(CONSOLE_CHECK_PS, /exit 3/);
  assert.match(CONSOLE_CHECK_PS, /DAEBOT_BLOCKED/);
  assert.match(CONSOLE_CHECK_PS, /'#32770'/);
  for (const p of CONSOLE_PROCESSES) assert.ok(CONSOLE_CHECK_PS.includes(`'${p}'`), p);
});

test("console window decision (the same lists the PowerShell check uses)", () => {
  assert.equal(isConsoleWindow({ process: "powershell", className: "ConsoleWindowClass", title: "Windows PowerShell" }), true);
  assert.equal(isConsoleWindow({ process: "WindowsTerminal", className: "CASCADIA_HOSTING_WINDOW_CLASS", title: "Terminal" }), true);
  assert.equal(isConsoleWindow({ process: "conhost.exe" }), true);
  assert.equal(isConsoleWindow({ process: "cmd" }), true);
  assert.equal(isConsoleWindow({ process: "pwsh", title: "anything" }), true);
  assert.equal(isConsoleWindow({ process: "explorer", className: "#32770", title: "Run" }), true);
  assert.equal(isConsoleWindow({ process: "explorer", className: "CabinetWClass", title: "Downloads" }), false);
  assert.equal(isConsoleWindow({ process: "explorer", className: "#32770", title: "Open" }), false);
  assert.equal(isConsoleWindow({ process: "notepad", className: "Notepad", title: "Untitled - Notepad" }), false);
  assert.equal(isConsoleWindow({ process: "chrome", className: "Chrome_WidgetWin_1", title: "Terminal docs" }), false);
});

test("computer: a console refusal from the script is reported with how far the batch got", async () => {
  const tool = createComputerTool(async () => ({ code: 3, stdout: "DAEBOT_STEP 1\nDAEBOT_STEP 2\nDAEBOT_BLOCKED WindowsTerminal | CASCADIA_HOSTING_WINDOW_CLASS | Terminal\n", stderr: "" }));
  const r = await tool.run({ actions: [{ action: "click", x: 1, y: 2 }, { action: "click", x: 3, y: 4 }, { action: "type", text: "hello" }] }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /WindowsTerminal/);
  assert.match(r.output, /Completed 2 of 3 actions/);
  assert.match(r.output, /bash/);
});

// ---- computer batch mode ----

test("computer batch: many actions in one script, one screenshot at the end, screenshot:false allowed", () => {
  const b = buildBatchScript([
    { action: "click", args: { x: 10, y: 20 }, shot: false },
    { action: "type", args: { text: "Dana" }, shot: false },
    { action: "key", args: { keys: "tab" }, shot: false },
    { action: "click", args: { x: 30, y: 40 }, shot: false },
  ], true);
  assert.ok("script" in b);
  if (!("script" in b)) return;
  assert.equal((b.script.match(/\nTake-Shot \d+/g) ?? []).length, 1, "one screenshot call (plus the function definition)");
  assert.equal((b.script.match(/DAEBOT_STEP \d/g) ?? []).length, 4);
  assert.ok(b.script.indexOf("P 30 40") < b.script.lastIndexOf("Take-Shot"));
  const none = buildBatchScript([{ action: "click", args: { x: 1, y: 2 }, shot: false }, { action: "wait", args: { seconds: 1 }, shot: false }], false);
  assert.ok("script" in none && !/\nTake-Shot \d+/.test(none.script) && none.script.includes("DAEBOT_DONE"));
  const mid = buildBatchScript([{ action: "click", args: { x: 1, y: 2 }, shot: true }, { action: "wait", args: { seconds: 1 }, shot: false }], true);
  assert.ok("script" in mid && (mid.script.match(/\nTake-Shot \d+/g) ?? []).length === 2);
  const err = buildBatchScript([{ action: "click", args: { x: 1, y: 2 }, shot: false }, { action: "click", args: {}, shot: false }], true);
  assert.ok("error" in err && /^step 2: /.test(err.error));
});

test("computer batch: the tool runs the list in ONE script call and returns the last screenshot", async () => {
  let calls = 0;
  let seen = "";
  const SHOT = "DAEBOT_SHOT 1366 768 2732 1536 10 20\nQUJD";
  const tool = createComputerTool(async (script) => { calls++; seen = script; return { code: 0, stdout: `DAEBOT_STEP 1\nDAEBOT_STEP 2\nDAEBOT_STEP 3\n${SHOT}\nDAEBOT_DONE\n`, stderr: "" }; });
  const r = await tool.run({ actions: [{ action: "click", x: 5, y: 6 }, { action: "type", text: "hi" }, { action: "key", keys: "enter" }] }, ctx);
  assert.equal(calls, 1);
  assert.equal(r.ok, true);
  assert.equal(r.images?.length, 1);
  assert.match(r.output, /Did 3 actions \(click at 5,6; type 2 chars; key enter\)\. Screenshot 1366x768/);
  assert.ok(seen.includes("P 5 6") && seen.includes("SendWait('hi')"));
  const noShot = createComputerTool(async () => ({ code: 0, stdout: "DAEBOT_STEP 1\nDAEBOT_DONE\n", stderr: "" }));
  const q = await noShot.run({ actions: [{ action: "click", x: 1, y: 1 }], screenshot: false }, ctx);
  assert.equal(q.ok, true);
  assert.equal(q.images?.length, 0);
  assert.match(q.output, /No screenshot was taken/);
  const single = await noShot.run({ action: "click", x: 1, y: 1, screenshot: false }, ctx);
  assert.equal(single.ok, true);
  assert.equal((await tool.run({ actions: new Array(21).fill({ action: "wait" }) }, ctx)).ok, false);
  assert.equal((await tool.run({ actions: [] }, ctx)).ok, false);
  const partial = await createComputerTool(async () => ({ code: 1, stdout: "DAEBOT_STEP 1\n", stderr: "boom" })).run({ actions: [{ action: "click", x: 1, y: 1 }, { action: "click", x: 2, y: 2 }] }, ctx);
  assert.equal(partial.ok, false);
  assert.match(partial.output, /stopped after 1 of 2 actions: boom/);
});
