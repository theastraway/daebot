import { test } from "node:test";
import assert from "node:assert/strict";
import { allowMediaCheck, allowMediaRequest, installMediaPermissions, isMicRequest } from "../src/lib/media-permission.mjs";

const GW = "http://127.0.0.1:48123";

test("our own UI may ask for the microphone and nothing else", () => {
  const mic = { mediaTypes: ["audio"] };
  assert.equal(allowMediaRequest({ permission: "media", details: mic, url: `${GW}/chat`, gatewayOrigin: GW }), true);
  assert.equal(allowMediaRequest({ permission: "media", details: { mediaTypes: ["video"] }, url: GW, gatewayOrigin: GW }), false);
  assert.equal(allowMediaRequest({ permission: "media", details: { mediaTypes: ["audio", "video"] }, url: GW, gatewayOrigin: GW }), false);
  assert.equal(allowMediaRequest({ permission: "media", details: { mediaTypes: [] }, url: GW, gatewayOrigin: GW }), false);
  for (const p of ["geolocation", "notifications", "display-capture", "midi", "hid", "clipboard-read", "openExternal"]) {
    assert.equal(allowMediaRequest({ permission: p, details: mic, url: GW, gatewayOrigin: GW }), false, p);
  }
});

test("any other origin is refused the microphone", () => {
  const mic = { mediaTypes: ["audio"] };
  for (const url of ["https://evil.example/", "http://127.0.0.1:9999/", "https://daebot.live/", "file:///etc/passwd", ""]) {
    assert.equal(allowMediaRequest({ permission: "media", details: mic, url, gatewayOrigin: GW }), false, url);
  }
  assert.equal(allowMediaRequest({ permission: "media", details: mic, url: `${GW}/`, gatewayOrigin: undefined }), false);
  assert.equal(isMicRequest("media", undefined), false);
});

test("permission checks: audio on our origin only", () => {
  assert.equal(allowMediaCheck({ permission: "media", details: { mediaType: "audio" }, origin: GW, gatewayOrigin: GW }), true);
  assert.equal(allowMediaCheck({ permission: "media", details: { mediaType: "video" }, origin: GW, gatewayOrigin: GW }), false);
  assert.equal(allowMediaCheck({ permission: "media", details: { mediaType: "audio" }, origin: "https://evil.example", gatewayOrigin: GW }), false);
  assert.equal(allowMediaCheck({ permission: "notifications", details: {}, origin: GW, gatewayOrigin: GW }), false);
});

function fakeSession() {
  const s = {};
  s.setPermissionRequestHandler = (h) => { s.req = h; };
  s.setPermissionCheckHandler = (h) => { s.chk = h; };
  return s;
}
const ask = (ses, permission, details, wcUrl = GW) => new Promise((r) => ses.req({ getURL: () => wcUrl }, permission, r, details));

test("installed handlers: the OS prompt decides, and is never shown for a refused request", async () => {
  let asked = 0, answer = true;
  const ses = fakeSession();
  installMediaPermissions(ses, { getOrigin: () => GW, askOs: async () => { asked++; return answer; } });
  assert.equal(await ask(ses, "media", { mediaTypes: ["audio"], requestingUrl: `${GW}/` }), true);
  assert.equal(asked, 1);
  answer = false;
  assert.equal(await ask(ses, "media", { mediaTypes: ["audio"], requestingUrl: `${GW}/` }), false);
  assert.equal(await ask(ses, "media", { mediaTypes: ["video"], requestingUrl: `${GW}/` }), false);
  assert.equal(await ask(ses, "media", { mediaTypes: ["audio"], requestingUrl: "https://evil.example/" }), false);
  assert.equal(await ask(ses, "geolocation", {}), false);
  assert.equal(asked, 2);
  assert.equal(ses.chk(null, "media", GW, { mediaType: "audio" }), true);
  assert.equal(ses.chk(null, "media", "https://evil.example", { mediaType: "audio" }), false);
});

test("a failing OS prompt denies instead of hanging", async () => {
  const ses = fakeSession();
  installMediaPermissions(ses, { getOrigin: () => GW, askOs: async () => { throw new Error("boom"); } });
  assert.equal(await ask(ses, "media", { mediaTypes: ["audio"], requestingUrl: `${GW}/` }), false);
});
