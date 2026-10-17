import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearKey, keyPath, looksLikeMindKey, readKey, resolveSignIn, saveKey } from "../src/lib/credentials.mjs";
import { buildSignInHtml, buildSignInPage } from "../src/lib/signin-page.mjs";
import { createHash } from "node:crypto";

const KEY = "mind_TESTKEY_0123456789abcdef"; // throwaway test value

test("key shape: mind_ prefix, safe characters, sane length", () => {
  assert.ok(looksLikeMindKey(KEY) && looksLikeMindKey(`  ${KEY}\n`));
  for (const bad of ["", "mind_", "mind_short", "sk-abc", "mind_has space1234", "mind_x\ny1234567", null, undefined, 5]) assert.equal(looksLikeMindKey(bad), false, String(bad));
});

test("saveKey: private file (0600) in a private dir, atomic, round-trips, no temp left, never echoes the key in errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "dae-key-"));
  const p = join(dir, "nested", "mind-key");
  saveKey(KEY, p);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
  assert.equal(readKey(p), KEY);
  assert.deepEqual(readdirSync(join(dir, "nested")), ["mind-key"]);
  const bad = "mind_bad key";
  assert.throws(() => saveKey(bad, p), (e) => !String(e.message).includes(bad));
  assert.equal(readKey(p), KEY, "a rejected save leaves the old key alone");
  clearKey(p);
  assert.equal(existsSync(p), false);
  assert.equal(readKey(p), undefined);
  assert.equal(keyPath({ MINDCLAW_DESKTOP_HOME: "/h" }), "/h/mind-key");
});

test("resolveSignIn: saved key, env key, config key, openrouter dev setup, else needs-key", () => {
  assert.deepEqual(resolveSignIn({ env: {}, saved: KEY }), { mode: "mind", key: KEY });
  // env / config keys are read by the child itself, so the shell passes nothing extra
  assert.deepEqual(resolveSignIn({ env: { MIND_API_KEY: KEY }, config: {} }), { mode: "mind", key: undefined });
  assert.deepEqual(resolveSignIn({ env: {}, config: { mindApiKey: KEY } }), { mode: "mind", key: undefined });
  assert.deepEqual(resolveSignIn({ env: { OPENROUTER_API_KEY: "or-x" }, config: {} }), { mode: "openrouter" });
  assert.deepEqual(resolveSignIn({ env: {}, config: { openrouterKey: "or-x" } }), { mode: "openrouter" });
  assert.deepEqual(resolveSignIn({ env: { OPENROUTER_API_KEY: "or-x", DAEBOT_BILLING: "mind" }, config: {} }), { mode: "needs-key" });
  assert.deepEqual(resolveSignIn({ env: {}, config: {} }), { mode: "needs-key" });
  assert.deepEqual(resolveSignIn({ env: { MIND_API_KEY: "garbage" }, config: {} }), { mode: "needs-key" });
});

test("sign-in page: CSP pins the one script and one style by hash, no inline handlers/attributes, no key material", () => {
  const html = buildSignInHtml({ dark: true });
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.ok(csp.includes(`'sha256-${createHash("sha256").update(script).digest("base64")}'`));
  assert.ok(csp.includes(`'sha256-${createHash("sha256").update(style).digest("base64")}'`));
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=|\sstyle\s*=|innerHTML/i);
  assert.match(html, /type="password"/);
  assert.match(script, /window\.daebotSignIn\.submit/);
  assert.ok(buildSignInPage({}).startsWith("data:text/html;charset=utf-8,"));
  assert.notEqual(buildSignInHtml({ dark: false }), html);
});

test("the desktop shell never logs, prints or URL-encodes the key", () => {
  for (const f of ["../src/main.mjs", "../src/lib/credentials.mjs", "../src/lib/launcher.mjs"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /log\([^)]*(mindKey|key\b)/, f);
    assert.doesNotMatch(src, /console\.[a-z]+\([^)]*[kK]ey/, f);
  }
});
