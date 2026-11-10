// Photos and routine runs travel with their chats: a photo attached on one device shows on the others (same id, bytes checked), a photo sent
// to a remote bot is delivered to the desktop and used there, and a routine run's thread shows on daebot.live.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedRig, deskRig, until } from "./rig.ts";
import { parseSse } from "../gateway/helpers.ts";
import { jpeg, png } from "../photos/images.ts";

const dataUrl = (b: Buffer, mime = "image/jpeg") => `data:${mime};base64,${b.toString("base64")}`;

test("a photo attached in a desktop chat is fetchable on daebot.live (same id, same bytes), and only for its owner", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const { sessionId } = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop" })).body);
    const img = jpeg(640, 480, 300);
    const send = await desk.api("POST", `/sessions/${sessionId}/send`, { text: "look at this", photos: [{ name: "cat.jpg", dataUrl: dataUrl(img) }] });
    assert.equal(send.status, 200, send.body);
    const web = await hosted.as(hosted.keys.alice);
    const got = await until(async () => { const r = await web("GET", `/sessions/${sessionId}/photos/p1`); return r.status === 200 ? r : undefined; });
    assert.equal(got!.headers["content-type"], "image/jpeg");
    const list = JSON.parse((await hosted.host(hosted.keys.alice, "GET", `/api/sync/photos/${sessionId}`)).body).photos;
    assert.deepEqual(list.map((p: any) => [p.id, p.name, p.width, p.height, p.bytes]), [["p1", "cat.jpg", 640, 480, img.length]]);
    const dl = JSON.parse((await hosted.host(hosted.keys.alice, "GET", `/api/sync/photos/${sessionId}/p1`)).body);
    assert.equal(Buffer.from(dl.data, "base64").equals(img), true);
    // bob cannot read it, list it, or park a photo under it
    assert.equal((await hosted.host(hosted.keys.bob, "GET", `/api/sync/photos/${sessionId}/p1`)).status, 403);
    assert.equal((await hosted.host(hosted.keys.bob, "GET", `/api/sync/photos/${sessionId}`)).status, 403);
    assert.equal((await hosted.host(hosted.keys.bob, "POST", `/api/sync/photos/${sessionId}/p2`, { meta: { ...list[0], id: "p2" }, data: img.toString("base64") })).status, 403);
    // a junk image is refused
    assert.equal((await hosted.host(hosted.keys.alice, "POST", `/api/sync/photos/${sessionId}/p9`, { meta: { ...list[0], id: "p9" }, data: Buffer.from("not an image").toString("base64") })).status, 400);
    assert.equal((await hosted.host(hosted.keys.alice, "POST", `/api/sync/photos/no-such-session/p1`, { meta: list[0], data: img.toString("base64") })).status, 404);
  } finally { await desk.close(); await hosted.close(); }
});

test("a photo sent on daebot.live (web or phone) reaches the desktop chat with the bytes", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const web = await hosted.as(hosted.keys.alice);
    const { sessionId } = JSON.parse((await web("POST", "/sessions", { surface: "web" })).body);
    const img = png(300, 200, 100);
    const res = await web("POST", `/sessions/${sessionId}/send`, { text: "from the phone", photos: [{ name: "shot.png", dataUrl: dataUrl(img, "image/png") }] });
    assert.equal(res.status, 200, res.body);
    await until(() => desk.store.load(sessionId));
    const local = await until(async () => { const r = await desk.api("GET", `/sessions/${sessionId}/photos/p1`); return r.status === 200 ? r : undefined; });
    assert.equal(local!.headers["content-type"], "image/png");
    assert.ok(desk.store.load(sessionId)!.history.some((e: any) => e.type === "user" && e.photos?.[0]?.id === "p1"));
  } finally { await desk.close(); await hosted.close(); }
});

test("a photo sent to a REMOTE bot from the phone is delivered to the desktop and used there (no 409)", async () => {
  const hosted = await hostedRig({ script: [{ text: "SERVER SHOULD NOT ANSWER" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "I see the photo on the desktop" }] });
  try {
    const bot = JSON.parse((await desk.api("POST", "/bots", { slug: "scout", name: "Scout" })).body).bot;
    const web = await hosted.as(hosted.keys.alice);
    const hostBot = await until(async () => JSON.parse((await web("GET", "/bots")).body).bots.find((b: any) => b.slug === "scout" && b.remoteDevices?.length));
    await desk.api("PATCH", `/bots/${bot.id}`, { remote: true });
    await until(async () => JSON.parse((await web("GET", "/bots")).body).bots.find((x: any) => x.slug === "scout").remote);
    const { sessionId } = JSON.parse((await web("POST", "/sessions", { surface: "ios", bot: hostBot.id })).body);
    const img = jpeg(800, 600, 500);
    const res = await web("POST", `/sessions/${sessionId}/send`, { text: "what is this?", photos: [{ name: "thing.jpg", dataUrl: dataUrl(img) }] });
    assert.equal(res.status, 200, res.body);
    const evs = parseSse(res.body) as any[];
    assert.ok(evs.some((e) => e.type === "photos" && e.photos[0].id === "p1"), "the sender's feed names the photo");
    assert.ok(evs.some((e) => e.type === "text" && /I see the photo on the desktop/.test(e.delta)), res.body);
    assert.equal(hosted.provider.requests.length, 0, "the server's model never ran it");
    // the desktop got the bytes under the same id and told its model about the photo
    const local = await desk.api("GET", `/sessions/${sessionId}/photos/p1`);
    assert.equal(local.status, 200);
    const asked = desk.provider.requests[0].messages.filter((m) => m.role === "user").at(-1)!.content;
    assert.match(asked, /\[photo p1: thing\.jpg, 800x600\]/);
    assert.ok(desk.store.load(sessionId)!.history.some((e: any) => e.type === "user" && e.photos?.[0]?.id === "p1"));
  } finally { await desk.close(); await hosted.close(); }
});

test("deleting the chat deletes its photos on both sides", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const { sessionId } = JSON.parse((await desk.api("POST", "/sessions", { surface: "desktop" })).body);
    await desk.api("POST", `/sessions/${sessionId}/send`, { text: "pic", photos: [{ name: "a.jpg", dataUrl: dataUrl(jpeg(10, 10)) }] });
    const web = await hosted.as(hosted.keys.alice);
    await until(async () => (await web("GET", `/sessions/${sessionId}/photos/p1`)).status === 200);
    assert.equal((await desk.api("DELETE", `/sessions/${sessionId}?purge=1`)).status, 200);
    await until(async () => (await web("GET", `/sessions/${sessionId}/photos/p1`)).status !== 200);
    assert.equal((await desk.api("GET", `/sessions/${sessionId}/photos/p1`)).status !== 200, true);
  } finally { await desk.close(); await hosted.close(); }
});

test("a routine run on the desktop: its thread shows on daebot.live with the output", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "routine output: all quiet" }] });
  try {
    const bot = JSON.parse((await desk.api("POST", "/bots", { slug: "quinn", name: "Quinn" })).body).bot;
    const add = JSON.parse((await desk.api("POST", `/bots/${bot.id}/routines`, { name: "Morning", prompt: "Report.", kind: "timed", timing: { expression: "0 9 * * 1-5", tz: "America/New_York" } })).body).routine;
    const run = await desk.api("POST", `/bots/${bot.id}/routines/${add.id}/run`);
    assert.equal(run.status, 200, run.body);
    const row = await until(async () => {
      const r = JSON.parse((await hosted.host(hosted.keys.alice, "GET", "/api/sync/sessions?since=0")).body);
      return r.rows.find((x: any) => x.title === "Routine: Morning");
    });
    const got = JSON.parse((await hosted.host(hosted.keys.alice, "GET", `/api/sync/sessions/${row.id}`)).body).session;
    assert.equal(got.surface, "routine");
    assert.ok(got.history.some((e: any) => e.type === "text" && /routine output: all quiet/.test(e.delta)));
    const web = await hosted.as(hosted.keys.alice);
    const hb = JSON.parse((await web("GET", "/bots")).body).bots.find((b: any) => b.slug === "quinn");
    const list = JSON.parse((await web("GET", `/sessions?bot=${hb.id}`)).body).sessions;
    assert.ok(list.some((s: any) => s.id === row.id), "it is in the hosted session list the phone shows");
  } finally { await desk.close(); await hosted.close(); }
});
