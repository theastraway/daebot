// A computer's own gateway (the desktop app) hands a thread someone shared with the person to daebot.live and streams it back,
// while the person's own chats stay local. Two real gateways in one process (see rig.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedRig, deskRig } from "./rig.ts";
import { parseSse } from "../gateway/helpers.ts";
import { SENDER_MARK } from "../../src/gateway/shared-threads.ts";

test("a desktop sees a shared thread under Shared Threads, reads it, posts into it, and loses it when the owner removes them", async () => {
  const hosted = await hostedRig({ users: ["alice", "bob"], script: [{ text: "the bot answers" }] });
  const desk = await deskRig(hosted, hosted.keys.bob);
  try {
    const alice = await hosted.as(hosted.keys.alice);
    const sid = JSON.parse((await alice("POST", "/sessions", { surface: "web" })).body).sessionId;
    assert.equal((await alice("POST", `/sessions/${sid}/send`, { text: "alice starts the thread" })).status, 200);

    // nothing is shared yet: the desktop's list is empty and it will not open her thread
    assert.deepEqual(JSON.parse((await desk.api("GET", "/shared-threads")).body).threads, []);
    assert.notEqual((await desk.api("GET", `/sessions/${sid}/history`)).status, 200);

    assert.equal((await alice("POST", `/sessions/${sid}/members`, { username: "bob" })).status, 200);

    const list = JSON.parse((await desk.api("GET", "/shared-threads")).body).threads;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, sid);
    assert.equal(list[0].owner.username, "alice");
    assert.equal(JSON.parse((await desk.api("GET", "/sessions")).body).sessions.length, 0, "it is not one of this computer's own chats");

    const hist = await desk.api("GET", `/sessions/${sid}/history`);
    assert.equal(hist.status, 200, hist.body);
    assert.equal(JSON.parse(hist.body).shared.role, "editor");

    const open = await desk.api("POST", "/sessions", { surface: "web", resumeId: sid });
    assert.equal(JSON.parse(open.body).sessionId, sid);
    const sent = await desk.api("POST", `/sessions/${sid}/send`, { text: "bob from his desktop" });
    assert.equal(sent.status, 200, sent.body);
    assert.ok(parseSse(sent.body).some((e) => e.type === "text"));
    const users = (JSON.parse((await alice("GET", `/sessions/${sid}/history`)).body).events as any[]).filter((e) => e.type === "user").map((e) => e.text);
    assert.equal(users.length, 2);
    assert.equal(SENDER_MARK.exec(users[1])?.[1], "bob");
    // the turn ran on daebot.live as alice: nothing of it was written on bob's computer
    assert.equal(desk.store.list().length, 0);

    // owner-only things stay owner-only through the desktop too
    assert.equal((await desk.api("PATCH", `/sessions/${sid}`, { title: "mine" })).status, 403);

    // removed: gone from the desktop within the next request
    assert.equal((await alice("DELETE", `/sessions/${sid}/members/bob`)).status, 200);
    assert.deepEqual(JSON.parse((await desk.api("GET", "/shared-threads")).body).threads, []);
    assert.notEqual((await desk.api("GET", `/sessions/${sid}/history`)).status, 200);
  } finally { await desk.close(); await hosted.gw.close(); await hosted.fake.close(); }
});

test("a desktop owner shares one of their own threads from the desktop: the thread reaches daebot.live first", async () => {
  const hosted = await hostedRig({ users: ["alice", "bob"], script: [{ text: "ok" }] });
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const sid = JSON.parse((await desk.api("POST", "/sessions", { surface: "web" })).body).sessionId;
    assert.equal((await desk.api("POST", `/sessions/${sid}/send`, { text: "from alice's computer" })).status, 200);
    const r = await desk.api("POST", `/sessions/${sid}/members`, { username: "bob" });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body).members.map((m: any) => m.username), ["bob"]);
    const found = await desk.api("GET", "/shared-threads/search?q=bo");
    assert.deepEqual(JSON.parse(found.body).users.map((u: any) => u.username), ["bob"]);
  } finally { await desk.close(); await hosted.gw.close(); await hosted.fake.close(); }
});
