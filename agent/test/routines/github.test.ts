// GitHub pushes straight to Daebot: signature check, routing by event / repo / branch, dedupe across restarts, the Send test event path.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubEvent, githubWants, sampleGithub, signGithub, verifyGithubSignature } from "../../src/routines/github.ts";
import { RoutineHub } from "../../src/routines/store.ts";
import { startGateway } from "../../src/gateway/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { FakeProvider, baseCfg } from "../core/helpers.ts";
import { auth as bearer, http, tmpStatic } from "../gateway/helpers.ts";
import { BOT, OWNER } from "./rig.ts";

test("signature: only the exact sha256 HMAC of the raw body with the routine's secret passes", () => {
  const body = Buffer.from('{"a":1}');
  const good = signGithub("s3cret", body);
  assert.match(good, /^sha256=[0-9a-f]{64}$/);
  assert.equal(verifyGithubSignature("s3cret", body, good), true);
  assert.equal(verifyGithubSignature("other", body, good), false);
  assert.equal(verifyGithubSignature("s3cret", Buffer.from('{"a":2}'), good), false);
  assert.equal(verifyGithubSignature("s3cret", body, undefined), false);
  assert.equal(verifyGithubSignature("s3cret", body, "sha1=abc"), false);
  assert.equal(verifyGithubSignature("s3cret", body, good.toUpperCase()), false);
  assert.equal(verifyGithubSignature("s3cret", body, good.slice(0, -2)), false);
  assert.equal(verifyGithubSignature(undefined, body, good), false);
  // a known GitHub documentation vector
  assert.equal(signGithub("It's a Secret to Everybody", "Hello, World!"), "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17");
});

test("events: each GitHub event becomes one short line for the right trigger; repo and branch filters apply", () => {
  for (const type of ["gh_issue", "gh_pr", "gh_push", "gh_comment"] as const) {
    const s = sampleGithub(type, "Acme/Site");
    const ev = githubEvent(s.event, JSON.parse(s.body))!;
    assert.equal(ev.type, type);
    assert.equal(ev.repo, "acme/site");
    assert.ok(ev.text.length > 20 && !ev.text.includes("\n\n"), type);
  }
  const push = githubEvent("push", JSON.parse(sampleGithub("gh_push", "a/b", "dev").body))!;
  assert.equal(push.branch, "dev");
  assert.equal(githubWants({ type: "gh_push", branch: "main" }, push), false);
  assert.equal(githubWants({ type: "gh_push", branch: "dev", repo: "a/b" }, push), true);
  assert.equal(githubWants({ type: "gh_push", repo: "x/y" }, push), false);
  assert.equal(githubWants({ type: "gh_issue" }, push), false);
  assert.equal(githubEvent("issues", { action: "closed", repository: { full_name: "a/b" }, issue: {} }), undefined);
  assert.equal(githubEvent("star", { repository: { full_name: "a/b" } }), undefined);
  assert.equal(githubEvent("issues", { action: "opened" }), undefined);
});

async function gw(dir = mkdtempSync(join(tmpdir(), "routines-gh-"))) {
  const key = "mind_" + randomBytes(16).toString("hex");
  const fake = await startFakeMind({ [key]: "pat" });
  const provider = new FakeProvider([{ text: "triaged" }, { text: "triaged" }, { text: "triaged" }]);
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: key });
  const hub = new RoutineHub(dir);
  const bots = { dir, bus: {}, routines: hub };
  const runtime = createRuntime(cfg, { provider, store: createFileStore(dir), bots });
  const st = tmpStatic();
  const g = await startGateway({ runtime, cfg, port: 0, staticDir: st.dir, tokenPath: join(dir, "tok"), bots });
  hub.caps.desktop = false;   // the test gateway runs like a hosted one: GitHub triggers need a public address, desktop ones do not exist
  const a = bearer(g.token);
  let list = JSON.parse((await http(g.url, "GET", "/bots", { headers: a })).body).bots;
  if (!list.length) list = [JSON.parse((await http(g.url, "POST", "/bots", { headers: a, body: { slug: "quinn", name: "Quinn", purpose: "t" } })).body).bot];
  const bot = list[0];
  const j = async (m: string, p: string, body?: unknown) => { const r = await http(g.url, m, p, { headers: a, body }); return { status: r.status, json: r.body ? JSON.parse(r.body) : {} }; };
  const post = (id: string, event: string, body: string, o: { sig?: string | null; delivery?: string; secret?: string } = {}) => {
    const headers: Record<string, string> = { "x-github-event": event, "content-type": "application/json" };
    if (o.delivery) headers["x-github-delivery"] = o.delivery;
    const sig = o.sig === undefined ? signGithub(o.secret ?? "", body) : o.sig;
    if (sig) headers["x-hub-signature-256"] = sig;
    return http(g.url, "POST", `/hooks/gh/${id}`, { headers, body: JSON.parse(body) });   // the helper stringifies: compact JSON round-trips to the same bytes
  };
  return { g, bot, j, post, dir, close: async () => { await g.close(); await fake.close(); } };
}
const until = async (f: () => Promise<boolean>, ms = 4000) => { const t = Date.now(); while (!(await f()) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 40)); };

test("live endpoint: a signed delivery runs the routine once; wrong or missing signature is refused and shown as the last error; a redelivery never runs twice", async () => {
  const r = await gw();
  try {
    const base = `/bots/${r.bot.id}/routines`;
    const add = await r.j("POST", base, { name: "Triage", prompt: "Triage the new issue.", kind: "trigger", trigger: { type: "gh_issue", repo: "Acme/Site" } });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    const rt = add.json.routine;
    assert.match(rt.github.payloadUrl, new RegExp(`/hooks/gh/${rt.id}$`));
    assert.ok(rt.github.secret.length >= 24);
    assert.equal(rt.trigger.repo, "acme/site");
    const sample = sampleGithub("gh_issue", "acme/site");
    const bad = await r.post(rt.id, sample.event, sample.body, { secret: "wrong", delivery: "d0" });
    assert.equal(bad.status, 401);
    assert.equal((await r.post(rt.id, sample.event, sample.body, { sig: null })).status, 401);
    assert.equal((await r.post("r_000000000000", sample.event, sample.body, { secret: "x" })).status, 404);
    let h = (await r.j("GET", `${base}/${rt.id}`)).json.routine.health;
    assert.match(h.error, /wrong signature|without a signature/);
    assert.equal(h.firedAt, null);
    const ok = await r.post(rt.id, sample.event, sample.body, { secret: rt.github.secret, delivery: "d1" });
    assert.equal(ok.status, 202, ok.body);
    await until(async () => ((await r.j("GET", `${base}/${rt.id}`)).json.runs ?? []).some((x: any) => x.status === "ok"));
    const g1 = (await r.j("GET", `${base}/${rt.id}`)).json;
    assert.equal(g1.runs.filter((x: any) => x.status === "ok").length, 1);
    assert.equal(g1.runs.at(-1).source, "gh_issue");
    assert.equal(g1.routine.health.error, null, "a good delivery clears the error");
    assert.ok(g1.routine.health.firedAt > 0 && g1.routine.health.deliveredAt > 0);
    const again = await r.post(rt.id, sample.event, sample.body, { secret: rt.github.secret, delivery: "d1" });
    assert.equal(again.status, 200);
    assert.equal(JSON.parse(again.body).duplicate, true);
    // ping, another repo, an unused event
    assert.equal((await r.post(rt.id, "ping", "{}", { secret: rt.github.secret })).status, 200);
    const other = sampleGithub("gh_issue", "someone/else");
    const o = await r.post(rt.id, other.event, other.body, { secret: rt.github.secret, delivery: "d2" });
    assert.equal(o.status, 202);
    assert.match(JSON.parse(o.body).ignored, /not this routine/);
    // the Send test event button goes through the same signed path and lands in history
    const t = await r.j("POST", `${base}/${rt.id}/test`);
    assert.equal(t.status, 200, JSON.stringify(t.json));
    // (the test sample is for the routine's own repository, so it runs)
    await until(async () => ((await r.j("GET", `${base}/${rt.id}`)).json.runs ?? []).filter((x: any) => x.status === "ok").length >= 2);
    assert.equal(((await r.j("GET", `${base}/${rt.id}`)).json.runs as any[]).filter((x) => x.status === "ok").length, 2);
    // off: refused
    await r.j("PATCH", `${base}/${rt.id}`, { enabled: false });
    const off = await r.post(rt.id, sample.event, sample.body, { secret: rt.github.secret, delivery: "d3" });
    assert.equal(off.status, 409);
    assert.equal((await r.j("POST", `${base}/${rt.id}/test`)).status, 409);
  } finally { await r.close(); }
});

test("a webhook routine's Send test event runs it and records the run", async () => {
  const r = await gw();
  try {
    const base = `/bots/${r.bot.id}/routines`;
    const rt = (await r.j("POST", base, { name: "Hook", prompt: "Say hi.", kind: "trigger", trigger: { type: "webhook" } })).json.routine;
    const t = await r.j("POST", `${base}/${rt.id}/test`);
    assert.equal(t.status, 200, JSON.stringify(t.json));
    await until(async () => ((await r.j("GET", `${base}/${rt.id}`)).json.runs ?? []).some((x: any) => x.status === "ok"));
    const runs = (await r.j("GET", `${base}/${rt.id}`)).json.runs as any[];
    assert.equal(runs.at(-1).source, "webhook");
    assert.equal((await r.j("POST", `${base}/${(await r.j("GET", base)).json.routines.find((x: any) => x.builtin).id}/test`)).status, 400);
  } finally { await r.close(); }
});

test("delivery ids survive a restart: GitHub redelivering the same event after a deploy does not run it again", async () => {
  const r = await gw();
  const base = `/bots/${r.bot.id}/routines`;
  const rt = (await r.j("POST", base, { name: "Triage", prompt: "Triage.", kind: "trigger", trigger: { type: "gh_push" } })).json.routine;
  const sample = sampleGithub("gh_push", "a/b");
  assert.equal((await r.post(rt.id, sample.event, sample.body, { secret: rt.github.secret, delivery: "dX" })).status, 202);
  await until(async () => ((await r.j("GET", `${base}/${rt.id}`)).json.runs ?? []).some((x: any) => x.status === "ok"));
  const dir = r.dir, bot = r.bot.id;
  await r.close();
  const hub = new RoutineHub(dir);
  const owner = [...hub.scan((s) => s)][0]?.owner ?? OWNER;
  assert.equal(hub.book(owner, bot).markDelivery(rt.id, "dX"), false, "already seen on disk");
  assert.equal(hub.book(owner, bot).markDelivery(rt.id, "dY"), true);
  void BOT;
});
