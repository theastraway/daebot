import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { androidUpdate, cmpVersion, iosUpdate, parseIosInstalled, webUpdate } from "../../web/updates.js";

test("cmpVersion orders dotted versions numerically", () => {
  assert.equal(cmpVersion("1.0.10", "1.0.9"), 1);
  assert.equal(cmpVersion("1.0", "1.0.0"), 0);
  assert.equal(cmpVersion("0.9.9", "1.0.0"), -1);
});

test("webUpdate fires only when both builds are real and differ", () => {
  assert.equal(webUpdate("abc", "def"), true);
  assert.equal(webUpdate("abc", "abc"), false);
  assert.equal(webUpdate("dev", "def"), false);
  assert.equal(webUpdate("", "def"), false);
});

test("androidUpdate compares versionCode, not the name", () => {
  const feed = { version: "1.0.1", versionCode: 2, url: "https://download.m-i-n-d.ai/x.apk", sha256: "a".repeat(64) };
  assert.deepEqual(androidUpdate({ versionName: "1.0.0", versionCode: 1 }, feed), { version: "1.0.1", url: feed.url, sha256: feed.sha256 });
  assert.equal(androidUpdate({ versionName: "1.0.1", versionCode: 2 }, feed), null);
  assert.equal(androidUpdate(null, feed), null);
});

test("iOS: build 3 has no user agent marker and is assumed; build 4 reports itself", () => {
  assert.deepEqual(parseIosInstalled("Mozilla/5.0 (iPhone) AppleWebKit"), { version: "1.0.0", build: 3 });
  assert.deepEqual(parseIosInstalled("Mozilla/5.0 DaebotApp/ios 1.0.0 (4)"), { version: "1.0.0", build: 4 });
});

test("iosUpdate offers only a newer build, only over https", () => {
  const feed = { version: "1.0.0", build: 4, channel: "TestFlight", url: "https://beta.itunes.apple.com/v1/app/1" };
  assert.equal(iosUpdate({ version: "1.0.0", build: 3 }, feed)?.channel, "TestFlight");
  assert.equal(iosUpdate({ version: "1.0.0", build: 4 }, feed), null);
  assert.equal(iosUpdate({ version: "1.1.0", build: 1 }, feed), null);
  assert.equal(iosUpdate({ version: "1.0.0", build: 3 }, { ...feed, url: "javascript:alert(1)" }), null);
  assert.equal(iosUpdate({ version: "1.0.0", build: 3 }, { ...feed, channel: "App Store" })?.channel, "the App Store");
});
