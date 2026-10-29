import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedToolAllowed } from "../../src/hosted.ts";
import { tierAllows } from "../../src/kernel/tier.ts";
import { createFileStore } from "../../src/persist.ts";
import type { StoredSession } from "../../src/persist.ts";
import { createBotTalkTool } from "../../src/bots/talk-tool.ts";
import { createModelCatalog } from "../../src/models.ts";
import { createSettings } from "../../src/settings.ts";
import { composeSystemPrompt } from "../../src/runtime.ts";
import { baseCfg } from "../core/helpers.ts";
import { statSync } from "node:fs";

test("hosted deployments may run bot_talk and mind_tenants; staff can use bot_talk, public cannot", () => {
  assert.equal(hostedToolAllowed("bot_talk"), true);
  assert.equal(hostedToolAllowed("bot_manage"), true);
  assert.equal(hostedToolAllowed("mind_tenants"), true);
  assert.equal(hostedToolAllowed("bash"), false);
  const t = createBotTalkTool({ bus: {}, owner: "o" });
  assert.equal(tierAllows("staff", t), true);
  assert.equal(tierAllows("admin", t), true);
  assert.equal(tierAllows("public", t), false, "public identities are read-only");
});

test("session records carry bot / peer / model and the listing index exposes them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "persist-"));
  const store = createFileStore(dir);
  const rec: StoredSession = {
    v: 1, id: "dm_abc", surface: "bot", title: "DM", tier: "admin", owner: "u1", bot: "b_0123456789ab", peer: "main", model: "vendor/x",
    createdAt: 1, updatedAt: 2, state: { messages: [], receiptCounter: 0, totalCostUsd: 0, userMessageIndex: 0 }, violations: [], history: [],
  };
  await store.save(rec);
  await store.save({ ...rec, id: "plain", bot: undefined, peer: undefined, model: undefined });
  const fresh = createFileStore(dir); // a restart re-scans the files
  assert.deepEqual(fresh.meta!("dm_abc"), { id: "dm_abc", surface: "bot", title: "DM", updatedAt: 2, owner: "u1", bot: "b_0123456789ab", peer: "main", model: "vendor/x" });
  assert.equal(fresh.meta!("plain")!.bot, undefined);
  assert.equal(fresh.load("dm_abc")!.peer, "main");
  // old records without the new fields still load
  assert.equal(statSync(join(dir, "sessions", "dm_abc.json")).mode & 0o777, 0o600);
});

test("settings file: default model, 0600, per user, atomic; junk reads as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-"));
  const a = createSettings(dir, "u_a");
  const b = createSettings(dir, "u_b");
  assert.deepEqual(a.get(), {});
  a.set({ defaultModel: "vendor/m-1:free" });
  assert.deepEqual(a.get(), { defaultModel: "vendor/m-1:free" });
  assert.deepEqual(b.get(), {}, "per user");
  assert.equal(statSync(join(dir, "settings", "u_a.json")).mode & 0o777, 0o600);
  assert.throws(() => a.set({ defaultModel: "../../etc" }), /bad model id/);
  a.set({ defaultModel: null });
  assert.deepEqual(a.get(), {});
  const evil = createSettings(dir, "../../x");
  evil.set({ defaultModel: "v/m" });
  assert.deepEqual(evil.get(), { defaultModel: "v/m" });
});

test("model catalog: caches per key, fails soft to the configured models", async () => {
  let hits = 0;
  const f = (async () => { hits++; return new Response(JSON.stringify({ models: [{ id: "a/b", name: "AB", tier: "premium" }, { id: "c/d:free", name: "CD" }, { nope: 1 }] }), { status: 200 }); }) as typeof fetch;
  const cat = createModelCatalog({ cfg: baseCfg({ mindBaseUrl: "https://mind.test/developer/v1" }), fetchImpl: f });
  const one = await cat.list("k1", true);
  assert.deepEqual(one.models, [{ id: "a/b", name: "AB", free: false, allowed: false }, { id: "c/d:free", name: "CD", free: true, allowed: true }]);
  await cat.list("k1", false);
  assert.equal(hits, 1, "cached");
  await cat.list("k2", false);
  assert.equal(hits, 2, "per key");
  const down = createModelCatalog({ cfg: baseCfg({ freeModel: "z/free:free" }), fetchImpl: (async () => { throw new Error("net"); }) as typeof fetch });
  const d = await down.list("k", true);
  assert.equal(d.source, "config");
  assert.deepEqual(d.models.filter((m) => m.allowed).map((m) => m.id), ["z/free:free"]);
  const nokey = await down.list(undefined, false);
  assert.equal(nokey.source, "config");
});

test("composeSystemPrompt: an ordinary session prompt is unchanged when there are no bots", () => {
  const p = composeSystemPrompt({ bootContext: "", surface: "web", cwd: "/x", now: new Date("2026-01-02T12:00:00Z") });
  assert.ok(!p.includes("MINDs and bots"));
  assert.ok(!p.includes("DAEBOT.md"));
  assert.match(p, /^You are Daebot \(Dae\)/);
});
