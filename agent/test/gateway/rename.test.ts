import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { DailyCostCap, issueSession } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { userIdFor } from "../../src/auth/users.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import { http, tmpStatic } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex"); // throwaway test values
const H = { host: "daebot.live", "x-forwarded-proto": "https" };

async function rig(rounds: any[] = [{ text: "hi there" }]) {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd(), carol: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob", [keys.carol]: "carol" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const token = rnd();
  const dir = mkdtempSync(join(tmpdir(), "daebot-accts-"));
  const provider = new FakeProvider(rounds);
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore });
  return { gw, keys, token, dir, sessionStore, close: async () => { await gw.close(); await fake.close(); } };
}

type Res = { headers: Record<string, string | string[] | undefined> };
const setCookies = (r: Res): string[] => ([] as string[]).concat((r.headers["set-cookie"] as string[] | undefined) ?? []);
/** A tiny browser: keeps the latest value of every cookie, honors Max-Age=0 deletion. */
class Jar {
  c = new Map<string, string>();
  take(r: Res): this {
    for (const line of setCookies(r)) {
      const [pair, ...attrs] = line.split(";").map((x) => x.trim());
      const i = pair.indexOf("=");
      const name = pair.slice(0, i), val = pair.slice(i + 1);
      if (attrs.some((a) => /^max-age=0$/i.test(a)) || val === "") this.c.delete(name); else this.c.set(name, val);
    }
    return this;
  }
  copy(): Jar { const j = new Jar(); j.c = new Map(this.c); return j; }
  get headers() { return { ...H, cookie: [...this.c].map(([k, v]) => `${k}=${v}`).join("; ") }; }
}
const signIn = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, key: string) => {
  const r = await http(g.gw.url, "POST", "/auth/key", { headers: jar.headers, body: { key } });
  assert.equal(r.status, 200, r.body);
  jar.take(r);
  return r;
};
const get = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, path: string) => http(g.gw.url, "GET", path, { headers: jar.headers });
const post = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, path: string, body: unknown = {}) => http(g.gw.url, "POST", path, { headers: jar.headers, body });



const patch = (g: Awaited<ReturnType<typeof rig>>, jar: Jar, sid: string, body: unknown) => http(g.gw.url, "PATCH", `/sessions/${encodeURIComponent(sid)}`, { headers: jar.headers, body });
const titleOf = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, sid: string, q = "") =>
  (JSON.parse((await get(g, jar, `/sessions${q}`)).body).sessions as any[]).find((s) => s.id === sid)?.title;
const open = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, title = "New session") => JSON.parse((await post(g, jar, "/sessions", { surface: "web", title })).body).sessionId as string;

test("rename: the new title is trimmed, listed, written to disk and survives a store reload", async () => {
  const g = await rig([{ text: "hello" }]);
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    const sid = await open(g, jar);
    await post(g, jar, `/sessions/${sid}/send`, { text: "first words of the chat" });
    assert.equal(await titleOf(g, jar, sid), "first words of the chat");
    const r = await patch(g, jar, sid, { title: "  Q4 \t plan\n " });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { ok: true, title: "Q4 plan" });
    assert.equal(await titleOf(g, jar, sid), "Q4 plan");
    await new Promise((res) => setTimeout(res, 100)); // persist is a fire-and-forget write
    const reread = createFileStore(g.dir); // a restart: a fresh store scans the files
    assert.equal(reread.load(sid)?.title, "Q4 plan");
    assert.equal(reread.list().find((m) => m.id === sid)?.title, "Q4 plan");
  } finally { await g.close(); }
});

test("rename: the auto title from the first message never replaces a name the user set, even on an empty chat", async () => {
  const g = await rig([{ text: "ok" }, { text: "ok again" }]);
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    const sid = await open(g, jar); // titled "New session" until the first message
    // rename BEFORE the first message, and to the very text the auto title looks for
    assert.equal((await patch(g, jar, sid, { title: "New session" })).status, 200);
    await post(g, jar, `/sessions/${sid}/send`, { text: "this must not become the title" });
    assert.equal(await titleOf(g, jar, sid), "New session");
    assert.equal((await patch(g, jar, sid, { title: "My name" })).status, 200);
    await post(g, jar, `/sessions/${sid}/send`, { text: "and neither must this" });
    assert.equal(await titleOf(g, jar, sid), "My name");
    await new Promise((res) => setTimeout(res, 100));
    const rec = createFileStore(g.dir).load(sid);
    assert.equal(rec?.title, "My name");
    assert.equal(rec?.titleSet, true);
  } finally { await g.close(); }
});

test("rename: an untouched chat still gets its title from the first message (the flag is only set by a rename)", async () => {
  const g = await rig([{ text: "ok" }]);
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    const sid = await open(g, jar);
    await post(g, jar, `/sessions/${sid}/send`, { text: "plan my week" });
    assert.equal(await titleOf(g, jar, sid), "plan my week");
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(createFileStore(g.dir).load(sid)?.titleSet, undefined);
  } finally { await g.close(); }
});

test("rename: validation (empty, blank, control-only, over 80, wrong type) is a 400 and changes nothing", async () => {
  const g = await rig([{ text: "ok" }]);
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    const sid = await open(g, jar);
    await post(g, jar, `/sessions/${sid}/send`, { text: "keep me" });
    for (const bad of ["", "   ", "\u0000\u0007\u001b", "x".repeat(81), 42, null, ["a"], {}]) {
      const r = await patch(g, jar, sid, { title: bad });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} -> ${r.status} ${r.body}`);
    }
    assert.equal(await titleOf(g, jar, sid), "keep me");
    // exactly 80 is fine; control characters inside are stripped
    assert.equal(JSON.parse((await patch(g, jar, sid, { title: "y".repeat(80) })).body).title, "y".repeat(80));
    assert.equal(JSON.parse((await patch(g, jar, sid, { title: "a\u0000b\u001bc" })).body).title, "abc");
    // unknown session
    assert.equal((await patch(g, jar, "no-such-session", { title: "x" })).status, 404);
  } finally { await g.close(); }
});

test("rename: owner-scoped. bob gets 403 on alice's session (live or saved) and an unsigned request is 401", async () => {
  const g = await rig([{ text: "ok" }]);
  try {
    const alice = new Jar(); await signIn(g, alice, g.keys.alice);
    const bob = new Jar(); await signIn(g, bob, g.keys.bob);
    const sid = await open(g, alice);
    await post(g, alice, `/sessions/${sid}/send`, { text: "alice private" });
    assert.equal((await patch(g, bob, sid, { title: "hijacked" })).status, 403);
    assert.equal((await patch(g, new Jar(), sid, { title: "hijacked" })).status, 401);
    assert.equal(await titleOf(g, alice, sid), "alice private");
    // saved-only (not live): a copy of the record under a new id, still alice's
    await new Promise((res) => setTimeout(res, 100));
    const rec = g.sessionStore.load(sid)!;
    await g.sessionStore.save({ ...rec, id: "saved-only-1", title: "old saved" });
    assert.equal((await patch(g, bob, "saved-only-1", { title: "hijacked" })).status, 403);
    assert.equal((await patch(g, alice, "saved-only-1", { title: "renamed saved" })).status, 200);
    assert.equal(await titleOf(g, alice, "saved-only-1"), "renamed saved");
    assert.equal(g.sessionStore.load("saved-only-1")?.titleSet, true);
    assert.equal(g.sessionStore.load("saved-only-1")?.updatedAt, rec.updatedAt, "renaming does not reorder the list");
    assert.equal(g.sessionStore.load(sid)?.title, "alice private");
    assert.ok(!(await titleOf(g, bob, "saved-only-1")) && !(await titleOf(g, bob, sid)), "bob's list never shows them");
  } finally { await g.close(); }
});

test("rename: bot threads too (listed under ?bot=, kept after reload)", async () => {
  const g = await rig([{ text: "ok" }]);
  try {
    const jar = new Jar(); await signIn(g, jar, g.keys.alice);
    const sid = await open(g, jar);
    await post(g, jar, `/sessions/${sid}/send`, { text: "seed" });
    await new Promise((res) => setTimeout(res, 100));
    const rec = g.sessionStore.load(sid)!;
    await g.sessionStore.save({ ...rec, id: "bot-thread-1", title: "Ops chat", bot: "bot-ops" });
    assert.equal(await titleOf(g, jar, "bot-thread-1", "?bot=bot-ops"), "Ops chat");
    const r = await patch(g, jar, "bot-thread-1", { title: "Ops: week 44" });
    assert.equal(r.status, 200, r.body);
    assert.equal(await titleOf(g, jar, "bot-thread-1", "?bot=bot-ops"), "Ops: week 44");
    assert.equal(createFileStore(g.dir).load("bot-thread-1")?.title, "Ops: week 44");
    assert.equal(createFileStore(g.dir).load("bot-thread-1")?.bot, "bot-ops", "still the bot's thread");
  } finally { await g.close(); }
});
