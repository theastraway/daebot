import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioStore, migrateAllLayouts } from "../../src/studio/store.ts";
import { StudioBuilder } from "../../src/studio/builder.ts";
import { SLOTS, LAYOUT_SCHEMA, RENDERER_VERSION, applyEdit, applyModelPlan, migrateLayout, rulesLayout, validLayout, findIsland, INNER_SLOTS } from "../../src/studio/layout.ts";
import type { LayoutBot } from "../../src/studio/layout.ts";
import { assembleStudio } from "../../src/studio/index.ts";

const dir = () => mkdtempSync(join(tmpdir(), "studio-layout-"));
const B = (id: string, name: string, department?: string): LayoutBot => ({ id, name, ...(department ? { department } : {}) });

test("the builder builds an account's office from scratch on the first open: one island per department, General for the rest, the Manager office on top", async () => {
  const d = dir();
  const store = new StudioStore({ dir: d, owner: "u1" });
  const bots = [B("b1", "Scout", "Sales"), B("b2", "Closer", "Sales"), B("b3", "Ledger", "Finance"), B("b4", "Helper")];
  let plans = 0;
  const builder = new StudioBuilder({ store, bots: async () => bots, now: () => 1000, planner: async () => { plans++; return JSON.stringify({ islands: [{ name: "Ops", members: ["b4"], color: "teal", stats: ["sessions", "waiting"], nearBrain: true }, { name: "Sales", color: "pink", stats: ["messages", "today"] }] }); } });
  assert.equal(store.rawLayout(), undefined);
  const first = await builder.current();
  assert.deepEqual(first.islands.map((i) => i.slug).sort(), ["finance", "general", "manager-office", "sales"]);
  assert.equal(first.islands.find((i) => i.slug === "manager-office")!.slot, 0);
  assert.ok(store.rawLayout(), "the layout is stored for the account");
  // The model plan follows in the background: the bot with no department lands on the model's island, a department keeps its own.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(plans, 1);
  const after = validLayout(store.rawLayout())!;
  assert.equal(after.builtBy, "model");
  assert.equal(after.desks.b4, "ops");
  const ops = after.islands.find((i) => i.slug === "ops")!;
  assert.ok(ops.slot > 0 && ops.slot < INNER_SLOTS, "nearBrain puts it on the inner ring");
  assert.equal(after.islands.find((i) => i.slug === "sales")!.color, "pink");
  assert.ok(!after.islands.some((i) => i.slug === "general"), "General is gone once nobody sits there");
  // A second store over the same files reads the same layout (it is per account, on disk).
  assert.deepEqual(validLayout(new StudioStore({ dir: d, owner: "u1" }).rawLayout())!.islands.map((i) => i.slug).sort(), ["finance", "manager-office", "ops", "sales"]);
});

test("a new bot gets its desk without a manual step, a deleted bot's desk goes, and the user's edits survive", async () => {
  const store = new StudioStore({ dir: dir(), owner: "u2" });
  const bots: LayoutBot[] = [B("b1", "Scout", "Sales")];
  const builder = new StudioBuilder({ store, bots: async () => bots, now: () => 2000 });
  await builder.current();
  await builder.edit({ op: "rename", island: "the sales island", name: "Revenue" });
  bots.push(B("b2", "Auditor", "Compliance"), B("b3", "Rep", "Sales"));
  const l = await builder.current();
  assert.ok(l.islands.some((i) => i.slug === "compliance"), "the new department's island appears by itself");
  assert.equal(l.islands.find((i) => i.slug === "sales")!.name, "Revenue", "the rename is kept");
  const view = assembleStudio({ main: { name: "Dae" }, bots: bots.map((b) => ({ id: b.id, slug: b.id, name: b.name, department: b.department })), sessions: [], rows: [], pending: [], exchanges: [], chip: { mode: "off", model: "m" }, now: 3000, layout: l });
  assert.deepEqual(view.departments.find((d) => d.slug === "sales")!.bots.sort(), ["b1", "b3"]);
  assert.deepEqual(view.departments.find((d) => d.slug === "compliance")!.bots, ["b2"]);
  assert.equal(view.departments.find((d) => d.slug === "sales")!.name, "Revenue");
  assert.equal(view.departments.find((d) => d.slug === "sales")!.stats.length, 2);
  // create_many / delete_many: several bots arrive and leave at once.
  bots.splice(0, bots.length, B("b3", "Rep", "Sales"), B("b4", "X"), B("b5", "Y"), B("b6", "Z", "Design"));
  const l2 = await builder.current();
  assert.ok(!l2.islands.some((i) => i.slug === "compliance"), "an island with no bots left goes");
  assert.ok(l2.islands.some((i) => i.slug === "general") && l2.islands.some((i) => i.slug === "design"));
  assert.ok(!l2.seen.includes("b1") && l2.seen.includes("b6"));
  // "move Ops next to the Brain", "add a Compliance department", "move Rep to Design" all stick through a rebuild.
  await builder.edit({ op: "add", name: "Compliance", nearBrain: true });
  await builder.edit({ op: "move", island: "design", to: "brain" });
  await builder.edit({ op: "move_bot", bot: "rep", island: "Compliance" });
  const l3 = await builder.rebuild();
  assert.ok(l3.islands.some((i) => i.slug === "compliance" && i.source === "user"));
  assert.ok(l3.islands.find((i) => i.slug === "design")!.slot < INNER_SLOTS);
  assert.equal(l3.desks.b3, "compliance");
  assert.equal(l3.islands.find((i) => i.slug === "sales"), undefined, "Revenue had nobody left once Rep moved");
  await assert.rejects(builder.edit({ op: "rename", island: "nowhere", name: "x" }), /no island/);
});

test("a schema or renderer bump migrates every stored layout by itself: on boot (the sweep) and on first read", async () => {
  const d = dir();
  const old = { v: 1, renderer: "floor-0", builtAt: 1, updatedAt: 1, builtBy: "rules", islands: [{ slug: "manager-office", name: "Manager office", color: "green", slot: 0 }, { slug: "sales", name: "Sales", color: "pink", slot: 3, locked: { name: true, slot: true } }, { slug: "ops", name: "Ops", color: "teal", slot: 1 }, { slug: "hr", name: "HR", color: "cyan", slot: 2 }], desks: {}, pinned: [], seen: ["b1"] };
  writeFileSync(join(d, "u3.json"), JSON.stringify({ v: 1, counters: {}, pipelines: {}, layout: old }));
  writeFileSync(join(d, "u4.json"), JSON.stringify({ v: 1, counters: {}, pipelines: {} }));
  const sweep = migrateAllLayouts(d, 5000);
  assert.deepEqual(sweep, { files: 2, migrated: 1 });
  const j = JSON.parse(readFileSync(join(d, "u3.json"), "utf8"));
  assert.equal(j.layout.v, LAYOUT_SCHEMA);
  assert.equal(j.layout.renderer, RENDERER_VERSION);
  assert.equal(j.layout.rooms.length, 7, "v2 added the rooms list");
  assert.equal(j.layout.islands[1].stats.length, 2, "v2 added the card stats");
  const at = (slug: string) => SLOTS[j.layout.islands.find((i: { slug: string }) => i.slug === slug).slot];
  assert.deepEqual(at("sales"), { u: 1, v: -1 }, "a hand-placed island keeps its spot on the floor across the v3 slot reorder");
  assert.deepEqual(at("manager-office"), { u: -1, v: -1 });
  assert.deepEqual([at("ops"), at("hr")], [{ u: -1, v: 1 }, { u: 1, v: 1 }], "the rest are placed again around the Brain in their old order");
  assert.equal(migrateAllLayouts(d, 6000).migrated, 0, "a second sweep has nothing to do");
  // A future schema: the next deploy bumps the version and the stored layout follows on first read, keeping edits.
  const next = migrateLayout(j.layout, [B("b1", "Scout", "Sales")], 7000, LAYOUT_SCHEMA + 1);
  assert.equal(next.migrated, true);
  assert.equal(next.layout.v, LAYOUT_SCHEMA + 1);
  assert.equal(next.layout.islands.find((i) => i.slug === "sales")!.locked?.name, true);
  // Garbage on disk is rebuilt by the rules rather than drawn.
  const bad = migrateLayout({ nope: 1 }, [B("b1", "Scout", "Sales")], 8000);
  assert.ok(bad.migrated && bad.layout.islands.some((i) => i.slug === "sales"));
});

test("a model plan is only a proposal: unknown bots, bots with a department, bad colours and stats are ignored", () => {
  const bots = [B("b1", "Scout", "Sales"), B("b2", "Helper")];
  const base = rulesLayout(bots, 1);
  const { layout } = applyModelPlan(base, { islands: [{ name: "Hijack", members: ["b1", "ghost"], color: "#ff0000", stats: ["rm -rf", "sessions"] }, { name: "Support", members: ["b2"], color: "cyan", stats: ["waiting", "counter:tickets"] }] }, bots, 2);
  assert.equal(layout.desks.b1, undefined, "a bot's own department wins");
  assert.ok(!layout.islands.some((i) => i.slug === "hijack"), "an island with no valid members is not made");
  const sup = layout.islands.find((i) => i.slug === "support")!;
  assert.equal(sup.color, "cyan");
  assert.deepEqual(sup.stats, ["waiting", "counter:tickets"]);
  assert.equal(findIsland(layout, "the Support team")!.slug, "support");
  assert.throws(() => applyEdit(layout, { op: "remove", island: "sales" }, bots, 3), /department/);
  assert.throws(() => applyEdit(layout, { op: "remove", island: "manager office" }, bots, 3), /stays/);
});
