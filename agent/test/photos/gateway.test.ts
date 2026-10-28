// The gateway's photo surface: validation on the send routes, storage per session and per user, the body limit that only
// photo sends get, the GET route for thumbnails, and cross-user denial (403 / 404) on a hosted multi-user deployment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { createConnection } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { PhotoStore } from "../../src/photos.ts";
import type { AgentSession, PhotoRef, Runtime } from "../../src/types.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { auth, fakeRuntime, http, parseSse, tmpStatic, waitAbort } from "../gateway/helpers.ts";
import { dataUrl, jpeg, jpegUrl, png, sample } from "./images.ts";

const rnd = () => randomBytes(18).toString("hex");

/** A GET that keeps the body as bytes and lets the test set Host (fetch cannot). */
function getBytes(base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, method: "GET", path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** The server hangs up on a body over its limit; the client may see the 413 or just the reset. Either is a refusal. */
const refusedWith413OrReset = async (p: Promise<{ status: number }>): Promise<number | "reset"> => p.then((r) => r.status, () => "reset" as const);

// ---------------------------------------------------------------- one user, token auth
async function boot(o: { photos?: boolean } = {}) {
  const base = fakeRuntime();
  const store = new PhotoStore({ dir: mkdtempSync(join(tmpdir(), "gw-photos-")), owner: "owner" });
  const sent: { text: string; photos?: PhotoRef[] }[] = [];
  const runtime: Runtime = {
    ...base,
    ...(o.photos === false ? {} : { photos: store }),
    async openSession(opts) {
      const s = await base.openSession(opts);
      const wrapped: AgentSession = { ...s, send(msg, so) { sent.push({ text: msg, photos: so?.photos }); return s.send(msg, so); } };
      return wrapped;
    },
  };
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const gw = await startGateway({ runtime, port: 0, staticDir: tmpStatic().dir, tokenPath: join(home, "tok") });
  const A = auth(gw.token);
  const open = async () => JSON.parse((await http(gw.url, "POST", "/sessions", { headers: A, body: { surface: "web" } })).body).sessionId as string;
  const send = (sid: string, body: unknown) => http(gw.url, "POST", `/sessions/${sid}/send`, { headers: A, body });
  return { gw, A, store, sent, open, send };
}

test("a send with photos stores them, tells the session, names them in the first SSE event, and serves them back", async () => {
  const w = await boot();
  try {
    const sid = await w.open();
    const r = await w.send(sid, { text: "What is the total on this estimate?", photos: [sample("estimate.jpg", 1024, 700), { name: "b.png", dataUrl: dataUrl("image/png", png(40, 30)) }] });
    assert.equal(r.status, 200, r.body);
    const ev = parseSse(r.body) as any[];
    assert.deepEqual(ev[0], { type: "photos", photos: [{ id: "p1", name: "estimate.jpg", width: 1024, height: 700 }, { id: "p2", name: "b.png", width: 40, height: 30 }] });
    assert.ok(ev.some((e) => e.type === "done"));
    // the session got the text and the stored refs (the runtime appends the [photo pN] lines)
    assert.equal(w.sent.length, 1);
    assert.equal(w.sent[0].text, "What is the total on this estimate?");
    assert.deepEqual(w.sent[0].photos, [{ id: "p1", name: "estimate.jpg", width: 1024, height: 700 }, { id: "p2", name: "b.png", width: 40, height: 30 }]);
    // GET the photo back: same bytes, right type, never cached, no sniffing
    const g = await fetch(`${w.gw.url}/sessions/${sid}/photos/p1`, { headers: w.A });
    assert.equal(g.status, 200);
    assert.equal(g.headers.get("content-type"), "image/jpeg");
    assert.match(g.headers.get("cache-control") ?? "", /no-store/);
    assert.match(g.headers.get("cache-control") ?? "", /private/);
    assert.equal(g.headers.get("x-content-type-options"), "nosniff");
    assert.match(g.headers.get("content-disposition") ?? "", /^inline; filename="estimate\.jpg"$/);
    assert.deepEqual(Buffer.from(await g.arrayBuffer()), jpeg(1024, 700));
    const g2 = await fetch(`${w.gw.url}/sessions/${sid}/photos/p2`, { headers: w.A });
    assert.equal(g2.headers.get("content-type"), "image/png");
    // later turns keep counting
    const r2 = await w.send(sid, { text: "and this one", photos: [sample("c.jpg")] });
    assert.equal((parseSse(r2.body) as any[])[0].photos[0].id, "p3");
  } finally { await w.gw.close(); }
});

test("photos with no words are fine; no words and no photos is still 'text required'", async () => {
  const w = await boot();
  try {
    const sid = await w.open();
    const r = await w.send(sid, { photos: [sample()] });
    assert.equal(r.status, 200);
    assert.equal(w.sent[0].text, "");
    assert.equal(w.sent[0].photos?.length, 1);
    const s2 = await w.open();
    assert.equal((await w.send(s2, { text: "  " })).status, 400);
    assert.equal((await w.send(s2, { photos: [] })).status, 400);
    assert.equal((await w.send(s2, {})).status, 400);
    assert.equal((await w.send(s2, { text: "plain text still works" })).status, 200);
  } finally { await w.gw.close(); }
});

test("validation: bad mime, bad base64, a mismatched image, too many, and oversize are refused and nothing is stored or sent", async () => {
  const w = await boot();
  try {
    const sid = await w.open();
    const cases: [string, unknown, number, RegExp][] = [
      ["svg", [{ name: "a.svg", dataUrl: dataUrl("image/svg+xml", Buffer.from("<svg onload=alert(1)/>")) }], 415, /not supported/],
      ["heic", [{ name: "a.heic", dataUrl: dataUrl("image/heic", Buffer.alloc(64)) }], 415, /convert it to JPEG/],
      ["pdf", [{ name: "a.pdf", dataUrl: dataUrl("application/pdf", Buffer.from("%PDF")) }], 415, /not supported/],
      ["not base64", [{ name: "a.jpg", dataUrl: "data:image/jpeg;base64,!!!!" }], 400, /not valid base64/],
      ["png labelled jpeg", [{ name: "a.jpg", dataUrl: dataUrl("image/jpeg", png(8, 8)) }], 400, /not a valid JPEG/],
      ["a url", [{ name: "a.jpg", dataUrl: "https://evil.example/a.jpg" }], 400, /base64 data URL/],
      ["not an array", "x", 400, /array/],
      ["six", Array.from({ length: 6 }, (_, i) => sample(`${i}.jpg`)), 400, /at most 5/],
      ["one over 8 MB", [{ name: "big.jpg", dataUrl: jpegUrl(4000, 3000, 8 * 1024 * 1024 + 1000) }], 413, /8 MB per photo/],
    ];
    for (const [name, photos, status, msg] of cases) {
      const r = await w.send(sid, { text: "look", photos });
      assert.equal(r.status, status, `${name}: ${r.body.slice(0, 200)}`);
      assert.match(JSON.parse(r.body).error, msg, name);
    }
    assert.deepEqual(w.store.list(sid), [], "nothing was stored");
    assert.equal(w.sent.length, 0, "no turn started");
    // the session is not stuck: a good send afterwards works
    assert.equal((await w.send(sid, { text: "ok now", photos: [sample()] })).status, 200);
  } finally { await w.gw.close(); }
});

test("per-request cap: photos that are each fine but together over 24 MB are refused", async () => {
  const w = await boot();
  try {
    const sid = await w.open();
    // 4 x 6.5 MB = 26 MB decoded: each is under the 8 MB cap, together they are over 24 MB (and the body still fits the route's limit)
    const r = await w.send(sid, { text: "x", photos: Array.from({ length: 4 }, (_, i) => ({ name: `s${i}.jpg`, dataUrl: jpegUrl(3000, 2000, Math.floor(6.5 * 1024 * 1024)) })) });
    assert.equal(r.status, 413, r.body.slice(0, 200));
    assert.match(JSON.parse(r.body).error, /total over 24 MB/);
    assert.deepEqual(w.store.list(sid), []);
    assert.equal(w.sent.length, 0);
  } finally { await w.gw.close(); }
});

test("the larger body limit belongs to photo sends only: a 2 MB photo send passes, a 2 MB text-only body is refused", async () => {
  const w = await boot();
  try {
    const sid = await w.open();
    const photo = await w.send(sid, { text: "big photo", photos: [{ name: "two.jpg", dataUrl: jpegUrl(3000, 2000, 2 * 1024 * 1024) }] });
    assert.equal(photo.status, 200, photo.body.slice(0, 200));
    const s2 = await w.open();
    const text = await w.send(s2, { text: "x".repeat(2 * 1024 * 1024) });
    assert.equal(text.status, 413);
    // other routes keep the 1 MB limit
    const other = await refusedWith413OrReset(http(w.gw.url, "POST", "/sessions", { headers: w.A, body: { surface: "web", title: "x".repeat(2 * 1024 * 1024) } }));
    assert.ok(other === 413 || other === "reset", String(other));
  } finally { await w.gw.close(); }
});

test("a busy session refuses the send (409) before storing any photo", async () => {
  const base = fakeRuntime({ script: async function* (_m, signal) { await waitAbort(signal); } });
  const store = new PhotoStore({ dir: mkdtempSync(join(tmpdir(), "gw-photos-")), owner: "owner" });
  const gw = await startGateway({ runtime: { ...base, photos: store }, port: 0, staticDir: tmpStatic().dir, tokenPath: join(mkdtempSync(join(tmpdir(), "mc-home-")), "tok") });
  try {
    const A = auth(gw.token);
    const sid = JSON.parse((await http(gw.url, "POST", "/sessions", { headers: A, body: { surface: "web" } })).body).sessionId as string;
    const first = http(gw.url, "POST", `/sessions/${sid}/send`, { headers: A, body: { text: "hang" } });
    await new Promise((r) => setTimeout(r, 200));
    const r = await http(gw.url, "POST", `/sessions/${sid}/send`, { headers: A, body: { text: "again", photos: [sample()] } });
    assert.equal(r.status, 409);
    assert.deepEqual(store.list(sid), []);
    await http(gw.url, "POST", `/sessions/${sid}/abort`, { headers: A });
    await first;
  } finally { await gw.close(); }
});

test("a re-attaching client sees the user's photos in the replayed user event", async () => {
  const w = await boot();
  try {
    const sid = await w.open();
    await w.send(sid, { text: "see this", photos: [sample("x.jpg", 50, 40)] });
    const r = await http(w.gw.url, "GET", `/sessions/${sid}/events?after=0`, { headers: w.A });
    const user = (parseSse(r.body) as any[]).find((e) => e.type === "user");
    assert.equal(user.text, "see this");
    assert.deepEqual(user.photos, [{ id: "p1", name: "x.jpg", width: 50, height: 40 }]);
  } finally { await w.gw.close(); }
});

test("GET photo: auth required, only pN ids, unknown or other-session photo is 404", async () => {
  const w = await boot();
  try {
    const sid = await w.open();
    await w.send(sid, { text: "x", photos: [sample()] });
    assert.equal((await http(w.gw.url, "GET", `/sessions/${sid}/photos/p1`)).status, 401);
    assert.equal((await http(w.gw.url, "GET", `/sessions/${sid}/photos/p2`, { headers: w.A })).status, 404);
    for (const bad of ["p0", "x1", "p1.bin", "..", "p1%2F..%2Findex.json", "P1"]) assert.equal((await http(w.gw.url, "GET", `/sessions/${sid}/photos/${bad}`, { headers: w.A })).status, 404, bad);
    const other = await w.open();
    assert.equal((await http(w.gw.url, "GET", `/sessions/${other}/photos/p1`, { headers: w.A })).status, 404, "another chat's photo id is not here");
    assert.equal((await http(w.gw.url, "POST", `/sessions/${sid}/photos/p1`, { headers: w.A, body: {} })).status, 405);
  } finally { await w.gw.close(); }
});

test("a runtime without a photo store says so instead of dropping the photo silently", async () => {
  const w = await boot({ photos: false });
  try {
    const sid = await w.open();
    const r = await w.send(sid, { text: "look", photos: [sample()] });
    assert.equal(r.status, 404);
    assert.match(JSON.parse(r.body).error, /not available/);
    assert.equal(w.sent.length, 0);
    assert.equal((await http(w.gw.url, "GET", `/sessions/${sid}/photos/p1`, { headers: w.A })).status, 404);
    assert.equal((await w.send(sid, { text: "plain" })).status, 200, "text still works");
  } finally { await w.gw.close(); }
});

test("at most 3 large photo bodies are read at once; the 4th gets 429 and retry-after", async () => {
  const w = await boot();
  const socks: ReturnType<typeof createConnection>[] = [];
  try {
    const u = new URL(w.gw.url);
    const sids: string[] = [];
    for (let i = 0; i < 4; i++) sids.push(await w.open());
    for (let i = 0; i < 3; i++) {
      const s = createConnection({ host: u.hostname, port: Number(u.port) });
      socks.push(s);
      // headers promise a 5 MB body that never arrives: the server is stuck reading it
      s.write(`POST /sessions/${sids[i]}/send HTTP/1.1\r\nHost: ${u.host}\r\nAuthorization: Bearer ${w.gw.token}\r\nContent-Type: application/json\r\nContent-Length: 5000000\r\n\r\n{"text":"x"`);
    }
    await new Promise((r) => setTimeout(r, 300));
    const r = await http(w.gw.url, "POST", `/sessions/${sids[3]}/send`, { headers: { ...w.A }, body: { text: "x", photos: [{ name: "p.jpg", dataUrl: jpegUrl(3000, 2000, 1_200_000) }] } });
    assert.equal(r.status, 429);
    assert.equal(r.headers["retry-after"], "5");
    // an ordinary text send is never throttled by this
    assert.equal((await w.send(sids[3], { text: "hello" })).status, 200);
    // clients that hang up mid-body give their slot back (a stuck slot would lock photo uploads for everyone)
    for (const s of socks) s.destroy();
    await new Promise((r) => setTimeout(r, 300));
    const after = await http(w.gw.url, "POST", `/sessions/${sids[2]}/send`, { headers: { ...w.A }, body: { text: "x", photos: [{ name: "p.jpg", dataUrl: jpegUrl(3000, 2000, 1_200_000) }] } });
    assert.equal(after.status, 200, after.body.slice(0, 200));
  } finally {
    for (const s of socks) s.destroy();
    await w.gw.close();
  }
});

// ---------------------------------------------------------------- hosted, two users
const H = { host: "daebot.live", "x-forwarded-proto": "https" };
const cookieOf = (r: { headers: Record<string, string | string[] | undefined> }) => String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];

async function hostedRig(dir = mkdtempSync(join(tmpdir(), "gw-photos-hosted-"))) {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const token = rnd();
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const provider = new FakeProvider([{ text: "hi there" }]);
  const bots = { dir, bus: {} };
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, bots, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const a = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache, bots });
  const gw = await startGateway({ runtime: ownerRuntime, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth: a, sessionStore, bots });
  const login = async (key: string) => ({ ...H, cookie: cookieOf(await http(gw.url, "POST", "/auth/key", { headers: H, body: { key } })) });
  const owner = async () => ({ ...H, cookie: cookieOf(await http(gw.url, "POST", "/login", { headers: H, body: { token } })) });
  return { gw, dir, keys, login, owner, close: async () => { await gw.close(); await fake.close(); } };
}

test("hosted: photos are per user. Another user, the owner login and an anonymous caller can never fetch or add to someone else's chat photos", async () => {
  const r = await hostedRig();
  try {
    const A = await r.login(r.keys.alice);
    const B = await r.login(r.keys.bob);
    const sidA = JSON.parse((await http(r.gw.url, "POST", "/sessions", { headers: A, body: { surface: "web", title: "alice private" } })).body).sessionId as string;
    const sent = await http(r.gw.url, "POST", `/sessions/${sidA}/send`, { headers: A, body: { text: "my private estimate", photos: [sample("private.jpg", 800, 600)] } });
    assert.equal(sent.status, 200, sent.body.slice(0, 300));
    assert.equal((parseSse(sent.body) as any[])[0].photos[0].id, "p1");
    // alice can read it
    const mine = await getBytes(r.gw.url, `/sessions/${sidA}/photos/p1`, A);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body, jpeg(800, 600));
    assert.match(String(mine.headers["cache-control"]), /private, no-store/);
    // bob: 403 on her session (it exists, it is not his), for both reading and adding
    assert.equal((await http(r.gw.url, "GET", `/sessions/${sidA}/photos/p1`, { headers: B })).status, 403);
    const add = await http(r.gw.url, "POST", `/sessions/${sidA}/send`, { headers: B, body: { text: "x", photos: [sample("evil.jpg")] } });
    assert.equal(add.status, 403);
    // the owner (access-code) login is a different tenant too
    const O = await r.owner();
    assert.equal((await http(r.gw.url, "GET", `/sessions/${sidA}/photos/p1`, { headers: O })).status, 403);
    // anonymous: not signed in
    assert.equal((await http(r.gw.url, "GET", `/sessions/${sidA}/photos/p1`, { headers: H })).status, 401);
    // bob asking for the same ids on a session id nobody owns is a plain 404, and his own photo dir has nothing of hers
    assert.equal((await http(r.gw.url, "GET", `/sessions/not-a-session/photos/p1`, { headers: B })).status, 404);
    // alice's chat gained nothing from bob's refused add
    assert.equal((await getBytes(r.gw.url, `/sessions/${sidA}/photos/p2`, A)).status, 404);
  } finally { await r.close(); }
});

test("hosted: after a restart the owner of a stored chat still reads its photos and other users are still refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-photos-restart-"));
  const r1 = await hostedRig(dir);
  let sidA = "";
  const keys = r1.keys;
  try {
    const A = await r1.login(keys.alice);
    sidA = JSON.parse((await http(r1.gw.url, "POST", "/sessions", { headers: A, body: { surface: "web" } })).body).sessionId;
    assert.equal((await http(r1.gw.url, "POST", `/sessions/${sidA}/send`, { headers: A, body: { text: "keep this", photos: [sample("keep.jpg")] } })).status, 200);
  } finally { await r1.close(); }
  // a second process over the same data dir (a deploy). Users and keys are rebuilt by signing in again.
  const r2 = await hostedRig(dir);
  try {
    // same usernames, so same user ids and the same per-user photo folders
    const A2 = await r2.login(r2.keys.alice);
    const B2 = await r2.login(r2.keys.bob);
    const resumed = await http(r2.gw.url, "POST", "/sessions", { headers: A2, body: { surface: "web", resumeId: sidA } });
    assert.equal(resumed.status, 200);
    assert.equal((await getBytes(r2.gw.url, `/sessions/${sidA}/photos/p1`, A2)).status, 200, "alice's photo survived the restart");
    assert.equal((await http(r2.gw.url, "GET", `/sessions/${sidA}/photos/p1`, { headers: B2 })).status, 403);
    const hist = JSON.parse((await http(r2.gw.url, "GET", `/sessions/${sidA}/history`, { headers: A2 })).body).events as any[];
    assert.deepEqual(hist.find((e) => e.type === "user").photos.map((p: any) => p.id), ["p1"], "the transcript still shows the photo");
  } finally { await r2.close(); }
});
