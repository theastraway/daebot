import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { audioExt, MAX_AUDIO_BYTES, MAX_TTS_CHARS, STT_PER_MIN, createVoiceHandler } from "../../src/gateway/voice.ts";
import { STATIC_CSP } from "../../src/gateway/static.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import { http, tmpStatic } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex");
const H = { host: "daebot.live", "x-forwarded-proto": "https" };
const AUDIO = Buffer.alloc(4000, 7);

function raw(base: string, path: string, headers: Record<string, string>, body: Buffer): Promise<{ status: number; headers: Record<string, any>; body: Buffer }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, method: "POST", path, headers: { ...headers, "content-length": String(body.length) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function rig() {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd() };
  const ownerKey = "server-owner-key-" + rnd();
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob", [ownerKey]: "owner" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const token = rnd();
  const dir = mkdtempSync(join(tmpdir(), "daebot-voice-"));
  const provider = new FakeProvider([{ text: "hi" }]);
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: ownerKey });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "boss", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, cfg, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore });
  const cookie = async (key: string) => {
    const r = await http(gw.url, "POST", "/auth/key", { headers: H, body: { key } });
    assert.equal(r.status, 200, r.body);
    return { ...H, cookie: String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0] };
  };
  const ownerCookie = async () => {
    const r = await http(gw.url, "POST", "/login", { headers: H, body: { token } });
    return { ...H, cookie: String(([] as string[]).concat(r.headers["set-cookie"] as string[])[0]).split(";")[0] };
  };
  return { gw, fake, keys, ownerKey, cookie, ownerCookie, close: async () => { await gw.close(); await fake.close(); } };
}
const stt = (r: { gw: { url: string } }, h: Record<string, string>, body: Buffer = AUDIO, type = "audio/webm;codecs=opus", q = "") =>
  raw(r.gw.url, `/voice/stt${q}`, { ...h, "content-type": type }, body);
const tts = (r: { gw: { url: string } }, h: Record<string, string>, text: unknown) =>
  raw(r.gw.url, "/voice/tts", { ...h, "content-type": "application/json" }, Buffer.from(JSON.stringify({ text })));

test("voice needs a session; the static CSP allows blob media and nothing broader", async () => {
  const r = await rig();
  try {
    assert.equal((await stt(r, H)).status, 401);
    assert.equal((await tts(r, H, "hi")).status, 401);
    assert.match(STATIC_CSP, /media-src 'self' blob:;/);
    assert.match(STATIC_CSP, /connect-src 'self';/);
    assert.doesNotMatch(STATIC_CSP, /unsafe|\*/);
  } finally { await r.close(); }
});

test("voice STT/TTS forward with the signed-in user's OWN key, never the server key or another user's", async () => {
  const r = await rig();
  try {
    const alice = await r.cookie(r.keys.alice);
    const bob = await r.cookie(r.keys.bob);
    const a = await stt(r, alice);
    assert.equal(a.status, 200);
    assert.equal(JSON.parse(a.body.toString()).text, "hello from alice");
    assert.equal(a.headers["x-mind-credits-used"], "0.01");
    const b = await tts(r, bob, "Good morning, Bob.");
    assert.equal(b.status, 200);
    assert.equal(b.headers["content-type"], "audio/mpeg");
    assert.equal(b.body.toString(), "ID3fakemp3");
    const calls = r.fake.seen.filter((s) => s.path.startsWith("/developer/v1/audio/"));
    assert.deepEqual(calls.map((c) => [c.path.split("/").pop(), c.key]), [["transcriptions", r.keys.alice], ["speech", r.keys.bob]]);
    assert.ok(calls.every((c) => c.key !== r.ownerKey));
    assert.deepEqual(calls[1].body, { input: "Good morning, Bob." });
    assert.ok(!a.body.toString().includes(r.keys.alice) && !b.body.toString().includes(r.keys.bob), "keys never echoed");
  } finally { await r.close(); }
});

test("owner access-code login uses the server MIND key", async () => {
  const r = await rig();
  try {
    const owner = await r.ownerCookie();
    assert.equal((await tts(r, owner, "owner speaking")).status, 200);
    assert.equal(r.fake.seen.filter((s) => s.path.endsWith("/audio/speech"))[0].key, r.ownerKey);
  } finally { await r.close(); }
});

test("MIND refusals are mapped: 402 credits, 404 flag off, 401 key rejected; nothing else leaks", async () => {
  const r = await rig();
  try {
    const alice = await r.cookie(r.keys.alice);
    r.fake.audioStatus = 402;
    const c = await stt(r, alice);
    assert.equal(c.status, 402);
    const cj = JSON.parse(c.body.toString());
    assert.equal(cj.error, "insufficient_credits");
    assert.equal(cj.upgradeUrl, "https://m-i-n-d.ai/#/billing");
    r.fake.audioStatus = 404;
    const n = await tts(r, alice, "hi");
    assert.equal(n.status, 503);
    assert.equal(JSON.parse(n.body.toString()).error, "voice_unavailable");
    r.fake.audioStatus = 500;
    const e = await tts(r, alice, "hi");
    assert.equal(e.status, 502);
    assert.doesNotMatch(e.body.toString(), /detail/);
    r.fake.audioStatus = undefined;
    r.fake.keys.delete(r.keys.alice); // revoked at MIND
    assert.equal((await stt(r, alice)).status, 401);
  } finally { await r.close(); }
});

test("input validation: audio type, size, empty, text length, bad JSON", async () => {
  const r = await rig();
  try {
    const alice = await r.cookie(r.keys.alice);
    assert.equal((await stt(r, alice, AUDIO, "text/plain")).status, 415);
    assert.equal((await stt(r, alice, Buffer.alloc(10))).status, 400);
    assert.equal((await stt(r, alice, Buffer.alloc(MAX_AUDIO_BYTES + 1, 1))).status, 413);
    assert.equal((await tts(r, alice, "   ")).status, 400);
    assert.equal((await tts(r, alice, "x".repeat(MAX_TTS_CHARS + 1))).status, 413);
    assert.equal((await raw(r.gw.url, "/voice/tts", { ...alice, "content-type": "application/json" }, Buffer.from("{nope"))).status, 400);
    assert.equal(r.fake.seen.filter((s) => s.path.includes("/audio/")).length, 0, "nothing reached MIND");
    const lang = await stt(r, alice, AUDIO, "audio/mp4", "?lang=en");
    assert.equal(lang.status, 200);
    assert.equal((await http(r.gw.url, "GET", "/voice/stt", { headers: alice })).status, 405);
  } finally { await r.close(); }
});

test("per-user rate limit is enforced and is independent per user", async () => {
  const r = await rig();
  try {
    const alice = await r.cookie(r.keys.alice);
    const bob = await r.cookie(r.keys.bob);
    for (let i = 0; i < STT_PER_MIN; i++) assert.equal((await stt(r, alice)).status, 200, `call ${i}`);
    const blocked = await stt(r, alice);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers["retry-after"]) >= 1);
    assert.equal((await stt(r, bob)).status, 200);
  } finally { await r.close(); }
});

test("handler unit: a principal without a MIND key gets 503 and MIND is never called", async () => {
  let called = 0;
  const h = createVoiceHandler({ baseUrl: "http://x/developer/v1", keyFor: () => undefined, fetchImpl: (async () => { called++; return new Response("{}"); }) as typeof fetch });
  const out: { status?: number } = {};
  const req: any = { method: "POST", headers: {}, resume() {} };
  const res: any = { headersSent: false, writeHead(s: number) { out.status = s; }, end() {} };
  await h(req, res, "/voice/tts", new URLSearchParams(), { id: "u", username: "u", owner: false, tier: "staff" } as any);
  assert.equal(out.status, 503);
  assert.equal(called, 0);
});

test("audioExt accepts MediaRecorder containers and rejects others", () => {
  for (const [t, e] of [["audio/webm;codecs=opus", "webm"], ["audio/mp4", "mp4"], ["audio/ogg; codecs=opus", "ogg"], ["audio/wav", "wav"]] as const) assert.equal(audioExt(t), e);
  for (const t of ["text/html", "application/octet-stream", undefined, ""]) assert.equal(audioExt(t), undefined);
});
