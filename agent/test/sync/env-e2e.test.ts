// Home environments and pins, end to end through two real gateways (the desktop and daebot.live).
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedRig, deskRig, until } from "./rig.ts";
import { rec } from "./helpers.ts";

const MAC = "d_" + "1".repeat(16);

test("a desktop session's home is that desktop on every device; a hosted session's home is MIND Cloud; the lists name the places with online state", async () => {
  const hosted = await hostedRig({ script: [{ text: "hosted reply" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { deviceName: "Anthonys MacBook Pro" });
  try {
    const { sessionId: onMac } = JSON.parse((await desk.api("POST", "/sessions", { surface: "web", title: "from the mac" })).body);
    await desk.api("POST", `/sessions/${onMac}/send`, { text: "hello from the mac" });
    await until(() => hosted.store.load(onMac));
    assert.deepEqual(hosted.store.load(onMac)!.env, { id: MAC, kind: "machine", name: "Anthonys MacBook Pro" }, "stamped when created on the desktop, carried by sync");
    const res = await hosted.host(hosted.keys.alice, "POST", "/api/agent/turn", { text: "typed on the phone", surface: "web" });
    const onCloud = String(res.headers["x-daebot-session"]);
    await until(() => hosted.store.load(onCloud));
    assert.deepEqual(hosted.store.load(onCloud)!.env, { id: "cloud", kind: "cloud", name: "MIND Cloud" });
    await until(() => desk.store.load(onCloud));
    assert.equal(desk.store.load(onCloud)!.env?.kind, "cloud", "the desktop shows the hosted session under MIND Cloud");
    // the desktop UI's list: rows carry their home, envs name the places, the desktop is current
    const dl = JSON.parse((await desk.api("GET", "/sessions")).body);
    assert.equal(dl.sessions.find((s: any) => s.id === onMac).env.id, MAC);
    assert.equal(dl.sessions.find((s: any) => s.id === onCloud).env.id, "cloud");
    const cur = dl.envs.find((e: any) => e.current);
    assert.equal(cur.id, MAC); assert.equal(cur.online, true);
    assert.ok(dl.envs.some((e: any) => e.id === "cloud"));
  } finally { await desk.close(); await hosted.close(); }
});

test("a session from before environments, held by the server, shows as MIND Cloud on the desktop too", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const old = rec("old-1", { surface: "web", title: "an old one", updatedAt: 5000, texts: [["u1", "hi"], ["a1", "yo"]] });
    const res = await hosted.host(hosted.keys.alice, "POST", "/api/sync/sessions", { records: [(({ owner, tier, run, ...w }) => w)(old as any)] });
    assert.equal(JSON.parse(res.body).results[0].status, "ok");
    assert.equal(hosted.store.load("old-1")!.env, undefined);
    await until(() => desk.store.load("old-1")?.env);
    assert.equal(desk.store.load("old-1")!.env!.id, "cloud");
    const hl = JSON.parse((await hosted.as(hosted.keys.alice).then((f) => f("GET", "/sessions"))).body);
    assert.equal(hl.sessions.find((s: any) => s.id === "old-1").env.id, "cloud", "no tag = MIND Cloud on the server's own list");
  } finally { await desk.close(); await hosted.close(); }
});

test("a server device is shown as a server group with its poll-driven online state", async () => {
  const hosted = await hostedRig();
  const drop = await deskRig(hosted, hosted.keys.alice, { deviceId: "d_" + "9".repeat(16), deviceName: "droplet-45", kind: "server" });
  try {
    const { sessionId } = JSON.parse((await drop.api("POST", "/sessions", { surface: "web", title: "on the droplet" })).body);
    await drop.api("POST", `/sessions/${sessionId}/send`, { text: "hi" });
    await until(() => hosted.store.load(sessionId));
    const as = await hosted.as(hosted.keys.alice);
    const l = JSON.parse((await as("GET", "/sessions")).body);
    assert.equal(l.sessions.find((s: any) => s.id === sessionId).env.kind, "server");
    const e = await until(async () => JSON.parse((await as("GET", "/sessions")).body).envs.find((x: any) => x.id === "d_" + "9".repeat(16) && x.online));
    assert.equal(e.name, "droplet-45"); assert.equal(e.kind, "server");
    assert.equal(JSON.parse((await as("GET", "/sessions")).body).envs.find((x: any) => x.current).id, "cloud");
  } finally { await drop.close(); await hosted.close(); }
});

test("pin: PATCH {pinned} saves with the session, syncs both ways, unpin clears it, other users cannot pin it", async () => {
  const hosted = await hostedRig({ script: [{ text: "hosted reply" }] });
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const { sessionId } = JSON.parse((await desk.api("POST", "/sessions", { surface: "web", title: "pin me" })).body);
    await desk.api("POST", `/sessions/${sessionId}/send`, { text: "hi" });
    await until(() => hosted.store.load(sessionId));
    assert.equal((await desk.api("PATCH", `/sessions/${sessionId}`, { pinned: "yes" })).status, 400);
    assert.equal((await desk.api("PATCH", `/sessions/${sessionId}`, { pinned: true })).status, 200);
    await until(() => desk.store.load(sessionId)!.pinnedAt);
    await until(() => hosted.store.load(sessionId)!.pinnedAt);
    const as = await hosted.as(hosted.keys.alice);
    assert.ok(JSON.parse((await as("GET", "/sessions")).body).sessions.find((s: any) => s.id === sessionId).pinnedAt, "the phone and the web see the pin");
    // unpin on the hosted side travels to the desktop
    { const r = await as("PATCH", `/sessions/${sessionId}`, { pinned: false }); assert.equal(r.status, 200, r.body); }
    await until(() => !desk.store.load(sessionId)!.pinnedAt);
    assert.equal(JSON.parse((await desk.api("GET", "/sessions")).body).sessions.find((s: any) => s.id === sessionId).pinnedAt, undefined);
    const bob = await hosted.as(hosted.keys.bob);
    assert.ok([403, 404].includes((await bob("PATCH", `/sessions/${sessionId}`, { pinned: true })).status));
    assert.equal((await as("PATCH", `/sessions/nope-nope`, { pinned: true })).status, 404);
  } finally { await desk.close(); await hosted.close(); }
});

test("a bot with Remote on runs on the computer that carries it; its env and runsOn come from the poll; Remote toggles over PATCH", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice, { deviceName: "Atlas Windows PC" });
  try {
    const as = await hosted.as(hosted.keys.alice);
    const made = JSON.parse((await as("POST", "/bots", { name: "Quinn", purpose: "tests" })).body).bot;
    assert.deepEqual(made.env, { id: "cloud", kind: "cloud", name: "MIND Cloud" }, "a bot made on daebot.live lives in MIND Cloud");
    await until(async () => JSON.parse((await desk.api("GET", "/bots")).body).bots.some((b: any) => b.slug === made.slug));
    const db = JSON.parse((await desk.api("GET", "/bots")).body).bots.find((b: any) => b.slug === made.slug);
    assert.equal(db.runsOn, undefined);
    assert.equal((await desk.api("PATCH", `/bots/${db.id}`, { remote: true })).status, 200);
    const on = await until(async () => { const b = JSON.parse((await as("GET", "/bots")).body).bots.find((x: any) => x.slug === made.slug); return b && b.remote && b.runsOn ? b : null; }, 12000);
    assert.equal(on.env.name, "Atlas Windows PC"); assert.equal(on.env.kind, "machine");
    const list = JSON.parse((await as("GET", "/bots")).body);
    assert.ok(list.envs.some((e: any) => e.name === "Atlas Windows PC" && e.online));
    assert.equal((await as("PATCH", `/bots/${made.id}`, { remote: false })).status, 200);
    const off = JSON.parse((await as("GET", "/bots")).body).bots.find((x: any) => x.slug === made.slug);
    assert.equal(off.remote, false); assert.equal(off.env.id, "cloud");
  } finally { await desk.close(); await hosted.close(); }
});
