// Remote bots end to end: the Remote switch follows the user across devices, and a message sent to a remote bot from daebot.live (the phone or
// the web) runs on the desktop with its own provider, streams back to the sender, and shows on both devices.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedRig, deskRig, until, sleep } from "./rig.ts";
import { parseSse } from "../gateway/helpers.ts";

async function botOnBoth(hosted: Awaited<ReturnType<typeof hostedRig>>, desk: Awaited<ReturnType<typeof deskRig>>, slug = "scout") {
  const bot = JSON.parse((await desk.api("POST", "/bots", { slug, name: "Scout" })).body).bot;
  const web = await hosted.as(hosted.keys.alice);
  const hostBot = await until(async () => JSON.parse((await web("GET", "/bots")).body).bots.find((b: any) => b.slug === slug));
  return { bot, web, hostBot };
}

test("Remote switch: turning it on at the desktop shows on daebot.live (and back), with the change logged", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const { bot, web, hostBot } = await botOnBoth(hosted, desk);
    assert.equal(hostBot.remote, false);
    const on = JSON.parse((await desk.api("PATCH", `/bots/${bot.id}`, { remote: true })).body).bot;
    assert.equal(on.remote, true);
    assert.equal(on.remoteLog.at(-1).by, "user");
    const seen = await until(async () => { const b = JSON.parse((await web("GET", "/bots")).body).bots.find((x: any) => x.slug === "scout"); return b.remote ? b : undefined; });
    assert.equal(seen.remote, true);
    assert.ok(seen.remoteDevices?.some((d: any) => d.name === "Test Mac" && d.online), "daebot.live knows which computer carries it");
    // switched off on the web: the desktop follows
    const off = await web("PATCH", `/bots/${hostBot.id}`, { remote: false });
    assert.equal(JSON.parse(off.body).bot.remote, false);
    await until(async () => JSON.parse((await desk.api("GET", "/bots")).body).bots.find((x: any) => x.slug === "scout").remote === false);
    // a non-boolean is refused
    assert.equal((await desk.api("PATCH", `/bots/${bot.id}`, { remote: "yes" })).status, 400);
  } finally { await desk.close(); await hosted.close(); }
});

test("a message to a remote bot from the web runs on the desktop, streams back, and lands on both devices", async () => {
  const hosted = await hostedRig({ script: [{ text: "SERVER SHOULD NOT ANSWER" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "ran on the desktop" }] });
  try {
    const { bot, web, hostBot } = await botOnBoth(hosted, desk);
    await desk.api("PATCH", `/bots/${bot.id}`, { remote: true });
    await until(async () => JSON.parse((await web("GET", "/bots")).body).bots.find((x: any) => x.slug === "scout").remote);
    const { sessionId } = JSON.parse((await web("POST", "/sessions", { surface: "web", bot: hostBot.id })).body);
    const res = await web("POST", `/sessions/${sessionId}/send`, { text: "do the thing" });
    assert.equal(res.status, 200, res.body);
    const evs = parseSse(res.body) as any[];
    assert.ok(evs.some((e) => e.type === "text" && /ran on the desktop/.test(e.delta)), res.body);
    assert.equal(evs.at(-1).type, "done");
    assert.equal(hosted.provider.requests.length, 0, "the server's model never ran it");
    assert.equal(desk.provider.requests.length, 1, "the desktop's model ran it");
    const local = desk.store.load(sessionId)!;
    assert.ok(local.history.some((e: any) => e.type === "user" && e.text === "do the thing"));
    // the transcript reaches the hosted store via sync, once
    await until(() => hosted.store.load(sessionId)?.history.some((e: any) => e.type === "text" && /ran on the desktop/.test(e.delta)));
    await sleep(400);
    assert.equal(hosted.store.load(sessionId)!.history.filter((e: any) => e.type === "user").length, 1);
    const hist = JSON.parse((await web("GET", `/sessions/${sessionId}/history`)).body);
    assert.ok(hist.events.some((e: any) => e.type === "user" && e.text === "do the thing"));
  } finally { await desk.close(); await hosted.close(); }
});

test("a bot with Remote off (and no desktop involvement) is answered by the server as before", async () => {
  const hosted = await hostedRig({ script: [{ text: "server answered" }] });
  const desk = await deskRig(hosted, hosted.keys.alice, { script: [{ text: "desktop" }] });
  try {
    const { web, hostBot } = await botOnBoth(hosted, desk);
    const { sessionId } = JSON.parse((await web("POST", "/sessions", { surface: "web", bot: hostBot.id })).body);
    const res = await web("POST", `/sessions/${sessionId}/send`, { text: "hi" });
    assert.ok((parseSse(res.body) as any[]).some((e) => e.type === "text" && /server answered/.test(e.delta)));
    assert.equal(desk.provider.requests.length, 0);
  } finally { await desk.close(); await hosted.close(); }
});
