import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundGuard, routingSection } from "../../src/routing.ts";
import { composeSystemPrompt } from "../../src/runtime.ts";
import { createComputerTool } from "../../src/tools/computer.ts";
import { createBuiltinTools } from "../../src/tools/index.ts";
import { ROUTING_SCENARIOS } from "../../src/eval/routing/scenarios.ts";
import { desktopTools, firstChoice, passes, promptFor } from "../../src/eval/routing/harness.ts";
import { ScriptedProvider } from "../../src/eval/provider.ts";

const ctx = { cwd: ".", sessionId: "s" } as never;

test("prompt: desktop session gets the background-first section with computer last", () => {
  const p = promptFor(desktopTools());
  assert.match(p, /## Work in the background first/);
  assert.ok(p.indexOf("web_fetch for anything") < p.indexOf("computer, LAST"));
  assert.ok(p.indexOf("process for anything") < p.indexOf("computer, LAST"));
  assert.match(p, /say in one line why no background tool can do this/);
});

test("prompt: hosted-style tool list (no shell, no screen) gets no computer line", () => {
  const r = routingSection(["web_fetch", "mind_query", "bot_talk"]).join("\n");
  assert.match(r, /web_fetch/);
  assert.doesNotMatch(r, /computer/);
  assert.deepEqual(routingSection(["task_board"]), []);
});

test("composeSystemPrompt without toolNames is unchanged (no section)", () => {
  assert.doesNotMatch(composeSystemPrompt({ bootContext: "", surface: "web", cwd: "/" }), /Work in the background first/);
});

test("tool descriptions say the screen is the last resort and point at the background tools", () => {
  const by = Object.fromEntries(createBuiltinTools({ computer: true }).map((t) => [t.spec.name, t.spec.description]));
  assert.match(by.computer, /LAST RESORT/);
  assert.match(by.computer, /takes over the user's screen/i);
  assert.match(by.computer, /one line why/);
  assert.match(by.computer, /web_fetch/);
  assert.match(by.process, /instead of a foreground bash or a screen session/);
  assert.match(by.web_fetch, /background/);
  assert.match(by.bash, /never type them into a terminal/);
});

test("guard: typing a URL, a terminal name or a shell line is refused; normal typing and screen_required pass", () => {
  assert.match(backgroundGuard({ action: "type", text: "https://example.com" })!, /web_fetch/);
  assert.match(backgroundGuard({ action: "type", text: "www.example.com" })!, /web_fetch/);
  assert.match(backgroundGuard({ action: "type", text: "powershell" })!, /bash/);
  assert.match(backgroundGuard({ action: "type", text: "npm test --silent" })!, /process/);
  assert.equal(backgroundGuard({ action: "type", text: "Dear Dana, the estimate is attached." }), undefined);
  assert.equal(backgroundGuard({ action: "type", text: "line one\nline two" }), undefined);
  assert.equal(backgroundGuard({ action: "click", x: 1, y: 2 }), undefined);
  assert.equal(backgroundGuard({ action: "type", text: "https://example.com", screen_required: true }), undefined);
});

test("guard: the computer tool returns the error and never runs a script", async () => {
  let ran = 0;
  const tool = createComputerTool(async () => { ran++; return { code: 0, stdout: "", stderr: "" }; });
  const r = await tool.run({ action: "type", text: "https://example.com/news" }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /Use web_fetch/);
  assert.equal(ran, 0);
});

test("eval set: 20 prompts, ids unique, 2 need the screen, the terminal and app prompts never allow computer", () => {
  assert.equal(ROUTING_SCENARIOS.length, 20);
  assert.equal(new Set(ROUTING_SCENARIOS.map((s) => s.id)).size, 20);
  const by = (id: string) => ROUTING_SCENARIOS.find((s) => s.id.startsWith(id))!;
  assert.deepEqual([by("R16").allow, by("R17").allow, by("R18").allow, by("R19").allow], [["bash", "process"], ["bash"], ["app"], ["app"]]);
  for (const id of ["R16", "R17", "R18", "R19", "R20"]) assert.ok(!by(id).allow.includes("computer"), id);
  assert.equal(ROUTING_SCENARIOS.filter((s) => s.needsScreen).length, 2);
});

test("eval harness: scores the first tool call a provider makes", async () => {
  const p = new ScriptedProvider();
  p.setTurn([{ text: "Checking.", calls: [{ name: "web_fetch", args: { url: "https://example.com" } }, { name: "computer", args: { action: "screenshot" } }] }]);
  const c = await firstChoice(p, "m", ROUTING_SCENARIOS[0].prompt, desktopTools());
  assert.equal(c.tool, "web_fetch");
  assert.ok(passes(ROUTING_SCENARIOS[0], c));
  assert.ok(!passes(ROUTING_SCENARIOS.find((s) => s.needsScreen)!, c));
  p.setTurn([{ text: "just words" }]);
  assert.ok(!passes(ROUTING_SCENARIOS[0], await firstChoice(p, "m", "x", desktopTools())));
});
