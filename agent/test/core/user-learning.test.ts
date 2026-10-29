import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthContext } from "../../src/auth/index.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { userIdFor } from "../../src/auth/users.ts";
import { createRuntime } from "../../src/runtime.ts";
import { CLASSES } from "../../src/eval/learning/classes.ts";
import { reflectorFor } from "../../src/eval/learning/harness.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { baseCfg, collect } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex");
const brevity = CLASSES[0];

async function world() {
  const keys = { boss: "mind_" + rnd(), boss2: "mind_" + rnd(), alice: "mind_" + rnd() };
  const serverKey = "server-owner-key-" + rnd();
  const fake = await startFakeMind({ [serverKey]: "owner_test", [keys.boss]: "boss", [keys.boss2]: "boss2", [keys.alice]: "alice" });
  // The reflector is shared by every runtime; it writes the same lesson wherever it is asked.
  const provider = reflectorFor(CLASSES);
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: serverKey });
  const globalCap = new DailyCostCap(50);
  const ownerRuntime = createRuntime(cfg, { provider, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true, username: "owner_test" } });
  const env = { DATA_DIR: mkdtempSync(join(tmpdir(), "daebot-learn-")), DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "boss,boss2", MIND_OAUTH_BASE_URL: fake.url };
  const auth = createAuthContext({ env, cfg, hosted: { token: rnd(), allowedHosts: ["daebot.live"] }, ownerRuntime, globalCap, provider });
  const principal = (name: keyof typeof keys) => {
    auth.store.upsert(name, { kind: "key", mindKey: keys[name] });
    return auth.store.principal(userIdFor(name))!;
  };
  // one chat that makes a mistake and gets corrected -> a lesson + user model are written
  const learnIn = async (rt: ReturnType<typeof auth.runtimeFor>) => {
    const s = await rt.openSession({ surface: "web" });
    await collect(s.send(brevity.session1));
    await collect(s.send(brevity.correction));
    await s.close("done");
  };
  const writes = (key: string) => fake.seen.filter((x) => x.key === key && x.method !== "GET" && JSON.stringify(x.body ?? "").includes("daebot-learning"));
  return { fake, keys, auth, principal, learnIn, writes, ownerRuntime, close: () => fake.close() };
}

test("learning is per user: admin A's lessons and user model go to A's own MIND only, never B's or the server's", async () => {
  const w = await world();
  try {
    const A = w.principal("boss");
    const B = w.principal("boss2");
    await w.learnIn(w.auth.runtimeFor(A));
    const mine = w.writes(w.keys.boss);
    assert.ok(mine.length >= 1, "A's lesson was written to A's MIND");
    assert.ok(mine.some((x) => JSON.stringify(x.body).includes("Short chat replies")), "the lesson itself");
    assert.ok(mine.some((x) => /user: boss\b/.test(JSON.stringify(x.body))), "the user model is filed under A's MIND username");
    // nothing of A's reached B's MIND or the server's key
    assert.equal(w.writes(w.keys.boss2).length, 0);
    assert.ok(!w.fake.seen.some((x) => x.key.startsWith("server-owner-key-")));
    assert.ok(!w.fake.seen.some((x) => x.key === w.keys.boss2 && JSON.stringify(x.body ?? "").includes("Short chat replies")));

    // now B teaches in B's own session: it lands in B's MIND, under B's username, and not in A's
    const aBefore = w.writes(w.keys.boss).length;
    await w.learnIn(w.auth.runtimeFor(B));
    const theirs = w.writes(w.keys.boss2);
    assert.ok(theirs.some((x) => /user: boss2\b/.test(JSON.stringify(x.body))), "B's model is under B's username");
    assert.ok(!theirs.some((x) => /user: boss\b(?!2)/.test(JSON.stringify(x.body))), "A's username never appears in B's writes");
    assert.equal(w.writes(w.keys.boss).length, aBefore, "B's lesson did not touch A's MIND");
  } finally { await w.close(); }
});

test("learning is admin-only for now: a staff user's corrections write nothing anywhere", async () => {
  const w = await world();
  try {
    const alice = w.principal("alice");
    assert.equal(alice.tier, "staff");
    await w.learnIn(w.auth.runtimeFor(alice));
    assert.equal(w.fake.seen.filter((x) => x.method !== "GET" && JSON.stringify(x.body ?? "").includes("daebot-learning")).length, 0);
  } finally { await w.close(); }
});

test("owner-code runtime learns as owner_test on the server key", async () => {
  const w = await world();
  try {
    await w.learnIn(w.ownerRuntime);
    const serverWrites = w.fake.seen.filter((x) => x.key.startsWith("server-owner-key-") && x.method !== "GET" && JSON.stringify(x.body ?? "").includes("daebot-learning"));
    assert.ok(serverWrites.some((x) => /user: owner_test\b/.test(JSON.stringify(x.body))), "user model uses the owner's MIND username");
  } finally { await w.close(); }
});
