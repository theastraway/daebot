import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedRig, rnd } from "./rig.ts";

test("a second device syncing with another key of the SAME user swaps the key in place; the user's runtime (and its caches) survives", async () => {
  const rig = await hostedRig({ script: [{ text: '{"name":"Alice","line":"Budget is waiting on you.","starters":[{"label":"Budget","prompt":"Help with the budget."}]}' }] });
  try {
    const keyA = rig.keys.alice;
    const keyB = "mind_" + rnd();
    rig.fake.keys.set(keyB, "alice"); // the same MIND user, a second key (another desktop)
    const api = await rig.as(keyA);
    const first = JSON.parse((await api("GET", "/home/brief")).body);
    assert.equal(first.source, "model");
    const calls = rig.provider.requests.length;
    // Device two polls with key B, then device one with key A, back and forth.
    for (const k of [keyB, keyA, keyB]) {
      const r = await rig.host(k, "POST", "/api/sync/device/poll", { deviceId: "dev-" + k.slice(-4), name: "Mac", os: "mac", kind: "machine", wait: 0, bots: [] });
      assert.ok(r.status < 500, r.body);
    }
    const again = JSON.parse((await api("GET", "/home/brief")).body);
    assert.equal(again.line, first.line);
    assert.equal(rig.provider.requests.length, calls, "no rebuild: the cached brief was served, the model was not called again");
  } finally { await rig.close(); }
});
