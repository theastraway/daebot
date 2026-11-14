import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { resolveNotarizeAuth } = require("../scripts/notarize.cjs");

test("notarize auth: API key path wins over Apple ID and keychain", () => {
  const a = resolveNotarizeAuth({ APPLE_API_KEY: "/k/AuthKey_X.p8", APPLE_API_KEY_ID: "X", APPLE_API_ISSUER: "iss", APPLE_ID: "a@b", APPLE_APP_SPECIFIC_PASSWORD: "p", APPLE_TEAM_ID: "T" });
  assert.equal(a.mode, "api-key");
  assert.deepEqual(a.options, { appleApiKey: "/k/AuthKey_X.p8", appleApiKeyId: "X", appleApiIssuer: "iss" });
});

test("notarize auth: base64 key is written to a 0600 temp file and cleaned up", () => {
  const a = resolveNotarizeAuth({ APPLE_API_KEY_BASE64: Buffer.from("PEMDATA").toString("base64"), APPLE_API_KEY_ID: "X", APPLE_API_ISSUER: "iss" });
  assert.equal(a.mode, "api-key");
  assert.equal(readFileSync(a.options.appleApiKey, "utf8"), "PEMDATA");
  a.cleanup();
  assert.equal(existsSync(a.options.appleApiKey), false);
});

test("notarize auth: API key without id or issuer falls through", () => {
  assert.equal(resolveNotarizeAuth({ APPLE_API_KEY: "/k.p8" }).mode, "keychain-profile");
});

test("notarize auth: Apple ID needs all three vars", () => {
  assert.equal(resolveNotarizeAuth({ APPLE_ID: "a@b", APPLE_APP_SPECIFIC_PASSWORD: "p", APPLE_TEAM_ID: "T" }).mode, "apple-id");
  assert.equal(resolveNotarizeAuth({ APPLE_ID: "a@b", APPLE_APP_SPECIFIC_PASSWORD: "p" }).mode, "keychain-profile");
});

test("notarize auth: nothing set uses the MINDNotarize keychain profile", () => {
  const a = resolveNotarizeAuth({});
  assert.deepEqual(a.options, { keychainProfile: "MINDNotarize" });
});
