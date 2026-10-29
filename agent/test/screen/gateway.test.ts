import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startGateway } from "../../src/gateway/index.ts";
import { ScreenFeed } from "../../src/screen/feed.ts";
import { auth, fakeRuntime, http, tmpStatic } from "../gateway/helpers.ts";
import { sig } from "./helpers.ts";

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from("frame"), Buffer.from([0xff, 0xd9])]);
const q = (over: Record<string, string> = {}) => new URLSearchParams({ w: "1366", h: "768", sw: "2732", sh: "1536", cx: "10", cy: "20", sig: Buffer.from(sig(120)).toString("base64url"), ...over }).toString();

function post(base: string, path: string, body: Buffer, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, method: "POST", path, headers: { "content-type": "image/jpeg", "content-length": String(body.length), ...headers } }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c: string) => (b += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", reject); req.end(body);
  });
}

async function local() {
  const feed = new ScreenFeed();
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir, tokenPath: join(home, "tok"), screenFeed: feed });
  return { gw, feed };
}

test("gateway /screen: needs the token; state in, frames in, nothing stored while off", async () => {
  const { gw, feed } = await local();
  try {
    assert.equal((await http(gw.url, "GET", "/screen/state")).status, 401);
    assert.equal((await post(gw.url, `/screen/frame?${q()}`, jpeg, {})).status, 401);
    const a = auth(gw.token);
    // off: the frame is refused with 409 and not stored
    assert.equal((await post(gw.url, `/screen/frame?${q()}`, jpeg, a)).status, 409);
    assert.equal(feed.count(), 0);
    // the shell reports the switch on but the OS permission missing: still refused
    let r = await http(gw.url, "PUT", "/screen/state", { headers: a, body: { watching: true, permission: "needs-permission", fps: 2 } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).permission, "needs-permission");
    assert.equal((await post(gw.url, `/screen/frame?${q()}`, jpeg, a)).status, 409);
    // granted: accepted
    await http(gw.url, "PUT", "/screen/state", { headers: a, body: { watching: true, permission: "granted" } });
    assert.equal((await post(gw.url, `/screen/frame?${q()}`, jpeg, a)).status, 204);
    assert.equal(feed.count(), 1);
    assert.equal(feed.latest()!.cursorX, 10);
    assert.equal(JSON.parse((await http(gw.url, "GET", "/screen/state", { headers: a })).body).watching, true);
    // the user turns it off in the shell: the buffer is dropped
    await http(gw.url, "PUT", "/screen/state", { headers: a, body: { watching: false } });
    assert.equal(feed.count(), 0);
  } finally { await gw.close(); }
});

test("gateway /screen/frame: validates the body and the meta", async () => {
  const { gw, feed } = await local();
  try {
    const a = auth(gw.token);
    feed.setState({ watching: true, permission: "granted" });
    assert.equal((await post(gw.url, `/screen/frame?${q()}`, Buffer.from("not a jpeg at all"), a)).status, 400);
    assert.equal((await post(gw.url, `/screen/frame?${q({ w: "abc" })}`, jpeg, a)).status, 400);
    assert.equal((await post(gw.url, `/screen/frame?${q({ sig: "AAAA" })}`, jpeg, a)).status, 400);
    assert.equal((await post(gw.url, `/screen/frame?${q({ sw: "" })}`, jpeg, a)).status, 400);
    assert.equal((await post(gw.url, "/screen/frame", jpeg, a)).status, 400);
    assert.equal(feed.count(), 0);
    assert.equal((await http(gw.url, "GET", "/screen/frame", { headers: a })).status, 405);
    assert.equal((await http(gw.url, "DELETE", "/screen/state", { headers: a })).status, 405);
    assert.equal((await http(gw.url, "GET", "/screen/nope", { headers: a })).status, 404);
  } finally { await gw.close(); }
});

test("gateway /screen: the hosted deployment never mounts it (404 even with a valid login)", async () => {
  const st = tmpStatic();
  writeFileSync(join(st.dir, "login.html"), "<!doctype html><title>login</title>");
  const token = randomBytes(18).toString("hex");
  const feed = new ScreenFeed();
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: { token, allowedHosts: ["daebot.live", "localhost"] }, screenFeed: feed });
  try {
    const H = { host: "daebot.live", "x-forwarded-proto": "https" };
    assert.equal((await http(gw.url, "GET", "/screen/state", { headers: H })).status, 401, "no login: unauthorized");
    const lr = await http(gw.url, "POST", "/login", { headers: H, body: { token } });
    assert.equal(lr.status, 200);
    const cookie = String(([] as string[]).concat(lr.headers["set-cookie"] as string[])[0]).split(";")[0];
    const withToken = { ...H, cookie };
    assert.equal((await http(gw.url, "GET", "/sessions", { headers: withToken })).status, 200, "the login itself works");
    assert.equal((await http(gw.url, "GET", "/screen/state", { headers: withToken })).status, 404);
    assert.equal((await http(gw.url, "PUT", "/screen/state", { headers: withToken, body: { watching: true, permission: "granted" } })).status, 404);
    assert.equal((await post(gw.url, `/screen/frame?${q()}`, jpeg, withToken)).status, 404);
    assert.equal(feed.active(), false, "a hosted server cannot be switched into watching");
    assert.equal(feed.count(), 0);
  } finally { await gw.close(); }
});
