// Regression tests: narration gating (D7), loop/kernel wiring, config keys, runtime tiers, degraded boot, session keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "../../src/loop.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { loadConfig } from "../../src/config.ts";
import { createRuntime } from "../../src/runtime.ts";
import { visibleText } from "../../src/events.ts";
import type { AgentEvent, Tool } from "../../src/types.ts";
import { FakeKernel, FakeProvider, FakeSync, baseCfg, call, collect, fakeTool } from "./helpers.ts";

// text streams before pre_answer runs, so what the user SEES is the text minus retracted drafts
const texts = (ev: AgentEvent[]) => [visibleText(ev)];

function real(rounds: ConstructorParameters<typeof FakeProvider>[0], tools: Tool[], extra: { cfg?: any; kernel?: any } = {}) {
  const provider = new FakeProvider(rounds);
  const session = createAgentSession({
    id: "s1", surface: "headless", provider, kernel: extra.kernel ?? createKernel({ shadow: false, enabled: true }), tools, sync: new FakeSync(),
    cfg: baseCfg(extra.cfg), cwd: process.cwd(), systemPrompt: "SYS", bootContext: "BOOT",
  });
  return { provider, session };
}

// ---------- D7 ----------
test("D7: unreceipted claim in tool-round narration is withheld, the call still runs through its own gates, the model is told", async () => {
  const t = fakeTool("read_file", "read", "file", "surface");
  const { session, provider } = real([
    { text: "The contact is Andrew at andrew@ysf.org.", calls: [call("a", "read_file", { path: "x" })] },
    { text: "I read the file." },
  ], [t]);
  const ev = await collect(session.send("who is the contact?"));
  assert.ok(!texts(ev).join("").includes("andrew@ysf.org"), "narration must not reach the user");
  assert.equal(t.calls.length, 1);
  const gate = ev.find((e) => e.type === "gate") as any;
  assert.equal(gate.verdict.gate, "receipt");
  assert.equal(gate.enforced, true);
  const second = provider.requests[1].messages;
  assert.ok(second.some((m) => m.role === "system" && m.content.startsWith("[kernel:receipt] Your last message was withheld")));
  assert.equal(second.find((m) => m.role === "assistant")!.content, "");
  assert.equal((ev.at(-1) as any).finalText, "I read the file.");
});
test("D7: clean narration is shown; narration citing a real receipt from this turn passes", async () => {
  const t = fakeTool("mind_query", "read", "ans", "mind");
  const { session } = real([
    { calls: [call("a", "mind_query", { query: "price" })] },
    { text: "Price is $49.\nMIND✓ #c1 price", calls: [call("b", "mind_query", { query: "other" })] },
    { text: "Checking one more thing." },
  ], [t]);
  const ev = await collect(session.send("price?"));
  assert.ok(texts(ev).join("").includes("$49"));
  assert.ok(!ev.some((e) => e.type === "gate"));
});
test("D7: narration on the confirm path is checked too", async () => {
  const send = fakeTool("send_email", "outward", "sent");
  const { session } = real([{ text: "Sending to bob@example.com now.", calls: [call("a", "send_email", { to: "bob@example.com" })] }], [send]);
  const ev = await collect(session.send("email bob"));
  assert.ok(!texts(ev).join("").includes("bob@example.com"));
  assert.ok(ev.some((e) => e.type === "confirm"));
  assert.equal(send.calls.length, 0);
});
test("D7: shadow mode shows the narration and logs enforced:false", async () => {
  const t = fakeTool("read_file", "read", "f", "surface");
  const { session } = real([
    { text: "Mail andrew@ysf.org.", calls: [call("a", "read_file", {})] }, { text: "ok" },
  ], [t], { cfg: { shadow: true }, kernel: createKernel({ shadow: true, enabled: true }) });
  const ev = await collect(session.send("who"));
  assert.ok(texts(ev).join("").includes("andrew@ysf.org"));
  assert.ok(ev.some((e) => e.type === "gate" && (e as any).enforced === false));
});

// ---------- (g) loop uses kernel.onUserMessage ----------
test("loop calls kernel.onUserMessage for every user message (no dynamic kernel import)", async () => {
  const k = new FakeKernel();
  const seen: string[] = [];
  k.onUserMessage = (_s: any, m: string) => { seen.push(m); };
  const { session } = real([{ text: "hi" }, { text: "hi again" }], [], { kernel: k });
  await collect(session.send("one"));
  await collect(session.send("two"));
  assert.deepEqual(seen, ["one", "two"]);
});
test("loop survives a kernel without onUserMessage and records classFor in the call record", async () => {
  const t = { ...fakeTool("mind_tasks_write", "write", "ok"), classFor: (a: any) => (a.action === "delete" ? "irreversible" as const : "write" as const) };
  let cls = "";
  const k: any = {
    allowedTools: (_s: any, all: Tool[]) => all, preTurn: () => [], preTool: () => [],
    preAnswer: (s: any) => { cls = s.calls[0].class; return []; }, postTurn() {}, violations: () => [],
  };
  const { session } = real([{ calls: [call("a", "mind_tasks_write", { action: "delete" })] }, { text: "ok" }], [t], { kernel: k });
  await collect(session.send("go"));
  assert.equal(cls, "irreversible");
});
test("a delete through a write tool needs an explicit go end to end", async () => {
  const t = { ...fakeTool("mind_tasks_write", "write", "ok"), classFor: (a: any) => (a.action === "delete" ? "irreversible" as const : "write" as const) };
  const args = { action: "delete", task_id: "7", owner_check: "task belongs to Atlas; Anthony asked about Atlas; Atlas == Atlas" };
  const { session } = real([{ calls: [call("a", "mind_tasks_write", args)] }, { calls: [call("b", "mind_tasks_write", args)] }, { text: "deleted it" }], [t]);
  const e1 = await collect(session.send("delete task 7"));
  assert.ok(e1.some((e) => e.type === "confirm"));
  assert.equal(t.calls.length, 0);
  const e2 = await collect(session.send("do it"));
  assert.equal(t.calls.length, 1);
  assert.ok(!e2.some((e) => e.type === "confirm"));
});

// ---------- config ----------
test("config: session key falls back to the main key, env wins, client names parse", () => {
  const none = join(mkdtempSync(join(tmpdir(), "mc-")), "none.json");
  const a = loadConfig({ MINDCLAW_CONFIG: none, MIND_API_KEY: "mk" });
  assert.equal(a.mindSessionApiKey, "mk");
  assert.deepEqual(a.clientNames, []);
  const b = loadConfig({ MINDCLAW_CONFIG: none, MIND_API_KEY: "mk", MIND_SESSION_API_KEY: "sk", MINDCLAW_CLIENT_NAMES: "Atlas, Partner Claim Services ,," });
  assert.equal(b.mindSessionApiKey, "sk");
  assert.deepEqual(b.clientNames, ["Atlas", "Partner Claim Services"]);
  const f = join(mkdtempSync(join(tmpdir(), "mc-")), "config.json");
  writeFileSync(f, JSON.stringify({ mindApiKey: "fk", mindSessionApiKey: "fsk", clientNames: ["Atlas"] }));
  const c = loadConfig({ MINDCLAW_CONFIG: f });
  assert.equal(c.mindSessionApiKey, "fsk");
  assert.deepEqual(c.clientNames, ["Atlas"]);
  assert.equal(loadConfig({ MINDCLAW_CONFIG: f, MIND_SESSION_API_KEY: "esk" }).mindSessionApiKey, "esk");
});

// ---------- runtime ----------
function mindFetch(opts: { contextFails?: boolean } = {}) {
  const seen: { url: string; key: string; body: any }[] = [];
  const f = (async (url: any, init: any = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    seen.push({ url: u, key: headers["x-api-key"] ?? "", body });
    const ok = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (/agent[-_]sessions/.test(u)) return ok({ session_id: "MS1", pending_replies: [] });
    if (/context/.test(u) && !opts.contextFails) return ok({ sections: [{ section: "soul", items: ["Dae"] }] });
    if (/context/.test(u)) return new Response("{}", { status: 502 });
    return ok({ response: "fine" });
  }) as unknown as typeof fetch;
  return { f, seen };
}
const toolNames = (p: FakeProvider, i = 0) => p.requests[i].tools.map((t) => t.name);

test("runtime tiers: public sees only read tools, staff adds local writes, admin sees all", async () => {
  const { f } = mindFetch();
  const out: Record<string, string[]> = {};
  for (const identity of [undefined, "admin", "staff", "public"]) {
    const provider = new FakeProvider([{ text: "ok" }]);
    const rt = createRuntime(baseCfg({ mindApiKey: "mind_KEY1234567890abcd" }), { provider, fetchImpl: f });
    const s = await rt.openSession({ surface: "telegram", title: "t", identity });
    await collect(s.send("please post this to the feed"));
    out[String(identity)] = toolNames(provider);
    await s.close();
  }
  assert.deepEqual(out.undefined, out.admin);
  assert.ok(out.admin.includes("bash") && out.admin.includes("mind_feed_post") && out.admin.includes("mind_tasks_write"));
  assert.ok(out.staff.includes("bash") && out.staff.includes("mind_tasks_write") && out.staff.includes("write_file"));
  assert.ok(!out.staff.includes("mind_feed_post") && !out.staff.includes("mind_social"));
  assert.ok(out.public.includes("mind_query") && out.public.includes("read_file"));
  for (const hidden of ["bash", "write_file", "edit_file", "mind_remember", "mind_tasks_write", "mind_feed_post", "mind_folders"]) {
    assert.ok(!out.public.includes(hidden), `public must not see ${hidden}`);
  }
});
test("runtime tiers: a hidden tool the public model calls anyway does not run", async () => {
  const { f, seen } = mindFetch();
  const provider = new FakeProvider([
    { calls: [call("a", "mind_remember", { title: "x", content: "y", owner_check: "a belongs to X; asked about X; X == X" })] },
    { text: "ok" },
  ]);
  const rt = createRuntime(baseCfg({ mindApiKey: "mind_KEY1234567890abcd" }), { provider, fetchImpl: f });
  const s = await rt.openSession({ surface: "telegram", title: "t", identity: "public" });
  const ev = await collect(s.send("save this"));
  assert.ok(ev.some((e) => e.type === "toolEnd") === false);
  assert.ok(!seen.some((r) => /remember/.test(r.url)));
  assert.ok(provider.requests[1].messages.some((m) => m.role === "tool" && /unknown tool/.test(m.content)));
});
test("runtime: unknown identities fail closed to public; resuming under a different tier is refused", async () => {
  const { f } = mindFetch();
  const provider = new FakeProvider([{ text: "ok" }]);
  const rt = createRuntime(baseCfg({ mindApiKey: "mind_KEY1234567890abcd" }), { provider, fetchImpl: f });
  const s = await rt.openSession({ surface: "discord", title: "t", identity: "weird", resumeId: "r1" });
  await collect(s.send("hi"));
  assert.ok(!toolNames(provider).includes("bash"));
  await assert.rejects(() => rt.openSession({ surface: "discord", resumeId: "r1" }), /different identity tier/);
  assert.equal((await rt.openSession({ surface: "discord", resumeId: "r1", identity: "weird" })).id, s.id);
});
test("runtime: session sync uses MIND_SESSION_API_KEY and a per-session externalId; other calls use the main key", async () => {
  const { f, seen } = mindFetch();
  const rt = createRuntime(baseCfg({ mindApiKey: "mind_MAIN1234567890abcd", mindSessionApiKey: "mind_SESS1234567890abcd" }), { provider: new FakeProvider([{ text: "ok" }]), fetchImpl: f });
  const s = await rt.openSession({ surface: "web", title: "t" });
  await collect(s.send("hi"));
  const open = seen.find((r) => /agent-sessions\/open/.test(r.url))!;
  assert.equal(open.key, "mind_SESS1234567890abcd");
  assert.equal(open.body.external_session_id, s.id);
  assert.match(open.body.source_key, new RegExp(`^mindclaw-web-${s.id}$`));
  assert.ok(seen.filter((r) => /context/.test(r.url)).every((r) => r.key === "mind_MAIN1234567890abcd"));
  const s2 = await rt.openSession({ surface: "web", title: "t2" });
  const opens = seen.filter((r) => /agent-sessions\/open/.test(r.url));
  assert.notEqual(opens[0].body.external_session_id, opens[1].body.external_session_id);
  assert.notEqual(s2.id, s.id);
});
test("runtime: a degraded boot is ONE info notice at the end of the first turn, never a failure or headline", async () => {
  // context fails twice, then profile + priorities succeed => ok:true, degraded:true
  const { f } = mindFetch({ contextFails: true });
  const rt = createRuntime(baseCfg({ mindApiKey: "mind_KEY1234567890abcd" }), { provider: new FakeProvider([{ text: "hello" }, { text: "again" }]), fetchImpl: f });
  const s = await rt.openSession({ surface: "headless", title: "t" });
  const e1 = await collect(s.send("hi"));
  const notices = e1.filter((e) => e.type === "notice") as any[];
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "info");
  assert.ok(!/boot failed/i.test(notices[0].text) && !notices[0].text.includes("\n"));
  assert.equal(e1.at(-1)!.type, "done");
  assert.equal(e1.indexOf(notices[0]), e1.length - 2, "notice sits right before done, not at the start");
  const e2 = await collect(s.send("again"));
  assert.equal(e2.filter((e) => e.type === "notice").length, 0);
});
