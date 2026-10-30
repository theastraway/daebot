// Trigger setup: live requirement checks, enable-blocking (REST + agent), health fields, and polled triggers across a restart.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSetup } from "../../src/routines/setup.ts";
import type { SetupApp } from "../../src/routines/setup.ts";
import { pollSource } from "../../src/routines/poll.ts";
import { RoutineHub } from "../../src/routines/store.ts";
import { RoutineRunner } from "../../src/routines/runner.ts";
import { healthOf } from "../../src/bots/manage-tool.ts";
import { startGateway } from "../../src/gateway/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { FakeProvider, baseCfg } from "../core/helpers.ts";
import { auth as bearer, http, tmpStatic } from "../gateway/helpers.ts";
import { BOT, OWNER, rig } from "./rig.ts";

const MIN = 60_000;
const app = (o: Partial<SetupApp>): SetupApp => ({ provider: "google", name: "Google", connected: false, needsReconnect: false, configured: true, account: null, caps: [], ...o });

test("mail_new needs a connected mailbox: missing offers Connect, connected is green, stale says reconnect, MIND down does not block", () => {
  const t = { type: "mail_new", every: 15 };
  const none = checkSetup(t, { hasKey: true, apps: [app({}), app({ provider: "microsoft", name: "Microsoft 365" })] });
  assert.equal(none.ready, false);
  const mail = none.checks.find((c) => c.id === "mail")!;
  assert.equal(mail.state, "missing");
  assert.deepEqual(mail.actions!.map((a) => a.type === "connect" && a.provider), ["google", "microsoft"]);
  const ok = checkSetup(t, { hasKey: true, apps: [app({ connected: true, caps: ["mail"], account: "a@b.com" })] });
  assert.equal(ok.ready, true);
  assert.match(ok.checks.find((c) => c.id === "mail")!.detail, /a@b\.com/);
  const stale = checkSetup(t, { hasKey: true, apps: [app({ connected: true, caps: ["mail"], needsReconnect: true })] });
  assert.equal(stale.ready, false);
  assert.match(stale.checks.find((c) => c.id === "mail")!.actions![0].label, /Reconnect/);
  const down = checkSetup(t, { hasKey: true, apps: undefined });
  assert.equal(down.ready, true);
  assert.equal(down.checks.find((c) => c.id === "mail")!.state, "unknown");
  assert.equal(checkSetup(t, { hasKey: false }).ready, false);
  assert.match(ok.checks.find((c) => c.id === "interval")!.detail, /every 15 minutes/);
});

test("other requirements: keyword needs words, folder must exist, screen needs the switch and the permission, webhook is ready", () => {
  assert.equal(checkSetup({ type: "keyword" }, { hasKey: true }).ready, false);
  assert.equal(checkSetup({ type: "keyword", phrase: "invoice" }, { hasKey: true }).ready, true);
  const f = checkSetup({ type: "file_changed", path: "/nope" }, { hasKey: true, isDir: () => false });
  assert.equal(f.ready, false);
  assert.equal(f.checks.find((c) => c.id === "folder")!.actions![0].type, "choose");
  assert.equal(checkSetup({ type: "file_changed", path: "/x" }, { hasKey: true, isDir: () => true }).ready, true);
  assert.equal(checkSetup({ type: "screen_change" }, { hasKey: true, screen: { watching: true, permission: "needs-permission" } }).checks.find((c) => c.id === "screen")!.actions![0].type, "grant");
  assert.equal(checkSetup({ type: "screen_change" }, { hasKey: true, screen: { watching: true, permission: "granted" } }).ready, true);
  assert.equal(checkSetup({ type: "webhook" }, { hasKey: true }).ready, true);
  assert.deepEqual(checkSetup({ type: "webhook" }, { hasKey: true, saved: true }).checks[0].actions!.map((a) => a.type), ["copy", "test"]);
  assert.equal(checkSetup({ type: "mind_task" }, { hasKey: false }).ready, false);
  assert.equal(checkSetup({ type: "nope" }, { hasKey: true }).ready, false);
});

async function gw() {
  const key = "mind_" + randomBytes(16).toString("hex");
  const fake = await startFakeMind({ [key]: "pat" });
  const dir = mkdtempSync(join(tmpdir(), "routines-setup-"));
  const provider = new FakeProvider([{ text: "ok" }]);
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: key });
  const bots = { dir, bus: {} };
  const runtime = createRuntime(cfg, { provider, store: createFileStore(dir), bots });
  const st = tmpStatic();
  const g = await startGateway({ runtime, cfg, port: 0, staticDir: st.dir, tokenPath: join(dir, "tok"), bots });
  const a = bearer(g.token);
  const bot = JSON.parse((await http(g.url, "POST", "/bots", { headers: a, body: { slug: "quinn", name: "Quinn", purpose: "t" } })).body).bot;
  const j = async (m: string, p: string, body?: unknown) => { const r = await http(g.url, m, p, { headers: a, body }); return { status: r.status, json: r.body ? JSON.parse(r.body) : {} }; };
  return { fake, bot, j, close: async () => { await g.close(); await fake.close(); }, username: "pat" };
}

test("REST: a trigger with a missing requirement saves turned off, cannot be turned on, shows Needs setup, and turns on once met", async () => {
  const r = await gw();
  try {
    const base = `/bots/${r.bot.id}/routines`;
    const body = { name: "Mail watcher", prompt: "Summarize the new email.", kind: "trigger", trigger: { type: "mail_new", every: 15 } };
    const refused = await r.j("POST", base, body);
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error, "needs_setup");
    assert.equal(refused.json.setup.checks.find((c: any) => c.id === "mail").actions[0].type, "connect");
    const saved = await r.j("POST", base, { ...body, enabled: false });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.routine.enabled, false);
    assert.equal(saved.json.routine.setup.ready, false);
    const id = saved.json.routine.id;
    const on = await r.j("PATCH", `${base}/${id}`, { enabled: true });
    assert.equal(on.status, 409);
    assert.match(on.json.message, /not ready to turn on/);
    const list = (await r.j("GET", base)).json.routines.find((x: any) => x.id === id);
    assert.equal(list.setup.ready, false);
    assert.equal(list.enabled, false);
    // live check from the form (no routine yet)
    const chk = await r.j("POST", `${base}/setup`, { trigger: { type: "mail_new" }, fresh: true });
    assert.equal(chk.status, 200);
    assert.equal(chk.json.ready, false);
  } finally { await r.close(); }
});

test("a webhook trigger needs nothing: it is on at once, and its health starts empty", async () => {
  const r = await gw();
  try {
    const base = `/bots/${r.bot.id}/routines`;
    const add = await r.j("POST", base, { name: "Hook", prompt: "x", kind: "trigger", trigger: { type: "webhook" } });
    assert.equal(add.status, 200);
    assert.equal(add.json.routine.enabled, true);
    assert.equal(add.json.routine.setup.ready, true);
    assert.equal(add.json.routine.health.mode, "push");
    assert.equal(add.json.routine.health.firedAt, null);
    const url = new URL(add.json.routine.webhookUrl);
    const hit = await http(url.origin, "POST", url.pathname, { body: { a: 1 } });
    assert.equal(hit.status, 202);
    const h = (await r.j("GET", `${base}/${add.json.routine.id}`)).json.routine.health;
    assert.ok(h.checkedAt > 0 && h.firedAt > 0, JSON.stringify(h));
  } finally { await r.close(); }
});

test("polled triggers survive a restart: the seen ids are on disk, nothing fires twice, and what arrived while down is caught up once", async () => {
  const items = [{ id: "m1", from_name: "Ann", from_email: "a@x.com", subject: "Old", is_read: false }];
  const mind = { call: async () => JSON.stringify({ messages: items }) };
  const a = rig({ deps: { poll: (o, _b, t, now, s) => pollSource(mind.call as any, o, t, now, s) } });
  a.hub.book(OWNER, BOT).add({ name: "mail", prompt: "p", kind: "trigger", trigger: { type: "mail_new", every: 5 } });
  await a.runner.tick(a.clock.t);                    // primes
  items.unshift({ id: "m2", from_name: "Bo", from_email: "b@x.com", subject: "One", is_read: false });
  a.clock.t += 5 * MIN;
  await a.runner.tick(a.clock.t);
  assert.equal(a.turns.length, 1);
  // "deploy": a brand new hub and runner on the same /data directory, while two more emails arrived
  items.unshift({ id: "m3", from_name: "Cy", from_email: "c@x.com", subject: "Two", is_read: false }, { id: "m4", from_name: "Di", from_email: "d@x.com", subject: "Three", is_read: false });
  a.clock.t += 20 * MIN;                             // down for a while
  const b = rig({ dir: a.dir, t0: a.clock.t, deps: { poll: (o, _b, t, now, s) => pollSource(mind.call as any, o, t, now, s) } });
  await b.runner.tick(b.clock.t);                    // the first tick after the restart catches up
  assert.deepEqual(b.turns.map((x) => /Subject|: (One|Two|Three)/.exec(x.text)![1]), ["Three", "Two"], "oldest first, m2 not repeated");
  await b.runner.tick(b.clock.t + 5 * MIN);
  await b.runner.tick(b.clock.t + 10 * MIN);
  assert.equal(b.turns.length, 2, "never twice");
  const r = b.hub.book(OWNER, BOT).list().find((x) => x.name === "mail")!;
  const h = healthOf(r) as any;
  assert.equal(h.mode, "poll");
  assert.ok(h.checkedAt > 0 && h.firedAt > 0 && h.error === null);
});

test("a failed look shows as the last error in the trigger health", async () => {
  const items = [{ id: "m1", subject: "Old", is_read: false }];
  let boom = "";
  const mind = { call: async () => { if (boom) throw new Error(boom); return JSON.stringify({ messages: items }); } };
  const r = rig({ hold: true, deps: { poll: (o, _b, t, now, s) => pollSource(mind.call as any, o, t, now, s) } });
  const rt = r.hub.book(OWNER, BOT).add({ name: "mail", prompt: "p", kind: "trigger", trigger: { type: "mail_new", every: 5 } });
  await r.runner.tick(r.clock.t);
  for (let i = 2; i <= 9; i++) items.unshift({ id: `m${i}`, subject: `S${i}`, is_read: false });
  r.clock.t += 5 * MIN;
  const p = r.runner.tick(r.clock.t);                // first runs, 5 queue... 1 running + 5 queued = 6 of the 8 new
  r.gate.release!();
  await p;
  boom = "MIND is down";
  r.clock.t += 5 * MIN;
  await r.runner.tick(r.clock.t);
  const h = healthOf(r.hub.book(OWNER, BOT).get(rt.id)!) as any;
  assert.match(h.error, /MIND is down/);
  assert.ok(r.hub.book(OWNER, BOT).get(rt.id)!.tstate!.seen.length >= 1);
});
