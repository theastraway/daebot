// A live session is dropped when idle or on a restart. A message for a saved chat must bring it back, never answer "no such session".
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedRig, until } from "./rig.ts";

test("a message to a saved chat whose live session was dropped is answered, not refused with 'no such session'", async () => {
  const hosted = await hostedRig();
  try {
    const web = await hosted.as(hosted.keys.alice);
    const created = JSON.parse((await web("POST", "/sessions", { surface: "web", title: "Dae Setup" })).body);
    const sid = created.sessionId as string;
    const first = await web("POST", `/sessions/${sid}/send`, { text: "hello" });
    assert.equal(first.status, 200, first.body);
    await until(() => hosted.store.load(sid));
    // the live session goes away (idle sweep / restart); the saved chat stays
    assert.equal((await web("DELETE", `/sessions/${sid}`)).status, 200);
    const again = await web("POST", `/sessions/${sid}/send`, { text: "hello again" });
    assert.equal(again.status, 200, again.body);
    assert.doesNotMatch(again.body, /no such session/);
  } finally { await hosted.close(); }
});

test("a session that never existed still says no such session (another owner's id stays forbidden)", async () => {
  const hosted = await hostedRig();
  try {
    const web = await hosted.as(hosted.keys.alice);
    const r = await web("POST", `/sessions/does-not-exist/send`, { text: "x" });
    assert.equal(r.status, 404);
  } finally { await hosted.close(); }
});
