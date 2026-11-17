import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { FALLBACK_PROVIDERS, dbFromForm, dbLine, llmFromForm, llmLine, localLine } from "../../web/connections.js";

test("llmLine: off, not configured, configured with key tail and model", () => {
  assert.match(llmLine({ feature_enabled: false }), /not switched on/);
  assert.match(llmLine({ feature_enabled: true, configured: false }), /MIND's models/);
  assert.equal(llmLine({ feature_enabled: true, configured: true, provider: "openrouter", key_last4: "abcd", model: "x/y" }), "Running on your OpenRouter key (key …abcd, model x/y). Your provider bills you directly.");
  assert.match(llmLine({ feature_enabled: true, configured: true, provider: "ollama" }), /Ollama \(local\) key\./);
});

test("llmFromForm: a cloud provider needs a key (unless already saved), a custom server needs its URL, Ollama needs neither; the preset URL is filled in", () => {
  assert.deepEqual(llmFromForm({ provider: "openrouter", apiKey: "sk-or-v1-abcdefgh" }), { body: { provider: "openrouter", base_url: "https://openrouter.ai/api/v1", api_key: "sk-or-v1-abcdefgh" } });
  assert.ok(llmFromForm({ provider: "openrouter", apiKey: "" }).error);
  assert.ok(!llmFromForm({ provider: "openrouter", apiKey: "", configured: true }).error, "replacing nothing keeps the saved key");
  assert.ok(llmFromForm({ provider: "openai-compat", apiKey: "sk-12345678" }).error);
  assert.deepEqual(llmFromForm({ provider: "openai-compat", apiKey: "sk-12345678", baseUrl: "https://llm.example.com/v1", model: "big" }), { body: { provider: "openai-compat", base_url: "https://llm.example.com/v1", api_key: "sk-12345678", model: "big" } });
  assert.deepEqual(llmFromForm({ provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1" }), { body: { provider: "ollama", base_url: "http://127.0.0.1:11434/v1", api_key: "" } });
  assert.ok(llmFromForm({ provider: "ollama", baseUrl: "ftp://x" }).error);
  assert.ok(llmFromForm({ provider: "nope", apiKey: "sk-12345678" }).error);
  assert.ok(llmFromForm({ provider: "openrouter", apiKey: "short" }).error);
  assert.ok(llmFromForm({ provider: "openrouter", apiKey: "sk-or-v1-abcdefgh", model: "../x" }).error);
  assert.ok(FALLBACK_PROVIDERS.some((p: { id: string }) => p.id === "openrouter"));
});

test("localLine: hosted reason, off, nothing served, served", () => {
  assert.equal(localLine({ available: false, reason: "Use the desktop app." }), "Use the desktop app.");
  assert.match(localLine({ available: true, enabled: false, base: "http://127.0.0.1:11434", served: [] }), /^Off\./);
  assert.match(localLine({ available: true, enabled: true, base: "http://127.0.0.1:11434", served: [] }), /Nothing served at http:\/\/127\.0\.0\.1:11434/);
  assert.match(localLine({ available: true, enabled: true, base: "http://127.0.0.1:11434", served: ["ollama/qwen3:14b", "ollama/llama3.2:3b"] }), /^qwen3:14b and 1 more served at http:\/\/127\.0\.0\.1:11434\./);
  assert.match(localLine({ available: true, enabled: true, base: "http://box:1234", served: ["ollama/q"] }), /^q served at http:\/\/box:1234\./);
});

test("dbLine and dbFromForm: cloud, own, states; the form wants a host without a scheme and a password unless one is saved", () => {
  assert.match(dbLine({ signed_out: true }), /Sign in/);
  assert.match(dbLine({ feature_available: false }), /not available/);
  assert.match(dbLine({ feature_available: true, db: { mode: "cloud" } }), /MIND Cloud/);
  assert.equal(dbLine({ feature_available: true, db: { mode: "own", configured: true, host: "db.example.com", port: 5432, database: "mind", bootstrapped_at: "x", routing: "stored_not_routed" } }), "Your own Postgres at db.example.com:5432/mind: set up, MIND will route to it when routing is switched on.");
  assert.match(dbLine({ feature_available: true, db: { mode: "own", configured: true, host: "h", routing: "routed", bootstrapped_at: "x" } }), /in use\.$/);
  assert.deepEqual(dbFromForm({ host: " db.example.com ", port: "", database: "mind", user: "u", password: "pw", ssl: "verify-full" }), { body: { host: "db.example.com", port: 5432, ssl: "verify-full", database: "mind", user: "u", password: "pw" } });
  assert.deepEqual(dbFromForm({ host: "db", port: "5433", password: "", passwordSet: true, ssl: "weird" }), { body: { host: "db", port: 5433, ssl: "require" } });
  assert.ok(dbFromForm({ host: "https://db", password: "pw" }).error);
  assert.ok(dbFromForm({ host: "db", password: "" }).error);
  assert.ok(dbFromForm({ host: "db", port: "0", password: "pw" }).error);
});
