import { test } from "node:test";
process.env.DAEBOT_BOTS_ENABLED = "1"; // the Bots feature flag (default off)
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { createAgentSession } from "../../src/loop.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { BotStore } from "../../src/bots/store.ts";
import { createBotManageTool } from "../../src/bots/manage-tool.ts";
import type { BotManageHooks } from "../../src/bots/manage-tool.ts";
import { BOT_SKILL_PROMPT } from "../../src/bots/skill.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { FakeProvider, FakeSync, baseCfg, call, collect } from "../core/helpers.ts";

const rnd = () => randomBytes(18).toString("hex");
const MODELS = { default: "m/default", models: [{ id: "m/default", name: "Default", allowed: true }, { id: "m/pro", name: "Pro", allowed: true }, { id: "m/ultra", name: "Ultra", allowed: false }] };
const INSTR = "# Role\nYou are LinkedIn Voice. Your job: draft posts.\n\n# How you work\n- Look in MIND first.\n\n# Never\n- Guess.\n";

function memStore() {
  const remote = new Set<string>();
  const dir = mkdtempSync(join(tmpdir(), "bots-manage-"));
  const store = new BotStore({ dir, owner: "u1", mind: { async list() { return [...remote].map((slug) => ({ slug })); }, async create(slug) { remote.add(slug); }, async remove(slug) { remote.delete(slug); } } });
  return { store, remote, dir };
}
const tool = (bots: BotStore, hooks: BotManageHooks | undefined = { async models() { return MODELS; } }, extra: { threads?: number; purged?: string[] } = {}) =>
  createBotManageTool({ bots, owner: "u1", hooks: () => hooks, threads: () => extra.threads ?? 0, purge: async (id) => { extra.purged?.push(id); } });
const run = (t: ReturnType<typeof tool>, args: Record<string, unknown>, origin?: "user" | "bot") => t.run(args, { cwd: "/", sessionId: "s", origin });

test("create with instructions + model persists the bot, its DAEBOT.md and its model; list/faces/models report them", async () => {
  const { store } = memStore();
  const t = tool(store, undefined, { threads: 2 });
  const r = await run(t, { action: "create", slug: "linkedin", name: "LinkedIn Voice", purpose: "Drafts LinkedIn posts in my voice", face: "creator", model: "m/pro", instructions: INSTR });
  assert.equal(r.ok, true, r.output);
  const b = store.bySlug("linkedin")!;
  assert.equal(b.name, "LinkedIn Voice");
  assert.equal(b.face, "creator");
  assert.equal(b.model, "m/pro");
  assert.equal(store.instructions(b.id), INSTR);
  const l = JSON.parse((await run(t, { action: "list" })).output);
  assert.deepEqual(l.bots.map((x: any) => [x.slug, x.face, x.model, x.threads]), [["linkedin", "creator", "m/pro", 2]]);
  assert.ok(JSON.parse((await run(t, { action: "faces" })).output).faces.some((f: any) => f.id === "creator"));
  const withHook = tool(store);
  const m = JSON.parse((await run(withHook, { action: "models" })).output);
  assert.deepEqual(m.models.map((x: any) => x.id), ["m/default", "m/pro"], "only models the plan allows");
});

test("create without instructions gets the house-shape starter; update changes fields, replaces instructions, and \"\" clears the model", async () => {
  const { store } = memStore();
  const t = tool(store);
  assert.equal((await run(t, { action: "create", slug: "ops", name: "Ops", purpose: "runs the runbooks", model: "m/pro" })).ok, true);
  const id = store.bySlug("ops")!.id;
  assert.match(store.instructions(id), /# Role\nYou are Ops\. Your job: runs the runbooks[\s\S]*# How you work[\s\S]*# Never/);
  const u = await run(t, { action: "update", slug: "ops", purpose: "triage", model: "", face: "operator", instructions: INSTR });
  assert.equal(u.ok, true, u.output);
  const b = store.get(id)!;
  assert.equal(b.purpose, "triage");
  assert.equal(b.model, undefined, "model cleared");
  assert.equal(b.face, "operator");
  assert.equal(store.instructions(id), INSTR);
  assert.equal((await run(t, { action: "update", slug: "ops" })).ok, false, "an empty update is an error");
});

test("invalid slug, duplicate, face, color, model (unknown / not on plan), oversized instructions are rejected with clear errors and create nothing", async () => {
  const { store, remote } = memStore();
  const t = tool(store);
  const bad = async (args: Record<string, unknown>, re: RegExp) => { const r = await run(t, { action: "create", name: "X", purpose: "p", ...args }); assert.equal(r.ok, false, JSON.stringify(args)); assert.match(r.output, re); };
  await bad({ slug: "Bad Slug" }, /slug must be/);
  await bad({ slug: "" }, /slug must be/);
  await bad({ slug: "main" }, /reserved/);
  await bad({ slug: "a".repeat(33) }, /slug must be/);
  await bad({ slug: "ok", face: "wizard" }, /not a face id.*analyst/);
  await bad({ slug: "ok", color: "red" }, /color must look like/);
  await bad({ slug: "ok", model: "nope/none" }, /not in the user's model list/);
  await bad({ slug: "ok", model: "m/ultra" }, /not on the user's plan/);
  await bad({ slug: "ok", model: "bad model!" }, /not a valid model id/);
  await bad({ slug: "ok", instructions: "x".repeat(9000) }, /capped at 8 KB/);
  await bad({ slug: "ok", instructions: "   " }, /non-empty/);
  assert.equal(remote.size, 0, "nothing was created in MIND");
  assert.equal(store.snapshot().length, 0);
  assert.equal((await run(t, { action: "create", slug: "dup", name: "Dup" })).ok, true);
  assert.match((await run(t, { action: "create", slug: "dup", name: "Dup" })).output, /already exists/);
  assert.match((await run(t, { action: "update", slug: "ghost", name: "x" })).output, /no bot "ghost"\. Valid: dup/);
  assert.match((await run(t, { action: "update", slug: "dup", model: "m/ultra" })).output, /not on the user's plan/);
});

test("a message from another bot cannot create, update or delete; reads still work", async () => {
  const { store } = memStore();
  const t = tool(store);
  assert.equal((await run(t, { action: "create", slug: "x", name: "X" }, "user")).ok, true);
  for (const args of [{ action: "create", slug: "y", name: "Y" }, { action: "update", slug: "x", name: "Z" }, { action: "delete", slug: "x" }]) {
    const r = await run(t, args, "bot");
    assert.equal(r.ok, false);
    assert.match(r.output, /another bot cannot/);
  }
  assert.equal(store.bySlug("x")!.name, "X");
  assert.equal(store.bySlug("y"), undefined);
  assert.equal((await run(t, { action: "list" }, "bot")).ok, true);
});

test("delete is irreversible-class: through the kernel it needs the user's explicit go; then it removes the bot and purges its threads", async () => {
  const { store, remote } = memStore();
  const purged: string[] = [];
  const removed: string[] = [];
  const t = tool(store, { async removed(_o, id) { removed.push(id); } }, { purged });
  await run(t, { action: "create", slug: "gone", name: "Gone" });
  const id = store.bySlug("gone")!.id;
  assert.equal(t.classFor!({ action: "delete" }), "irreversible");
  assert.equal(t.classFor!({ action: "create" }), "write");
  assert.equal(t.classFor!({ action: "list" }), "read");
  const provider = new FakeProvider([{ calls: [call("1", "bot_manage", { action: "delete", slug: "gone" })] }, { calls: [call("2", "bot_manage", { action: "delete", slug: "gone" })] }, { text: "deleted" }]);
  const s = createAgentSession({ id: "s1", surface: "web", provider, kernel: createKernel({ shadow: false, enabled: true }), tools: [t], sync: new FakeSync(), cfg: baseCfg(), cwd: "/", systemPrompt: "SYS", bootContext: "booted" });
  let ev = await collect(s.send("delete the gone bot"));
  assert.ok(ev.some((e) => e.type === "confirm"), "the user is asked first");
  assert.ok(store.bySlug("gone"), "still there: nothing ran silently");
  ev = await collect(s.send("send it"));
  assert.ok(ev.some((e) => e.type === "toolEnd" && (e as any).ok), JSON.stringify(ev.filter((e) => e.type === "toolEnd")));
  assert.equal(store.bySlug("gone"), undefined);
  assert.equal(remote.has("gone"), false, "removed in MIND too");
  assert.deepEqual(removed, [id]);
  assert.deepEqual(purged, [id]);
});

test("end to end in a runtime: the main session offers bot_manage and the skill; Daebot's bot_manage create lands in the store; a bot session has the tool for itself, not the create-a-bot skill", async () => {
  const key = "mind_" + rnd();
  const fake = await startFakeMind({ [key]: "pat" });
  const dir = mkdtempSync(join(tmpdir(), "bots-manage-rt-"));
  try {
    const provider = new FakeProvider([
      { calls: [call("1", "bot_manage", { action: "create", slug: "linkedin", name: "LinkedIn Voice", purpose: "Drafts LinkedIn posts in my voice", face: "creator", model: "m/pro", instructions: INSTR })] },
      { text: "made" }, { text: "bot turn" },
    ]);
    const bus = {};
    const manage = { current: { async models() { return MODELS; } } as BotManageHooks };
    const rt = createRuntime(baseCfg({ mindBaseUrl: fake.base, mindApiKey: key }), { provider, store: createFileStore(dir), owner: "u_pat", bots: { dir, bus, manage }, hosted: { dailyUsdCap: 50, username: "pat", exempt: true } });
    const main = await rt.openSession({ surface: "web", identity: "admin" });
    const ev = await collect(main.send("Make me a bot that drafts LinkedIn posts in my voice."));
    const end = ev.find((e) => e.type === "toolEnd" && (e as any).tool === "bot_manage") as any;
    assert.ok(end?.ok, JSON.stringify(end));
    const names = provider.requests[0].tools.map((t) => t.name);
    assert.ok(names.includes("bot_manage"));
    assert.ok(!names.includes("computer"), "no screen tool");
    assert.ok(provider.requests[0].messages[0].content.includes(BOT_SKILL_PROMPT), "the stock skill is in the system prompt");
    assert.match(provider.requests[0].messages[0].content, /## Creating a Daebot[\s\S]*bot_manage create ONCE/);
    const b = rt.bots!.bySlug("linkedin")!;
    assert.equal(b.model, "m/pro");
    assert.equal(rt.bots!.instructions(b.id), INSTR);
    const bs = await rt.openSession({ surface: "web", botId: b.id, identity: "admin" });
    await collect(bs.send("hi"));
    const last = provider.requests.at(-1)!;
    assert.ok(last.tools.some((t) => t.name === "bot_manage"), "a bot has bot_manage, for itself only");
    assert.ok(!last.messages[0].content.includes("## Creating a Daebot"), "but it is not taught to create bots");
  } finally { await fake.close(); }
});

test("a staff identity (the hosted default) may use bot_manage, and its delete still stops for the user's go", async () => {
  const { store } = memStore();
  const t = tool(store);
  await run(t, { action: "create", slug: "gone", name: "Gone" });
  const provider = new FakeProvider([{ calls: [call("1", "bot_manage", { action: "delete", slug: "gone" })] }, { calls: [call("2", "bot_manage", { action: "delete", slug: "gone" })] }, { text: "ok" }]);
  const s = createAgentSession({ id: "s1", surface: "web", provider, kernel: createKernel({ shadow: false, enabled: true, tier: "staff" }), tools: [t], sync: new FakeSync(), cfg: baseCfg(), cwd: "/", systemPrompt: "SYS", bootContext: "booted" });
  let ev = await collect(s.send("delete the gone bot"));
  assert.ok(ev.some((e) => e.type === "confirm"), "asked, not blocked by the tier");
  assert.ok(!ev.some((e) => e.type === "gate" && (e as any).verdict.gate === "tier"));
  assert.ok(store.bySlug("gone"));
  ev = await collect(s.send("send it"));
  assert.equal(store.bySlug("gone"), undefined);
});
