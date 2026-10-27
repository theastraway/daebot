import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOT_DEFINITIONS, LATEST_BOT_VERSION, versionInfo, versionOf, withBotBase } from "../../src/bots/versions.ts";
import { BotStore } from "../../src/bots/store.ts";

const mind = { list: async () => [], create: async () => {}, remove: async () => {} };

test("a record with no version is on 1; unknown versions fall back to 1; info says what an update brings", () => {
  assert.equal(versionOf({}), 1);
  assert.equal(versionOf({ version: 99 }), 1);
  const old = versionInfo({});
  assert.equal(old.updateAvailable, true);
  assert.ok(old.updateNotes.length > 0);
  assert.equal(old.latestVersion, BOT_DEFINITIONS[LATEST_BOT_VERSION].label);
  const cur = versionInfo({ version: LATEST_BOT_VERSION });
  assert.equal(cur.updateAvailable, false);
  assert.deepEqual(cur.updateNotes, []);
});

test("the base rules sit under the owner's DAEBOT.md only for definitions that have them", () => {
  assert.equal(withBotBase(1, "mine"), "mine");
  const v = withBotBase(LATEST_BOT_VERSION, "mine");
  assert.ok(v.startsWith("# Base rules") && v.endsWith("mine"));
  assert.ok(withBotBase(LATEST_BOT_VERSION, "").startsWith("# Base rules"));
});

test("upgrade: legacy bot (no version on disk) -> latest; instructions kept; persisted; unknown id is not_found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "botver-"));
  const root = join(dir, "bots", "u1");
  mkdirSync(join(root, "b_0123456789ab"), { recursive: true });
  writeFileSync(join(root, "bots.json"), JSON.stringify({ v: 1, bots: { b_0123456789ab: { id: "b_0123456789ab", slug: "old", name: "Old", purpose: "", color: "#aabbcc", createdAt: 1, updatedAt: 1 } } }));
  writeFileSync(join(root, "b_0123456789ab", "DAEBOT.md"), "keep this");
  const s1 = new BotStore({ dir, owner: "u1", mind });
  assert.equal(versionInfo(s1.get("b_0123456789ab")).updateAvailable, true);
  const up = s1.upgrade("b_0123456789ab");
  assert.equal(up.version, LATEST_BOT_VERSION);
  assert.equal(s1.instructions("b_0123456789ab"), "keep this");
  const s2 = new BotStore({ dir, owner: "u1", mind });
  assert.equal(versionInfo(s2.get("b_0123456789ab")).updateAvailable, false, "persisted");
  assert.throws(() => s2.upgrade("b_ffffffffffff"), /no such bot/);
  assert.throws(() => new BotStore({ dir, owner: "u2", mind }).upgrade("b_0123456789ab"), /no such bot/, "another owner cannot");
});
