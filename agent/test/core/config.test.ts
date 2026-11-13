import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";

const empty = () => ({ MINDCLAW_CONFIG: join(mkdtempSync(join(tmpdir(), "mc-")), "none.json") });

test("defaults", () => {
  const c = loadConfig(empty());
  assert.equal(c.mindBaseUrl, "https://mindapp.onrender.com/developer/v1");
  assert.equal(c.models.default, "qwen/qwen3.8-flash");
  assert.equal(c.models.cheap, "qwen/qwen3.8-flash");
  assert.deepEqual(c.models.fallback, ["deepseek/deepseek-v4-flash"]);
  assert.equal(c.contextWindow, 128000);
  assert.equal(c.compactAt, 0.4, "focused context compacts at 40%");
  assert.equal(c.maxToolRoundsPerTurn, undefined); // no round limit by default
  assert.equal(c.checkInMs, 300_000);
  assert.equal(c.kernel, true);
  assert.equal(c.shadow, false);
});

test("env flags and keys", () => {
  const c = loadConfig({ ...empty(), MIND_API_KEY: "mk", OPENROUTER_API_KEY: "ok", MINDCLAW_SHADOW: "1", MINDCLAW_KERNEL: "0", MINDCLAW_MODEL: "x/y", MINDCLAW_CHEAP_MODEL: "x/z", MIND_BASE_URL: "http://h/v1/" });
  assert.equal(c.mindApiKey, "mk");
  assert.equal(c.openrouterKey, "ok");
  assert.equal(c.shadow, true);
  assert.equal(c.kernel, false);
  assert.equal(c.models.default, "x/y");
  assert.equal(c.models.cheap, "x/z");
  assert.equal(c.mindBaseUrl, "http://h/v1");
});

test("file config is used and env wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-"));
  const f = join(dir, "config.json");
  writeFileSync(f, JSON.stringify({ mindApiKey: "filekey", openrouterKey: "fileor", models: { default: "f/m", fallback: ["a/b", "c/d"] }, shadow: true }));
  const c = loadConfig({ MINDCLAW_CONFIG: f, MIND_API_KEY: "envkey" });
  assert.equal(c.mindApiKey, "envkey");
  assert.equal(c.openrouterKey, "fileor");
  assert.equal(c.models.default, "qwen/qwen3.8-flash", "the main model is env-only; a file value is ignored");
  assert.equal(loadConfig({ MINDCLAW_CONFIG: f, MINDCLAW_MODEL: "e/m" }).models.default, "e/m");
  assert.deepEqual(c.models.fallback, ["a/b", "c/d"]);
  assert.equal(c.shadow, true);
  assert.equal(loadConfig({ MINDCLAW_CONFIG: f, MINDCLAW_SHADOW: "0" }).shadow, false);
});

test("a saved config still pointing at the public site migrates; env stays literal", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-"));
  const f = join(dir, "c.json");
  writeFileSync(f, JSON.stringify({ mindBaseUrl: "https://m-i-n-d.ai/developer/v1/" }));
  assert.equal(loadConfig({ MINDCLAW_CONFIG: f }).mindBaseUrl, "https://mindapp.onrender.com/developer/v1");
  writeFileSync(f, JSON.stringify({ mindBaseUrl: "https://self.example/developer/v1" }));
  assert.equal(loadConfig({ MINDCLAW_CONFIG: f }).mindBaseUrl, "https://self.example/developer/v1");
  writeFileSync(f, JSON.stringify({ mindBaseUrl: "https://m-i-n-d.ai/developer/v1" }));
  assert.equal(loadConfig({ MINDCLAW_CONFIG: f, MIND_BASE_URL: "https://m-i-n-d.ai/developer/v1" }).mindBaseUrl, "https://m-i-n-d.ai/developer/v1");
});
