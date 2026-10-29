import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/bots/store.ts";
import type { BotMindApi } from "../../src/bots/store.ts";
import { BotError } from "../../src/bots/types.ts";

const bots: any = await import(new URL("../../web/bots.js", import.meta.url).href);
const mfaces: any = await import(new URL("../../web/brand/mfaces.js", import.meta.url).href);
const mbadge: any = await import(new URL("../../web/mbadge.js", import.meta.url).href);
const facesWeb: any = await import(new URL("../../web/faces.js", import.meta.url).href);
const src = (f: string) => readFileSync(new URL(`../../web/${f}`, import.meta.url), "utf8");

test("topThread: the most recently updated thread wins; empty or junk gives null", () => {
  assert.equal(bots.topThread([]), null);
  assert.equal(bots.topThread(undefined), null);
  assert.equal(bots.topThread([null, { nope: 1 }]), null);
  const list = [{ id: "a", updatedAt: 10 }, { id: "c", updatedAt: 30 }, { id: "b", updatedAt: 20 }];
  assert.equal(bots.topThread(list).id, "c");
  assert.equal(bots.topThread([{ id: "x" }, { id: "y", updatedAt: 1 }]).id, "y");
  assert.equal(bots.topThread([{ id: "first", updatedAt: 5 }, { id: "second", updatedAt: 5 }]).id, "first", "a tie keeps the listed order");
});

test("orderBots: pinned first in pin order, the rest keep their order", () => {
  const list = [{ id: "1", name: "A" }, { id: "2", name: "B", pinned: true, pinnedAt: 200 }, { id: "3", name: "C" }, { id: "4", name: "D", pinned: true, pinnedAt: 100 }];
  const { pinned, rest } = bots.orderBots(list);
  assert.deepEqual(pinned.map((b: any) => b.id), ["4", "2"]);
  assert.deepEqual(rest.map((b: any) => b.id), ["1", "3"]);
  assert.deepEqual(bots.orderBots(undefined), { pinned: [], rest: [] });
  assert.deepEqual(bots.orderBots([{ id: "9", name: "Z" }]).pinned, []);
});

test("open/closed thread lists: round-trip per bot; bad stored data is ignored", () => {
  const s = new Set(["b_1", "b_2"]);
  assert.deepEqual([...bots.parseOpen(bots.serializeOpen(s))], ["b_1", "b_2"]);
  assert.equal(bots.parseOpen("not json").size, 0);
  assert.equal(bots.parseOpen('{"a":1}').size, 0);
  assert.deepEqual([...bots.parseOpen('["ok", 5, null]')], ["ok"]);
});

test("face mapping: every bot face has its own LED look, the default fills in, nothing is a letter", () => {
  for (const f of facesWeb.FACES) assert.ok(mfaces.FACE_LOOKS[f.id], `${f.id} has an LED look`);
  assert.equal(Object.keys(mfaces.FACE_LOOKS).length, facesWeb.FACES.length, "no look without a face");
  const seen = new Set(Object.values(mfaces.FACE_LOOKS).map((l) => JSON.stringify(l)));
  assert.equal(seen.size, facesWeb.FACES.length, "no two faces look alike");
  assert.deepEqual(mfaces.faceLook("nope"), mfaces.FACE_LOOKS.operator);
  assert.deepEqual(mfaces.faceLook(undefined), mfaces.FACE_LOOKS.operator);
  assert.equal(mfaces.mascotFace("coach"), "coach");
  assert.equal(mfaces.mascotFace("../x"), mfaces.DEFAULT_FACE);
  assert.equal(mfaces.mascotFace(Object.prototype.toString.name), mfaces.DEFAULT_FACE);
  assert.deepEqual(mbadge.mascotAttrs({ face: "skeptic", color: "#5EE0FF" }), { face: "skeptic", accent: "#5ee0ff" });
  assert.deepEqual(mbadge.mascotAttrs({ color: "javascript:1" }), { face: "operator", accent: "#ffd25a" });
  assert.deepEqual(mbadge.mascotAttrs(null), { face: "operator", accent: "#ffd25a" });
});

test("wiring: bot icons are the M mascot, the click opens the top thread, the chevron only toggles, pin saves via PATCH", () => {
  const b = src("bots.js");
  assert.match(b, /mascotFor/);
  assert.doesNotMatch(b, /faceSvg/, "no line-art face in the bot UI");
  assert.match(b, /topThread\(list\)/);
  assert.match(b, /app\.openThread\(\{ \.\.\.top/);
  assert.match(b, /else app\.newThread\(bot\.id\)/, "a bot with no threads opens a fresh one");
  assert.match(b, /"bot-chev side-icon"/);
  assert.match(b, /chev\.addEventListener\("click", \(\) => toggleThreads\(bot\)\)/);
  assert.match(b, /JSON\.stringify\(\{ pinned \}\)/);
  assert.match(b, /h\("div", "bot-group", "Pinned"\)/);
  assert.match(src("exchanges.js"), /mascotFor/);
  assert.match(src("brand/mbot.js"), /prefers-reduced-motion|matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.doesNotMatch(src("mbadge.js"), /innerHTML/);
});

const mind: BotMindApi = { async list() { return []; }, async create() {}, async remove() {} };
const mk = () => new BotStore({ dir: mkdtempSync(join(tmpdir(), "pin-")), owner: "u1", mind });

test("store: pin persists across a reload, unpin clears it, a pin does not touch updatedAt, junk is a 400", async () => {
  let t = 1000;
  const dir = mkdtempSync(join(tmpdir(), "pin-"));
  const s = new BotStore({ dir, owner: "u1", mind, now: () => t });
  const a = await s.create({ slug: "a" });
  t = 2000;
  const p = s.update(a.id, { pinned: true });
  assert.equal(p.pinnedAt, 2000);
  assert.equal(p.updatedAt, 1000, "pinning is not an edit");
  t = 3000;
  assert.equal(s.update(a.id, { pinned: true }).pinnedAt, 2000, "pinning twice keeps the first time");
  assert.equal(new BotStore({ dir, owner: "u1", mind }).get(a.id)?.pinnedAt, 2000, "follows the user: it is on disk");
  assert.equal(new BotStore({ dir, owner: "u2", mind }).snapshot().length, 0, "another user sees nothing");
  assert.throws(() => s.update(a.id, { pinned: "yes" as any }), (e: any) => e instanceof BotError && e.status === 400);
  const edited = s.update(a.id, { name: "Renamed" });
  assert.equal(edited.pinnedAt, 2000, "an edit keeps the pin");
  assert.equal(edited.updatedAt, 3000);
  const u = s.update(a.id, { pinned: false });
  assert.equal(u.pinnedAt, undefined);
  assert.equal(s.get(a.id)?.pinnedAt, undefined);
  void mk;
});
