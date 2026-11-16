import { test } from "node:test";
import assert from "node:assert/strict";
import { createCoderSafetyGate, gitBypass, PROTECTED_CONFIGS } from "../../src/kernel/coder-safety.ts";
import { redactSecrets } from "../../src/learn/guard.ts";
import type { Tool, TurnState } from "../../src/types.ts";

const tool = (name: string): Tool => ({ spec: { name, description: "", parameters: {} }, class: "write", async run() { return { ok: true, output: "" }; } });
const state = (): TurnState => ({ sessionId: "s", booted: true, turnIndex: 1, userMessage: "", userMessageIndex: 1, calls: [], allCalls: [], confirmations: [], shadow: false });
const call = (name: string, args: Record<string, unknown>) => ({ id: "1", name, args });

test("gitBypass: hook bypasses and force pushes are named; normal git is not", () => {
  assert.match(gitBypass("git commit -m x --no-verify")!, /skips the hooks/);
  assert.match(gitBypass("git commit --no-veri -m x")!, /skips the hooks/);
  assert.match(gitBypass("git commit -an -m x")!, /-n/);
  assert.equal(gitBypass("git commit -m next -a"), undefined, "a message token is not a flag");
  assert.equal(gitBypass("git commit -uno -m x"), undefined, "-uno is untracked-files=no");
  assert.match(gitBypass("npm test && git push --no-verify")!, /skips the hooks/);
  assert.match(gitBypass("git -c core.hooksPath=/dev/null commit -m x")!, /hooksPath/);
  assert.match(gitBypass("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git commit")!, /GIT_CONFIG/);
  assert.match(gitBypass("git push -f origin main")!, /force/);
  assert.equal(gitBypass("git push --force-with-lease origin topic"), undefined);
  assert.equal(gitBypass("git status && git log --oneline -5"), undefined);
  assert.equal(gitBypass("echo --no-verify"), undefined);
});

test("the gate: bypass blocked, secret in an argument blocked, protected config asks once then runs on a granted confirmation", () => {
  const g = createCoderSafetyGate({ exists: (p) => p.endsWith("eslint.config.js") });
  const s = state();
  const v1 = g.preTool!(s, call("bash", { command: "git commit --no-verify -m x" }), tool("bash"));
  assert.equal(v1?.action, "block");
  const v2 = g.preTool!(s, call("write_file", { path: "/p/.env", content: "KEY=sk-or-abcdefghijklmnop1234567890" }), tool("write_file"));
  assert.equal(v2?.action, "block");
  assert.match(v2!.reason, /secret/);
  assert.equal(g.preTool!(s, call("bash", { command: "export K=$OPENROUTER_API_KEY" }), tool("bash")), undefined, "a variable name is not a secret");
  const edit = call("edit_file", { path: "/p/eslint.config.js", old_string: "error", new_string: "off" });
  const v3 = g.preTool!(s, edit, tool("edit_file"));
  assert.equal(v3?.action, "needs-confirmation");
  assert.equal(s.confirmations.length, 1);
  s.userMessageIndex = 2; s.confirmations[0].grantedAtUserMsg = 2;
  assert.equal(g.preTool!(s, edit, tool("edit_file")), undefined, "granted: runs once");
  assert.equal(g.preTool!(s, edit, tool("edit_file"))?.action, "needs-confirmation", "single use");
  assert.equal(g.preTool!(s, call("write_file", { path: "/new/.prettierrc", content: "{}" }), tool("write_file")), undefined, "a new config is fine");
  assert.ok(PROTECTED_CONFIGS.has("biome.json"));
});

test("redactSecrets: tokens and private keys are masked, the rest of the text stays", () => {
  const t = "token sk-or-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwxyz01 and Bearer abcdefghijklmnopqrstu ok";
  const r = redactSecrets(t);
  assert.ok(!/sk-or-|ghp_|abcdefghijklmnopqrstu/.test(r));
  assert.ok(r.includes("[redacted secret]") && r.includes("Bearer [redacted secret]") && r.endsWith(" ok"));
  assert.equal(redactSecrets("nothing here"), "nothing here");
});
