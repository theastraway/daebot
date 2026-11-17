// Your database (MIND's database bridge) through the gateway: the signed-in user's MIND key on every call, the password only ever
// travels to MIND, and MIND's "not available" answers as a plain state, not an error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { http } from "./helpers.ts";
import { rig } from "./byo-llm.test.ts";
import { cleanDbBody } from "../../src/gateway/bridges.ts";

const H = { host: "daebot.live", "x-forwarded-proto": "https" };
const PW = "pg-PASSWORD-s3cret!";

test("cleanDbBody: host without a scheme, port 1..65535, ssl modes, the password passes through untouched", () => {
  assert.deepEqual(cleanDbBody({ host: " db.example.com ", port: "5433", database: "mind", user: "u", password: PW, ssl: "verify-full" }), { body: { host: "db.example.com", port: 5433, ssl: "verify-full", database: "mind", user: "u", password: PW } });
  assert.deepEqual(cleanDbBody({ host: "db.example.com" }), { body: { host: "db.example.com", port: 5432, ssl: "require" } });
  assert.deepEqual(cleanDbBody({ host: "db.example.com", ssl: false }), { body: { host: "db.example.com", port: 5432, ssl: "disable" } });
  assert.ok("error" in cleanDbBody({ host: "https://db.example.com" }));
  assert.ok("error" in cleanDbBody({ host: "" }));
  assert.ok("error" in cleanDbBody({ host: "db", port: 70000 }));
  assert.ok("error" in cleanDbBody({ host: "db", ssl: "maybe" }));
});

test("signed out: a hosted gateway answers 401 before the handler; nothing reaches MIND", async () => {
  const r = await rig();
  try {
    assert.equal((await http(r.gw.url, "GET", "/bridges", { headers: H })).status, 401);
    assert.equal((await http(r.gw.url, "PUT", "/bridges/db", { headers: H, body: { host: "db.example.com", password: PW } })).status, 401);
    assert.equal((await http(r.gw.url, "POST", "/bridges/db/test", { headers: H, body: { host: "db.example.com" } })).status, 401);
    assert.equal(r.fake.bridges.seen.length, 0);
  } finally { await r.close(); }
});

test("test, save, bootstrap, verify, remove: the user's own MIND key; the password goes to MIND and never comes back", async () => {
  const r = await rig();
  try {
    const alice = await r.cookie(r.keys.alice);
    const st0 = JSON.parse((await http(r.gw.url, "GET", "/bridges", { headers: alice })).body);
    assert.equal(st0.feature_available, true);
    assert.equal(st0.db.mode, "cloud");

    const bad = await http(r.gw.url, "POST", "/bridges/db/test", { headers: alice, body: { host: "http://db.example.com" } });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).ok, false);

    const t = await http(r.gw.url, "POST", "/bridges/db/test", { headers: alice, body: { host: "db.example.com", port: 5432, database: "mind", user: "mind", password: PW, ssl: "require" } });
    assert.equal(t.status, 200, t.body);
    assert.equal(JSON.parse(t.body).ok, true);
    assert.equal(JSON.parse(t.body).pgvector, true);

    const s = await http(r.gw.url, "PUT", "/bridges/db", { headers: alice, body: { host: "db.example.com", database: "mind", user: "mind", password: PW } });
    assert.equal(s.status, 200, s.body);
    const sj = JSON.parse(s.body);
    assert.equal(sj.db.configured, true);
    assert.equal(sj.db.password_set, true);
    assert.equal(sj.bootstrap.schema, "mind_user");
    assert.doesNotMatch(s.body, new RegExp(PW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the password is never echoed");

    const seen = r.fake.bridges.seen;
    assert.ok(seen.every((c) => c.key === r.keys.alice), "every call carries the signed-in user's key");
    const put = seen.find((c) => c.method === "PUT")!;
    assert.equal(put.body.password, PW, "MIND gets the password in the body");
    assert.equal(put.body.port, 5432);
    assert.equal(put.body.ssl, "require");

    const b = await http(r.gw.url, "POST", "/bridges/db/bootstrap", { headers: alice, body: {} });
    assert.equal(b.status, 200);
    assert.deepEqual(JSON.parse(b.body).bootstrap.skipped, ["entries"]);
    const v = await http(r.gw.url, "POST", "/bridges/db/verify-routing", { headers: alice, body: {} });
    assert.equal(JSON.parse(v.body).routing_check.ok, true);

    const d = await http(r.gw.url, "DELETE", "/bridges/db", { headers: alice });
    assert.equal(d.status, 200);
    assert.equal(JSON.parse(d.body).db.mode, "cloud");
  } finally { await r.close(); }
});

test("MIND without the bridge feature: status is feature_available:false and a save answers 200 with that state, not a 502", async () => {
  const r = await rig();
  try {
    r.fake.bridges.available = false;
    const alice = await r.cookie(r.keys.alice);
    assert.equal(JSON.parse((await http(r.gw.url, "GET", "/bridges", { headers: alice })).body).feature_available, false);
    const s = await http(r.gw.url, "PUT", "/bridges/db", { headers: alice, body: { host: "db.example.com", password: PW } });
    assert.equal(s.status, 200);
    assert.equal(JSON.parse(s.body).feature_available, false);
    assert.match(JSON.parse(s.body).message, /not available/i);
  } finally { await r.close(); }
});
