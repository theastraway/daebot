import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, MAX_ACCOUNTS, dataDirFor } from "../src/lib/accounts.mjs";
import { buildSpawnPlan } from "../src/lib/launcher.mjs";

const K1 = "mind_TESTKEY_aaaaaaaaaaaa"; // throwaway test values
const K2 = "mind_TESTKEY_bbbbbbbbbbbb";
const K3 = "mind_TESTKEY_cccccccccccc";
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "dae-acct-")); return { dir, store: new AccountStore(join(dir, "nested", "accounts.json")) }; };

test("accounts file is private (0600 in 0700), atomic, and the public list never carries a key", () => {
  const { dir, store } = fresh();
  store.add({ key: K1, name: "ann" });
  const p = join(dir, "nested", "accounts.json");
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(dir, "nested")), ["accounts.json"]);
  const pub = store.publicList();
  assert.deepEqual(pub.map((a) => Object.keys(a).sort()), [["active", "id", "name"]]);
  assert.ok(!JSON.stringify(pub).includes(K1));
  assert.ok(readFileSync(p, "utf8").includes(K1), "the key itself lives only in the private file");
});

test("add several accounts, switch between them, active follows the last add and each switch", () => {
  const { store } = fresh();
  const a = store.add({ key: K1, name: "ann" });
  const b = store.add({ key: K2, name: "bob" });
  assert.equal(store.active().id, b.id);
  assert.deepEqual(store.publicList().map((x) => [x.name, x.active]), [["ann", false], ["bob", true]]);
  assert.equal(store.switchTo(a.id).key, K1);
  assert.equal(store.active().name, "ann");
  assert.equal(store.switchTo("a_nope"), undefined, "an unknown id never changes the active account");
  assert.equal(store.active().name, "ann");
});

test("the same key, or the same username with a rotated key, is one account", () => {
  const { store } = fresh();
  store.add({ key: K1, name: "ann" });
  store.add({ key: K1, name: "ann" });
  store.add({ key: K3, name: "ANN" });
  const list = store.publicList();
  assert.equal(list.length, 1);
  assert.equal(store.active().key, K3);
});

test("remove: signing out the active account hands over to a remaining one; the last removal leaves none", () => {
  const { store } = fresh();
  const a = store.add({ key: K1, name: "ann" });
  const b = store.add({ key: K2, name: "bob" });
  const next = store.remove(b.id);
  assert.equal(next.id, a.id);
  assert.equal(store.remove(a.id), undefined);
  assert.deepEqual(store.publicList(), []);
});

test("garbage keys are refused without echoing them; a corrupt file reads as no accounts", () => {
  const { dir, store } = fresh();
  assert.throws(() => store.add({ key: "mind_bad key", name: "x" }), (e) => !String(e.message).includes("mind_bad key"));
  new AccountStore(join(dir, "broken.json")).save({ v: 1, active: "x", accounts: [{ key: "nope" }, { key: K1, name: "ann" }] });
  assert.deepEqual(new AccountStore(join(dir, "broken.json")).publicList().map((x) => x.name), ["ann"]);
  assert.deepEqual(new AccountStore(join(dir, "missing.json")).publicList(), []);
});

test("capped at MAX_ACCOUNTS", () => {
  const { store } = fresh();
  for (let i = 0; i < MAX_ACCOUNTS; i++) store.add({ key: `mind_TESTKEY_${String(i).padStart(12, "x")}`, name: `u${i}` });
  assert.throws(() => store.add({ key: "mind_TESTKEY_overflowoverflow", name: "extra" }), /up to/);
});

test("isolation: each account has its own data directory; only the legacy one keeps the default", () => {
  const env = { MINDCLAW_DESKTOP_HOME: "/h" };
  const { store } = fresh();
  const legacy = store.add({ key: K1, name: "ann", legacy: true });
  const other = store.add({ key: K2, name: "bob" });
  const byId = Object.fromEntries(store.load().accounts.map((a) => [a.id, a]));
  assert.equal(dataDirFor(byId[legacy.id], env), undefined);
  assert.equal(dataDirFor(byId[other.id], env), `/h/accounts/${other.id}/data`);
  assert.notEqual(dataDirFor(byId[other.id], env), dataDirFor({ ...byId[other.id], id: "a_other" }, env));
});

test("a signed-out legacy owner who signs back in reclaims the default data directory (their chats come back)", () => {
  const { store } = fresh();
  const a = store.add({ key: K1, name: "ann", legacy: true });
  store.add({ key: K2, name: "bob" });
  store.remove(a.id);
  const again = store.add({ key: K3, name: "Ann" }); // new key, same person
  assert.equal(again.legacy, true);
  const stranger = store.add({ key: "mind_TESTKEY_dddddddddddd", name: "carl" });
  assert.equal(stranger.legacy, false);
});

test("spawn plan: DATA_DIR is set for a non-legacy account and left alone otherwise; the key only goes into the child env", () => {
  const base = { agentRoot: "/a", entry: "/a/e.mjs", kernelMode: "enforced", nodePath: "/usr/bin/node", electronPath: "/e", baseEnv: {} };
  const p = buildSpawnPlan({ ...base, mindKey: K2, dataDir: "/h/accounts/a_x/data" });
  assert.equal(p.env.DATA_DIR, "/h/accounts/a_x/data");
  assert.equal(p.env.MIND_API_KEY, K2);
  assert.ok(!JSON.stringify(p.args).includes(K2));
  assert.equal(buildSpawnPlan({ ...base, mindKey: K1 }).env.DATA_DIR, undefined);
});
