import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildId, handleAppFeed, resetAppFeedCache, validateAndroidFeed } from "../src/gateway/appfeed.ts";

const good = { version: "1.0.0", versionCode: 1, url: "https://download.m-i-n-d.ai/download/daebot/Daebot-1.0.0.apk", sha256: "A".repeat(64), size: 5000000 };
function fakeRes() {
  const r: any = new EventEmitter(); r.status = 0; r.headers = {}; r.body = "";
  r.writeHead = (s: number, h: any) => { r.status = s; r.headers = h; };
  r.end = (b?: string) => { r.body = b ?? ""; };
  return r;
}
beforeEach(() => resetAppFeedCache());

test("buildId uses the deploy commit, shortened, else dev", () => {
  assert.equal(buildId({ RENDER_GIT_COMMIT: "0123456789abcdef" } as any), "0123456789ab");
  assert.equal(buildId({} as any), "dev");
});

test("feed validation rejects foreign hosts and malformed fields", () => {
  assert.equal(validateAndroidFeed(good)?.sha256, "a".repeat(64));
  assert.equal(validateAndroidFeed({ ...good, url: "https://evil.example/a.apk" }), null);
  assert.equal(validateAndroidFeed({ ...good, sha256: "zz" }), null);
  assert.equal(validateAndroidFeed({ ...good, versionCode: 0 }), null);
});

test("relays the Android feed and caches it", async () => {
  let calls = 0;
  const f: any = async () => { calls++; return { ok: true, json: async () => good }; };
  const a = fakeRes(); assert.equal(await handleAppFeed("/download/android-latest.json", "GET", a, f, 1000), true);
  const b = fakeRes(); await handleAppFeed("/download/android-latest.json", "GET", b, f, 2000);
  assert.equal(a.status, 200); assert.equal(JSON.parse(b.body).version, "1.0.0"); assert.equal(calls, 1);
});

test("502 when upstream is down and nothing is cached; stable apk link redirects; other paths pass through", async () => {
  const down: any = async () => { throw new Error("x"); };
  const a = fakeRes(); await handleAppFeed("/download/android-latest.json", "GET", a, down, 1);
  assert.equal(a.status, 502);
  const b = fakeRes(); await handleAppFeed("/download/Daebot.apk", "GET", b);
  assert.equal(b.status, 302); assert.equal(b.headers.location, "https://download.m-i-n-d.ai/download/daebot/Daebot.apk");
  assert.equal(await handleAppFeed("/health", "GET", fakeRes()), false);
});
