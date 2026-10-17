import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore, botMindApi } from "../../src/bots/store.ts";
import type { BotMindApi } from "../../src/bots/store.ts";
import { BotError, MAX_INSTRUCTIONS_BYTES } from "../../src/bots/types.ts";
import type { MindClient } from "../../src/types.ts";

function fakeMindApi(): BotMindApi & { calls: string[]; remote: Map<string, string>; failCreate?: BotError; failList?: boolean } {
  const api: any = {
    calls: [] as string[],
    remote: new Map<string, string>(),
    async list() { api.calls.push("list"); if (api.failList) throw new BotError(502, "mind_unreachable", "down"); return [...api.remote].map(([slug, label]) => ({ slug, label })); },
    async create(slug: string, label: string) { api.calls.push(`create:${slug}`); if (api.failCreate) throw api.failCreate; api.remote.set(slug, label); },
    async remove(slug: string) { api.calls.push(`remove:${slug}`); api.remote.delete(slug); },
  };
  return api;
}

const mk = (dir: string, owner: string, mind: BotMindApi) => new BotStore({ dir, owner, mind });

test("create calls MIND first, then writes locally; round trip survives a restart; files are 0600", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bots-"));
  const mind = fakeMindApi();
  const s = mk(dir, "u1", mind);
  const b = await s.create({ slug: "sales", name: "Sales", purpose: "pipeline questions", color: "#112233" });
  assert.match(b.id, /^b_[0-9a-f]{12}$/);
  assert.deepEqual(mind.calls, ["create:sales"]);
  assert.equal(mind.remote.get("sales"), "Sales");
  const file = join(dir, "bots", "u1", "bots.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const j = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(j.v, 1);
  assert.deepEqual(Object.keys(j.bots), [b.id]);
  assert.equal(j.bots[b.id].color, "#112233");
  assert.deepEqual(readdirSync(join(dir, "bots", "u1")).filter((n) => n.endsWith(".tmp")), [], "no temp file left behind");
  // restart
  const s2 = mk(dir, "u1", mind);
  assert.deepEqual(s2.snapshot().map((x) => x.slug), ["sales"]);
  assert.equal(s2.bySlug("sales")?.id, b.id);
  assert.equal(s2.get(b.id)?.purpose, "pipeline questions");
});

test("slug rules: ^[a-z0-9-]{1,32}$, not main, unique; a MIND refusal writes nothing locally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bots-"));
  const mind = fakeMindApi();
  const s = mk(dir, "u1", mind);
  for (const bad of ["", "Sales", "a b", "a_b", "x".repeat(33), "main", "../x", "é"]) {
    await assert.rejects(() => s.create({ slug: bad }), (e: any) => e instanceof BotError && e.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(mind.calls, [], "invalid slugs never reach MIND");
  await s.create({ slug: "a-1" });
  await assert.rejects(() => s.create({ slug: "a-1" }), (e: any) => e.status === 409);
  mind.failCreate = new BotError(402, "bot_limit", "limit", { limit: 1 });
  await assert.rejects(() => s.create({ slug: "second" }), (e: any) => e.status === 402 && e.extra.limit === 1);
  assert.deepEqual(s.snapshot().map((b) => b.slug), ["a-1"], "nothing written for the refused bot");
});

test("remove calls MIND first and deletes the local record and DAEBOT.md; a MIND failure keeps the record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bots-"));
  const mind = fakeMindApi();
  const s = mk(dir, "u1", mind);
  const b = await s.create({ slug: "ops" });
  s.setInstructions(b.id, "# ops\nbe terse");
  assert.ok(existsSync(join(dir, "bots", "u1", b.id, "DAEBOT.md")));
  mind.remove = async () => { throw new BotError(502, "mind_error", "boom"); };
  await assert.rejects(() => s.remove(b.id), (e: any) => e.status === 502);
  assert.equal(s.snapshot().length, 1);
  mind.remove = async (slug: string) => { mind.calls.push(`remove:${slug}`); mind.remote.delete(slug); };
  await s.remove(b.id);
  assert.equal(s.snapshot().length, 0);
  assert.ok(!existsSync(join(dir, "bots", "u1", b.id)));
  assert.equal(mind.calls.at(-1), "remove:ops");
});

test("DAEBOT.md is capped at 8 KB (bytes) and written atomically at 0600", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bots-"));
  const s = mk(dir, "u1", fakeMindApi());
  const b = await s.create({ slug: "w" });
  assert.equal(s.instructions(b.id), "");
  s.setInstructions(b.id, "x".repeat(MAX_INSTRUCTIONS_BYTES));
  assert.equal(statSync(join(dir, "bots", "u1", b.id, "DAEBOT.md")).mode & 0o777, 0o600);
  assert.equal(s.instructions(b.id).length, MAX_INSTRUCTIONS_BYTES);
  assert.throws(() => s.setInstructions(b.id, "x".repeat(MAX_INSTRUCTIONS_BYTES + 1)), (e: any) => e.status === 413);
  assert.throws(() => s.setInstructions(b.id, "é".repeat(MAX_INSTRUCTIONS_BYTES / 2 + 1)), (e: any) => e.status === 413, "bytes, not characters");
  assert.equal(s.instructions(b.id).length, MAX_INSTRUCTIONS_BYTES, "a refused write leaves the old text");
});

test("ownership: user B cannot see, read, change or delete user A's bots (all 404 / empty)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bots-"));
  const a = mk(dir, "u_a", fakeMindApi());
  const b = mk(dir, "u_b", fakeMindApi());
  const mine = await a.create({ slug: "secret" });
  a.setInstructions(mine.id, "A only");
  assert.deepEqual(b.snapshot(), []);
  assert.equal(b.get(mine.id), undefined);
  assert.equal(b.bySlug("secret"), undefined);
  assert.equal(b.instructions(mine.id), "");
  assert.throws(() => b.update(mine.id, { name: "pwn" }), (e: any) => e.status === 404);
  assert.throws(() => b.setInstructions(mine.id, "pwn"), (e: any) => e.status === 404);
  await assert.rejects(() => b.remove(mine.id), (e: any) => e.status === 404);
  assert.equal(a.instructions(mine.id), "A only");
  // path tricks in an id never touch the filesystem
  for (const evil of ["../u_a", "b_../../x", "b_" + "0".repeat(12) + "/../x"]) assert.equal(b.get(evil), undefined);
  assert.throws(() => b.setInstructions("../u_a/x", "pwn"), (e: any) => e.status === 404);
});

test("reconcile: MIND is the source of truth, but a bot is only dropped after 3 consecutive misses and its DAEBOT.md goes to .trash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bots-"));
  const mind = fakeMindApi();
  const s = mk(dir, "u1", mind);
  const keep = await s.create({ slug: "keep" });
  const gone = await s.create({ slug: "gone" });
  s.setInstructions(gone.id, "lost with the bot");
  mind.remote.delete("gone");          // deleted elsewhere
  mind.remote.set("fresh", "Fresh");   // created elsewhere
  let list = await s.list();
  assert.deepEqual(list.map((b) => b.slug).sort(), ["fresh", "gone", "keep"], "one miss changes nothing");
  assert.deepEqual(s.staleSlugs(), ["gone"]);
  assert.equal(s.instructions(gone.id), "lost with the bot");
  await s.list();
  assert.ok(s.get(gone.id), "two misses: still here");
  list = await s.list();
  assert.deepEqual(list.map((b) => b.slug).sort(), ["fresh", "keep"], "third consecutive miss drops it");
  assert.equal(s.get(gone.id), undefined);
  assert.equal(s.bySlug("keep")?.id, keep.id, "an existing bot keeps its id");
  assert.equal(s.bySlug("fresh")?.name, "Fresh");
  const trash = readdirSync(join(dir, "bots", "u1", ".trash"));
  assert.equal(trash.length, 1);
  assert.equal(readFileSync(join(dir, "bots", "u1", ".trash", trash[0], "DAEBOT.md"), "utf8"), "lost with the bot", "instructions are moved, never deleted");
  // a miss counter resets when MIND lists the bot again
  mind.remote.delete("keep");
  await s.list(); await s.list();
  mind.remote.set("keep", "Keep");
  await s.list();
  mind.remote.delete("keep");
  await s.list(); await s.list();
  assert.ok(s.bySlug("keep"), "misses were not consecutive");
  // a MIND outage changes nothing
  mind.failList = true;
  for (let i = 0; i < 5; i++) await s.list();
  assert.ok(s.bySlug("keep"));
});

test("an EMPTY list from MIND never deletes anything, however many times it repeats", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bots-"));
  const mind = fakeMindApi();
  const s = mk(dir, "u1", mind);
  const b = await s.create({ slug: "solo" });
  s.setInstructions(b.id, "precious");
  mind.remote.clear();
  for (let i = 0; i < 6; i++) await s.list();
  assert.ok(s.bySlug("solo"));
  assert.equal(s.instructions(b.id), "precious");
  assert.ok(!existsSync(join(dir, "bots", "u1", ".trash")));
});

test("create, remove and list run one at a time per owner (a promise-chain mutex); a duplicate slug race writes one record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bots-"));
  const order: string[] = [];
  const gate: (() => void)[] = [];
  const mind: BotMindApi = {
    list: async () => { order.push("list"); return []; },
    create: async (slug) => { order.push(`create-start:${slug}`); await new Promise<void>((r) => gate.push(r)); order.push(`create-end:${slug}`); },
    remove: async () => {},
  };
  const s = mk(dir, "u1", mind);
  const a = s.create({ slug: "a" });
  const l = s.list();
  const b = s.create({ slug: "b" });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["create-start:a"], "list and the second create wait for the first create");
  gate.shift()!();
  await a;
  await new Promise((r) => setTimeout(r, 20));
  gate.shift()?.();
  await Promise.all([l, b]);
  assert.deepEqual(order, ["create-start:a", "create-end:a", "list", "create-start:b", "create-end:b"]);
  // same slug twice at once: the second is refused, one record
  const s2 = mk(mkdtempSync(join(tmpdir(), "bots-")), "u1", fakeMindApi());
  const r = await Promise.allSettled([s2.create({ slug: "same" }), s2.create({ slug: "same" })]);
  assert.deepEqual(r.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(s2.snapshot().length, 1);
});

test("botMindApi maps MIND statuses: 409 duplicate, 402 bot_limit with limit/tier/upgrade url, 404 delete is fine", async () => {
  const mkClient = (fail: (args: any) => unknown): MindClient => ({
    context: async () => "", query: async () => "", remember: async () => "",
    call: async (tool, args) => { assert.equal(tool, "bots"); const r = fail(args); if (r instanceof Error) throw r; return JSON.stringify(r); },
  });
  const http = (status: number, payload?: unknown) => Object.assign(new Error(`MIND bots: HTTP ${status}`), { status, payload });
  const dup = botMindApi(mkClient(() => http(409)));
  await assert.rejects(() => dup.create("x", "X"), (e: any) => e.status === 409 && e.code === "duplicate");
  const lim = botMindApi(mkClient(() => http(402, { error: "bot_limit", limit: 3, tier: "free", upgrade_url: "https://app.m-i-n-d.ai/billing" })));
  await assert.rejects(() => lim.create("x", "X"), (e: any) => e.status === 402 && e.code === "bot_limit" && e.extra.limit === 3 && e.extra.tier === "free" && e.extra.upgradeUrl === "https://app.m-i-n-d.ai/billing");
  // F-8: only https m-i-n-d.ai links survive; the limit is coerced to a number
  for (const evil of ["http://m-i-n-d.ai/x", "https://m-i-n-d.ai.evil.com/x", "https://evil.com/m-i-n-d.ai", "javascript:alert(1)", "https://user:pw@m-i-n-d.ai/x", "//m-i-n-d.ai"]) {
    const l = botMindApi(mkClient(() => http(402, { error: "bot_limit", limit: "7", tier: "free", upgrade_url: evil })));
    await assert.rejects(() => l.create("x", "X"), (e: any) => e.extra.limit === 7 && e.extra.upgradeUrl === undefined && e.extra.upgrade_url === undefined, evil);
  }
  const root = botMindApi(mkClient(() => http(402, { error: "bot_limit", limit: "<b>x</b>", upgrade_url: "https://m-i-n-d.ai/billing" })));
  await assert.rejects(() => root.create("x", "X"), (e: any) => e.extra.limit === undefined && e.extra.upgradeUrl === "https://m-i-n-d.ai/billing");
  const gone = botMindApi(mkClient(() => http(404)));
  await gone.remove("x"); // no throw
  const list = botMindApi(mkClient(() => ({ bots: [{ slug: "a", label: "A" }, { nope: 1 }] })));
  assert.deepEqual(await list.list(), [{ slug: "a", label: "A" }]);
  const bad = botMindApi(mkClient(() => ({ weird: true })));
  await assert.rejects(() => bad.list(), (e: any) => e.status === 502);
});
