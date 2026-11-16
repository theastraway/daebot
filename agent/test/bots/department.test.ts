import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/bots/store.ts";
import type { BotMindApi } from "../../src/bots/store.ts";
import { BotError } from "../../src/bots/types.ts";
import { canonBot, mergeWireBot, validWireBot } from "../../src/sync/bots.ts";
import type { WireBot } from "../../src/sync/bots.ts";

function fakeMind(): BotMindApi {
  const remote = new Map<string, string>();
  return {
    async list() { return [...remote].map(([slug, label]) => ({ slug, label })); },
    async create(slug: string, label: string) { remote.set(slug, label); },
    async remove(slug: string) { remote.delete(slug); },
  } as BotMindApi;
}

test("a bot's department is a one-line name the user typed; blank or null clears it; it moves the profile clock and survives a reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bots-dept-"));
  let t = 1000;
  const store = new BotStore({ dir, owner: "o1", mind: fakeMind(), now: () => t });
  const b = await store.create({ slug: "olivia", name: "Olivia" });
  assert.equal(b.department, undefined);
  t = 2000;
  const u = store.update(b.id, { department: "  Talent\n marketing  " });
  assert.equal(u.department, "Talent marketing");
  assert.equal(u.profileAt, 2000);
  assert.equal(store.update(b.id, { department: "x".repeat(60) }).department!.length, 40);
  assert.equal(store.update(b.id, { department: "   " }).department, undefined);
  store.update(b.id, { department: "Sales" });
  assert.equal(store.update(b.id, { department: null }).department, undefined);
  assert.throws(() => store.update(b.id, { department: 7 as unknown as string }), (e: unknown) => e instanceof BotError && e.code === "bad_department");
  store.update(b.id, { department: "Compliance" });
  const again = new BotStore({ dir, owner: "o1", mind: fakeMind(), now: () => t });
  assert.equal(again.get(b.id)?.department, "Compliance");
});

test("device sync carries the department in the look group: the later profile change wins on both sides", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bots-dept-sync-"));
  let t = 1000;
  const store = new BotStore({ dir, owner: "o1", mind: fakeMind(), now: () => t });
  const b = await store.create({ slug: "leo", name: "Leo" });
  t = 1500; store.update(b.id, { department: "Research" });
  const wire = store.exportSync("leo")!;
  assert.equal(wire.department, "Research");
  assert.ok(validWireBot(wire));
  assert.equal(validWireBot({ ...wire, department: "y".repeat(41) }), false);
  // The other device renamed the department later: applying its wire moves this side.
  const theirs: WireBot = canonBot({ ...wire, department: "Pay & Bill", profileAt: 1600 });
  assert.equal(store.applySync(theirs), true);
  assert.equal(store.get(b.id)?.department, "Pay & Bill");
  // The merge is symmetric and keeps the later look, department included.
  const a = canonBot({ ...wire, department: "A", profileAt: 10 }), c = canonBot({ ...wire, department: "C", profileAt: 20 });
  assert.equal(mergeWireBot(a, c).department, "C");
  assert.equal(mergeWireBot(c, a).department, "C");
  // Clearing on the other side clears here (a later profile with no department).
  assert.equal(store.applySync(canonBot({ ...wire, department: undefined, profileAt: 1700 })), true);
  assert.equal(store.get(b.id)?.department, undefined);
});
