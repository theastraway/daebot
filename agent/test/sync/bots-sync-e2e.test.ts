// The same account shows the SAME bots on every device: names, colours, faces, purposes, instructions, pins, order, and the main Daebot's own look.
// Before this only a bot's existence (slug + label) travelled, so the phone and the Mac drifted apart. Now an edit made anywhere reaches everywhere.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedRig, deskRig, until, sleep } from "./rig.ts";
import { canonBot, mergeWireBot, mergeWireMain, sigOf } from "../../src/sync/bots.ts";
import type { WireBot } from "../../src/sync/bots.ts";

type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: string }>;
const J = (r: { body: string }) => JSON.parse(r.body);

/** Everything a person sees about the bot list, field by field, in list order. */
async function view(api: Api): Promise<Record<string, unknown>[]> {
  const bots = J(await api("GET", "/bots")).bots as any[];
  const out: Record<string, unknown>[] = [];
  for (const b of bots) {
    const ins = J(await api("GET", `/bots/${b.id}/instructions`)).text as string;
    out.push({ slug: b.slug, name: b.name, purpose: b.purpose, color: b.color, face: b.face, pinned: b.pinned, instructions: ins });
  }
  return out;
}
const mainView = async (api: Api) => { const m = J(await api("GET", "/settings/daebot")); const i = J(await api("GET", "/settings/daebot/instructions")); return { name: m.name, face: m.face, color: m.color, instructions: i.text }; };

const wire = (o: Partial<WireBot> = {}): WireBot => canonBot({ slug: "scout", name: "Scout", purpose: "", color: "#6366f1", profileAt: 0, pinAt: 0, instructionsAt: 0, createdAt: 100, ...o });

test("merge: per group the later change wins, createdAt is the earlier, it is symmetric and idempotent, and a tie settles the same way on both sides", () => {
  const a = wire({ name: "Old name", profileAt: 10, color: "#111111", createdAt: 50 });
  const b = wire({ name: "New name", profileAt: 20, color: "#222222", pinnedAt: 30, pinAt: 30, instructions: "be brief", instructionsAt: 25, createdAt: 40 });
  const m = mergeWireBot(a, b);
  assert.equal(m.name, "New name"); assert.equal(m.color, "#222222"); assert.equal(m.pinnedAt, 30); assert.equal(m.instructions, "be brief");
  assert.equal(m.createdAt, 40, "the earliest any device saw it");
  assert.deepEqual(mergeWireBot(a, b), mergeWireBot(b, a), "symmetric");
  assert.deepEqual(mergeWireBot(m, m), m, "idempotent");
  assert.deepEqual(mergeWireBot(mergeWireBot(a, b), a), m, "merging an old copy back changes nothing");
  // groups are independent: a rename on one side and a pin on the other both survive
  const rename = wire({ name: "Renamed", profileAt: 5 }), pin = wire({ pinnedAt: 9, pinAt: 9 });
  const both = mergeWireBot(rename, pin);
  assert.equal(both.name, "Renamed"); assert.equal(both.pinnedAt, 9);
  // an unpin that happened AFTER a pin wins
  assert.equal(mergeWireBot(wire({ pinnedAt: 9, pinAt: 9 }), wire({ pinAt: 12 })).pinnedAt, undefined);
  // equal times, different values: both sides pick the same one
  const t1 = wire({ name: "Alpha", profileAt: 7 }), t2 = wire({ name: "Beta", profileAt: 7 });
  assert.equal(mergeWireBot(t1, t2).name, mergeWireBot(t2, t1).name);
  assert.equal(sigOf(mergeWireBot(t1, t2)), sigOf(mergeWireBot(t2, t1)));
  const main = mergeWireMain({ name: "Dae", profileAt: 3, instructionsAt: 0 }, { name: "Daebot", color: "#abcdef", profileAt: 9, instructionsAt: 4, instructions: "x" });
  assert.deepEqual(main, { name: "Daebot", color: "#abcdef", instructions: "x", profileAt: 9, instructionsAt: 4 });
});

test("the same bots on every device: an edit on the Mac reaches daebot.live (the phone) and a second computer, field by field; and the other way round", async () => {
  const hosted = await hostedRig();
  const mac = await deskRig(hosted, hosted.keys.alice, { deviceId: "d_" + "1".repeat(16), deviceName: "Anthonys MacBook Pro" });
  const air = await deskRig(hosted, hosted.keys.alice, { deviceId: "d_" + "2".repeat(16), deviceName: "Macs MacBook Air" });
  try {
    const phone = await hosted.as(hosted.keys.alice);
    // created on the Mac and dressed there
    const bot = J(await mac.api("POST", "/bots", { slug: "scout", name: "Scout", purpose: "Finds things", color: "#14b8a6", face: "analyst", instructions: "Be brief." })).bot;
    await mac.api("PATCH", `/bots/${bot.id}`, { pinned: true });
    await mac.api("PATCH", "/settings/daebot", { name: "Dae", color: "#a855f7" });
    await mac.api("PUT", "/settings/daebot/instructions", { text: "I am Anthony's chief of staff." });
    const want = [{ slug: "scout", name: "Scout", purpose: "Finds things", color: "#14b8a6", face: "analyst", pinned: true, instructions: "Be brief." }];
    await until(async () => JSON.stringify(await view(phone.bind(null) as Api)) === JSON.stringify(want), 12_000);
    await until(async () => JSON.stringify(await view(air.api)) === JSON.stringify(want), 12_000);
    const wantMain = { name: "Dae", face: null, color: "#a855f7", instructions: "I am Anthony's chief of staff." };
    await until(async () => JSON.stringify(await mainView(phone as Api)) === JSON.stringify(wantMain), 12_000);
    await until(async () => JSON.stringify(await mainView(air.api)) === JSON.stringify(wantMain), 12_000);
    // the diff between the three devices is empty
    const [a, b, c] = [await view(mac.api), await view(phone as Api), await view(air.api)];
    assert.deepEqual(b, a); assert.deepEqual(c, a);
    assert.deepEqual(await mainView(mac.api), await mainView(phone as Api));
    // edited on the phone: name, purpose, colour, face, instructions, unpin
    const hb = J(await phone("GET", "/bots")).bots.find((x: any) => x.slug === "scout");
    await phone("PATCH", `/bots/${hb.id}`, { name: "Scout 2", purpose: "Finds more", color: "#ef4444", face: "coach", pinned: false });
    await phone("PUT", `/bots/${hb.id}/instructions`, { text: "Be very brief." });
    await phone("PATCH", "/settings/daebot", { name: "Daebot" });
    const want2 = [{ slug: "scout", name: "Scout 2", purpose: "Finds more", color: "#ef4444", face: "coach", pinned: false, instructions: "Be very brief." }];
    await until(async () => JSON.stringify(await view(mac.api)) === JSON.stringify(want2), 12_000);
    await until(async () => JSON.stringify(await view(air.api)) === JSON.stringify(want2), 12_000);
    await until(async () => (await mainView(mac.api)).name === "Daebot" && (await mainView(air.api)).name === "Daebot", 12_000);
    assert.equal((await mainView(air.api)).color, "#a855f7", "the main Daebot's other fields are kept");
  } finally { await mac.close(); await air.close(); await hosted.close(); }
});

test("two devices edit the same bot: the later edit wins everywhere, and different groups both survive", async () => {
  const hosted = await hostedRig();
  const mac = await deskRig(hosted, hosted.keys.alice, { deviceId: "d_" + "1".repeat(16) });
  const air = await deskRig(hosted, hosted.keys.alice, { deviceId: "d_" + "2".repeat(16), deviceName: "Air" });
  try {
    const phone = await hosted.as(hosted.keys.alice);
    const bot = J(await mac.api("POST", "/bots", { slug: "scout", name: "Scout" })).bot;
    await until(async () => (J(await air.api("GET", "/bots")).bots as any[]).some((b) => b.slug === "scout"));
    await until(async () => (J(await phone("GET", "/bots")).bots as any[]).some((b) => b.slug === "scout"));
    await sleep(700); // let the first exchange settle everywhere
    const ab = J(await air.api("GET", "/bots")).bots.find((b: any) => b.slug === "scout");
    await mac.api("PATCH", `/bots/${bot.id}`, { name: "From the Mac" });
    await sleep(30);
    await air.api("PATCH", `/bots/${ab.id}`, { name: "From the Air later", pinned: true }); // later edit, and a pin
    const final = async (api: Api) => { const b = J(await api("GET", "/bots")).bots.find((x: any) => x.slug === "scout"); return `${b.name}|${b.pinned}`; };
    for (const api of [mac.api, air.api, phone as Api]) await until(async () => (await final(api)) === "From the Air later|true", 12_000);
  } finally { await mac.close(); await air.close(); await hosted.close(); }
});

test("one order on every device: the list sorts by the earliest createdAt any device saw, and pins stay where they are", async () => {
  const hosted = await hostedRig();
  const mac = await deskRig(hosted, hosted.keys.alice, { deviceId: "d_" + "1".repeat(16) });
  const air = await deskRig(hosted, hosted.keys.alice, { deviceId: "d_" + "2".repeat(16), deviceName: "Air" });
  try {
    const phone = await hosted.as(hosted.keys.alice);
    await mac.api("POST", "/bots", { slug: "alpha", name: "Alpha" });
    await sleep(60);
    await air.api("POST", "/bots", { slug: "beta", name: "Beta" });
    await sleep(60);
    await phone("POST", "/bots", { slug: "gamma", name: "Gamma" });
    const order = async (api: Api) => (J(await api("GET", "/bots")).bots as any[]).map((b) => b.slug).join(",");
    for (const api of [mac.api, air.api, phone as Api]) await until(async () => (await order(api)).split(",").length === 3, 12_000);
    await sleep(900);
    const [a, b, c] = [await order(mac.api), await order(air.api), await order(phone as Api)];
    assert.equal(a, "alpha,beta,gamma"); assert.equal(b, a); assert.equal(c, a);
  } finally { await mac.close(); await air.close(); await hosted.close(); }
});

test("a bot MIND does not know is never created by sync, and another user never sees this user's bots or main profile", async () => {
  const hosted = await hostedRig();
  const desk = await deskRig(hosted, hosted.keys.alice);
  try {
    const ghost = canonBot({ slug: "ghost", name: "Ghost", purpose: "", color: "#6366f1", profileAt: 1, pinAt: 0, instructionsAt: 0, createdAt: 1 });
    const r = J(await hosted.host(hosted.keys.alice, "POST", "/api/sync/bots", { bots: [ghost], have: {} }));
    assert.deepEqual(r.unknown, ["ghost"]);
    await desk.api("POST", "/bots", { slug: "scout", name: "Scout" });
    await desk.api("PATCH", "/settings/daebot", { name: "Alice's Dae" });
    await sleep(900);
    const bob = J(await hosted.host(hosted.keys.bob, "POST", "/api/sync/bots", { have: {} }));
    assert.deepEqual(bob.bots, []); assert.equal(bob.main, undefined, "bob has nothing of alice's");
    assert.equal((await hosted.host("mind_nope", "GET", "/api/sync/bots")).status, 401);
    // junk is ignored, never merged
    const junk = J(await hosted.host(hosted.keys.alice, "POST", "/api/sync/bots", { bots: [{ slug: "scout", name: 5, color: "red" }, "x", null], main: { name: 7 }, have: {} }));
    assert.ok(Array.isArray(junk.bots));
    const sc = J(await desk.api("GET", "/bots")).bots.find((b: any) => b.slug === "scout");
    assert.equal(sc.name, "Scout");
  } finally { await desk.close(); await hosted.close(); }
});
