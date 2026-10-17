import { test } from "node:test";
import assert from "node:assert/strict";
import { createMindClient, createMindTools } from "../../src/mind/index.ts";
import type { TenantResolver } from "../../src/mind/tools.ts";
import { Semaphore } from "../../src/mind/tools.ts";
import { negativeEvidenceOk } from "../../src/kernel/receipt.ts";
import type { CallRecord, MindClient, Tool } from "../../src/types.ts";
import { cfg, fakeFetch, json, KEY } from "../mind/helpers.ts";
import type { Seen } from "../mind/helpers.ts";

const ctx = { cwd: "/", sessionId: "s" };

/** Real clients on one fake fetch: "main" sends no bot header, a bot slug sends X-MIND-Bot. All on the SAME main key. */
function rig(home: string, handler: Parameters<typeof fakeFetch>[0] = () => json(200, { id: "x1", response: "ok", sections: [{ section: "soul", items: [{ text: "x" }] }] })) {
  const f = fakeFetch(handler);
  const clients = new Map<string, MindClient>();
  const clientFor = (m: string): MindClient => {
    let c = clients.get(m);
    if (!c) { c = createMindClient(cfg(), f.fetch, { retryDelayMs: 0, ...(m === "main" ? {} : { bot: m }) }); clients.set(m, c); }
    return c;
  };
  const roster = [{ slug: "sales", name: "Sales", purpose: "pipeline" }, { slug: "ops", name: "Ops", purpose: "runbooks" }];
  const resolver: TenantResolver = { home, roster: () => roster, clientFor };
  const tools = createMindTools(resolver, { user: "pat" });
  const by = (n: string): Tool => { const t = tools.find((x) => x.spec.name === n); assert.ok(t, n); return t!; };
  return { tools, by, seen: f.seen };
}

const OWNER = "x belongs to Pat; pat asked about Pat; Pat == Pat";

// minimal valid args for every tool
const SAMPLE: Record<string, Record<string, unknown>> = {
  mind_context: { sections: ["soul"] },
  mind_query: { query: "what is the pipeline?" },
  mind_remember: { type: "document", title: "t", content: "c" },
  mind_decision_record: { subject: "s", decision: "d" },
  mind_feed_post: { content: "hi" },
  mind_social: { action: "create_thought", content: "hi" },
  mind_sense: { action: "state" },
  mind_profile: { action: "get" },
  mind_life: { action: "list" }, mind_life_write: { action: "create", fields: { title: "t" } },
  mind_crm: { action: "list" }, mind_crm_write: { action: "create", fields: { name: "n" } },
  mind_checklists: { action: "list" }, mind_checklists_write: { action: "create", fields: { title: "t" } },
  mind_tasks: { action: "list" }, mind_tasks_write: { action: "create", fields: { title: "t" } },
  mind_folders_read: { action: "list" },
  mind_folders: { action: "create", fields: { name: "f" } },
};

const deepHasKey = (v: unknown, key: string): boolean =>
  !!v && typeof v === "object" && (Object.keys(v as object).includes(key) || Object.values(v as object).some((x) => deepHasKey(x, key)));

test("a read with mind:<slug> sends X-MIND-Bot with the MAIN key and never puts mind in the body or URL", async () => {
  const r = rig("main");
  const out = await r.by("mind_query").run({ query: "pipeline status?", mind: "sales" }, ctx);
  assert.equal(out.ok, true, out.output);
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].headers["x-mind-bot"], "sales");
  assert.equal(r.seen[0].headers["x-api-key"], KEY, "the bot is addressed with the user's main key, no separate bot key");
  assert.ok(!deepHasKey(r.seen[0].body, "mind"));
  assert.ok(!r.seen[0].url.includes("mind="));
  // main read: no header
  await r.by("mind_query").run({ query: "q", mind: "main" }, ctx);
  assert.equal(r.seen[1].headers["x-mind-bot"], undefined);
});

test("a bot's home MIND is the default for reads and for writes (header on every call)", async () => {
  const r = rig("sales");
  await r.by("mind_query").run({ query: "q" }, ctx);
  await r.by("mind_remember").run({ type: "entry", title: "t", content: "c", owner_check: OWNER }, ctx);
  assert.deepEqual(r.seen.map((s) => s.headers["x-mind-bot"]), ["sales", "sales"]);
  assert.deepEqual(r.seen.map((s) => new URL(s.url).pathname), ["/developer/v1/query", "/developer/v1/entries"]);
  // reading main from a bot session drops the header
  await r.by("mind_query").run({ query: "q2", mind: "main" }, ctx);
  assert.equal(r.seen[2].headers["x-mind-bot"], undefined);
});

test("every tool: `mind` never reaches a request body (top level or inside fields); reads honour it, writes stay home", async () => {
  const r = rig("main");
  const names = r.tools.map((t) => t.spec.name).filter((n) => n !== "mind_tenants");
  assert.deepEqual(names.filter((n) => !SAMPLE[n]), [], "every tool has a sample in this test");
  for (const name of names) {
    const t = r.by(name);
    const before = r.seen.length;
    const args: Record<string, unknown> = { ...SAMPLE[name], owner_check: OWNER };
    if (t.class === "read") {
      const res = await t.run({ ...args, mind: "ops" }, ctx);
      assert.equal(res.ok, true, `${name}: ${res.output}`);
      assert.equal(r.seen.at(-1)!.headers["x-mind-bot"], "ops", `${name} read honours mind`);
    } else {
      // a write that names its own home is accepted and the field is stripped; one that names another MIND is refused with no request
      const own = await t.run({ ...args, mind: "main", fields: { ...(args.fields as object ?? {}), mind: "ops" } }, ctx);
      assert.equal(own.ok, true, `${name}: ${own.output}`);
      assert.equal(r.seen.at(-1)!.headers["x-mind-bot"], undefined, `${name} write went to home (main)`);
      const other = await t.run({ ...args, mind: "ops" }, ctx);
      assert.equal(other.ok, false, `${name} refuses another MIND`);
      assert.match(other.output, /own MIND/);
      assert.match(other.output, /bot_talk/);
    }
    for (const s of r.seen.slice(before)) {
      assert.ok(!deepHasKey(s.body, "mind"), `${name}: mind leaked into ${JSON.stringify(s.body)}`);
      assert.ok(!deepHasKey(s.body, "owner_check"), `${name}: owner_check leaked`);
    }
  }
  // no read tool has been left without the optional mind argument; no write tool has it
  for (const t of r.tools) {
    const props = (t.spec.parameters as { properties: Record<string, unknown> }).properties;
    if (t.spec.name === "mind_tenants") assert.ok(!props.mind);
    else if (t.class === "read") assert.ok(props.mind, `${t.spec.name} should have mind`);
    else assert.ok(!props.mind, `${t.spec.name} must not have mind`);
  }
});

test("writes in a bot session ALWAYS go to the bot, even when the model asks for main", async () => {
  const r = rig("sales");
  const res = await r.by("mind_life_write").run({ action: "create", fields: { title: "t" }, mind: "main", owner_check: OWNER }, ctx);
  assert.equal(res.ok, false);
  assert.equal(r.seen.length, 0, "no request was made to any MIND");
  assert.match(res.output, /sales/);
});

test("unknown slug fails with the valid ones; no request is made", async () => {
  const r = rig("main");
  const res = await r.by("mind_query").run({ query: "q", mind: "nope" }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.output, /unknown MIND "nope"/);
  assert.match(res.output, /main, sales, ops/);
  assert.equal(r.seen.length, 0);
  assert.equal((await r.by("mind_query").run({ query: "q", mind: 7 as any }, ctx)).ok, false);
});

test("400 bot_unsupported becomes a clear tool error naming the tool and main", async () => {
  const r = rig("main", (req) => (req.headers["x-mind-bot"] ? json(400, { error: "bot_unsupported" }) : json(200, { ok: true })));
  const res = await r.by("mind_life").run({ action: "list", mind: "sales" }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.output, /that MIND \(sales\) doesn't support life for bots; use mind:"main"/);
  const home = rig("sales", () => json(400, { error: "bot_unsupported" }));
  const w = await home.by("mind_life_write").run({ action: "create", fields: {}, owner_check: OWNER }, ctx);
  assert.equal(w.ok, false);
  assert.match(w.output, /your bot MIND \(sales\) doesn't support life/);
});

test("mind_tenants returns the live roster (and is a mind receipt read)", async () => {
  const r = rig("sales");
  const t = r.by("mind_tenants");
  assert.equal(t.class, "read");
  assert.equal(t.receipt, "mind");
  const res = await t.run({}, ctx);
  assert.equal(res.ok, true);
  assert.match(res.output, /home: bot sales/);
  assert.match(res.output, /bot ops \(Ops\): runbooks/);
  // live: the roster function is re-read on every call
  const roster = [{ slug: "a", name: "A", purpose: "" }];
  const live = createMindTools({ home: "main", roster: () => roster, clientFor: () => ({}) as MindClient });
  const lt = live.find((x) => x.spec.name === "mind_tenants")!;
  assert.match((await lt.run({}, ctx)).output, /bot a \(A\)/);
  roster.push({ slug: "b", name: "B", purpose: "new" });
  assert.match((await lt.run({}, ctx)).output, /bot b \(B\): new/);
});

test("a plain client still works exactly as before (home main, no bots)", async () => {
  const f = fakeFetch(() => json(200, { id: "x1", response: "ok" }));
  const tools = createMindTools(createMindClient(cfg(), f.fetch, { retryDelayMs: 0 }));
  const q = tools.find((t) => t.spec.name === "mind_query")!;
  assert.equal((await q.run({ query: "q" }, ctx)).ok, true);
  assert.equal(f.seen[0].headers["x-mind-bot"], undefined);
  assert.equal((await q.run({ query: "q", mind: "main" }, ctx)).ok, true);
  const bad = await q.run({ query: "q", mind: "ghost" }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.output, /Valid: main/);
});

test("at most 3 cross-MIND reads run at once; same-MIND reads are not throttled", async () => {
  let inflight = 0, peak = 0;
  const gate: (() => void)[] = [];
  const client: MindClient = {
    context: async () => "", remember: async () => "",
    query: async () => { inflight++; peak = Math.max(peak, inflight); await new Promise<void>((r) => gate.push(r)); inflight--; return "ok"; },
    call: async () => "ok",
  };
  const tools = createMindTools({ home: "main", roster: () => [{ slug: "b", name: "B", purpose: "" }], clientFor: () => client });
  const q = tools.find((t) => t.spec.name === "mind_query")!;
  const runs = Array.from({ length: 6 }, (_, i) => q.run({ query: `q${i}`, mind: "b" }, ctx));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(inflight, 3, "only 3 in flight");
  while (gate.length || inflight) { gate.shift()?.(); await new Promise((r) => setTimeout(r, 5)); }
  const res = await Promise.all(runs);
  assert.ok(res.every((x) => x.ok));
  assert.equal(peak, 3);
  const s = new Semaphore(2);
  const a = await s.acquire(), b = await s.acquire();
  let third = false;
  const p = s.acquire().then((rel) => { third = true; return rel; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(third, false);
  a(); a(); // double release is harmless
  await p;
  assert.equal(third, true);
  b();
});

test("owner_check wording uses the signed-in username, never a hardcoded name", () => {
  const f = fakeFetch(() => json(200, {}));
  const named = createMindTools(createMindClient(cfg(), f.fetch), { user: "pat" });
  const plain = createMindTools(createMindClient(cfg(), f.fetch));
  for (const [tools, who] of [[named, "pat"], [plain, "the user"]] as const) {
    for (const t of tools.filter((x) => x.class === "write")) {
      const d = (t.spec.parameters as any).properties.owner_check?.description as string | undefined;
      if (!d) continue;
      assert.ok(d.includes(`${who} asked about`), `${t.spec.name}: ${d}`);
      assert.ok(!/Anthony/.test(d));
    }
  }
});

test("owner_check problem message names the user too", async () => {
  const r = rig("main");
  const res = await r.by("mind_remember").run({ title: "t", content: "c" }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.output, /pat asked about/);
  assert.ok(!/Anthony/.test(res.output));
});

// ---------- receipt gate: tenant-aware negative claims ----------
const rec = (id: string, tool: string, args: Record<string, unknown>, ok = true): CallRecord => ({
  receiptId: id, call: { id, name: tool, args }, tool, class: "read", receipt: "mind", result: { ok, output: "" }, at: 0,
});

test("negative claims need two differently worded queries on EACH tenant queried", () => {
  // two queries on one tenant: fine
  assert.equal(negativeEvidenceOk([rec("c1", "mind_query", { query: "is there X" }), rec("c2", "mind_query", { query: "find X please" })]), true);
  // the same two sentences asked of two MINDs are NOT enough for either
  assert.equal(negativeEvidenceOk([rec("c1", "mind_query", { query: "is there X", mind: "sales" }), rec("c2", "mind_query", { query: "is there X", mind: "ops" })]), false);
  // two on sales but only one on ops: the claim covers ops too, so not enough
  assert.equal(negativeEvidenceOk([
    rec("c1", "mind_query", { query: "a", mind: "sales" }), rec("c2", "mind_query", { query: "b", mind: "sales" }), rec("c3", "mind_query", { query: "a", mind: "ops" }),
  ]), false);
  // two each: enough
  assert.equal(negativeEvidenceOk([
    rec("c1", "mind_query", { query: "a", mind: "sales" }), rec("c2", "mind_query", { query: "b", mind: "sales" }),
    rec("c3", "mind_query", { query: "a", mind: "ops" }), rec("c4", "mind_query", { query: "b", mind: "ops" }),
  ]), true);
  // the home tenant (no mind arg) and an explicit mind are different tenants
  assert.equal(negativeEvidenceOk([rec("c1", "mind_query", { query: "a" }), rec("c2", "mind_query", { query: "b", mind: "main" })]), false);
  // a bare list on a tenant satisfies that tenant; the roster tool proves nothing about content
  assert.equal(negativeEvidenceOk([rec("c1", "mind_crm", { action: "list", list_bare: true, mind: "ops" })]), true);
  assert.equal(negativeEvidenceOk([rec("c1", "mind_tenants", {}), rec("c2", "mind_tenants", { x: 1 })]), false);
  // failed calls do not count
  assert.equal(negativeEvidenceOk([rec("c1", "mind_query", { query: "a" }), rec("c2", "mind_query", { query: "b" }, false)]), false);
});
