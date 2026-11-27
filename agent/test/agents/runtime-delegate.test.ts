import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { FakeProvider, baseCfg, call, collect } from "../core/helpers.ts";

const rnd = () => randomBytes(12).toString("hex");

async function world(rounds: ConstructorParameters<typeof FakeProvider>[0], o: { hosted?: boolean; identity?: string } = {}) {
  const key = "mind_" + rnd();
  const fake = await startFakeMind({ [key]: "pat" });
  fake.contextText = { soul: "SOUL: be exact", user: "USER: Pat", rules: "RULE: receipts", priorities: "P1: ship the code map", recent: "R: none" };
  fake.queryAnswer = () => "Lesson: the loop owns retries.";
  const provider = new FakeProvider(rounds);
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: key });
  const dir = mkdtempSync(join(tmpdir(), "delegate-rt-"));
  const rt = createRuntime(cfg, { provider, store: createFileStore(dir), ...(o.hosted ? { hosted: { dailyUsdCap: 50, username: "pat", exempt: true } } : {}) });
  const s = await rt.openSession({ surface: "web", identity: o.identity ?? "admin" });
  return { fake, provider, rt, s };
}

const TASKS = { tasks: [{ title: "Find the loop", prompt: "Find where the turn loop of this agent lives and name the file", kind: "explore" }] };

test("delegate end to end: a helper session runs with the same MIND boot and only read-only tools; its report comes back to the caller", async () => {
  const w = await world([
    { calls: [call("d1", "delegate", TASKS)] },
    { text: "The turn loop is in src/loop.ts (createAgentSession)." },
    { text: "Here is what the helper found." },
  ]);
  try {
    const ev = await collect(w.s.send("use a helper in parallel to explore the codebase: where is the turn loop?"));
    const parentTools = w.provider.requests[0].tools.map((t) => t.name);
    assert.ok(parentTools.includes("delegate"), "the caller is offered delegate");
    assert.ok(parentTools.includes("code_map"), "a local session gets code_map");
    const helperReq = w.provider.requests[1];
    const helperTools = helperReq.tools.map((t) => t.name);
    for (const banned of ["delegate", "bash", "write_file", "edit_file", "process", "mind_remember", "bot_talk"]) assert.ok(!helperTools.includes(banned), `helper must not get ${banned}`);
    assert.ok(helperTools.includes("read_file") && helperTools.includes("grep") && helperTools.includes("code_map"), helperTools.join(","));
    const helperSystem = String(helperReq.messages[0].content);
    assert.match(helperSystem, /SOUL: be exact/, "the helper starts from the same MIND boot");
    const helperUser = helperReq.messages.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n");
    assert.match(helperUser, /helper 1 of 1/);
    assert.match(helperUser, /Find where the turn loop/);
    const end = ev.find((e) => e.type === "toolEnd" && e.tool === "delegate") as any;
    assert.ok(end, "delegate ran");
    assert.equal(end.ok, true, end.preview);
    assert.match(end.preview, /1 of 1 helper\(s\) finished/);
    const toolMsg = w.provider.requests[2].messages.find((m) => m.role === "tool");
    assert.match(String(toolMsg?.content), /The turn loop is in src\/loop\.ts/);
    assert.equal((ev.at(-1) as any).finalText, "Here is what the helper found.");
    // The helper is not a saved chat: only the caller's session is listed.
    assert.equal(w.rt.listSessions().length, 1);
  } finally { await w.s.close(); await w.fake.close(); }
});

test("delegate is not offered to the public tier; a hosted session gets delegate but never code_map", async () => {
  const pub = await world([{ text: "hi" }], { identity: "public" });
  try {
    await collect(pub.s.send("use helpers in parallel to research queues"));
    const names = pub.provider.requests[0].tools.map((t) => t.name);
    assert.ok(!names.includes("delegate"));
  } finally { await pub.s.close(); await pub.fake.close(); }
  const hosted = await world([{ text: "hi" }], { hosted: true });
  try {
    await collect(hosted.s.send("use helpers in parallel to research the codebase"));
    const names = hosted.provider.requests[0].tools.map((t) => t.name);
    assert.ok(names.includes("delegate"), names.join(","));
    assert.ok(!names.includes("code_map"), "hosted never reads the server's files");
  } finally { await hosted.s.close(); await hosted.fake.close(); }
});

test("the user's own deny rule binds a helper too: a helper's denied call never runs", async () => {
  const key = "mind_" + rnd();
  const fake = await startFakeMind({ [key]: "pat" });
  const dir = mkdtempSync(join(tmpdir(), "delegate-perm-"));
  const provider = new FakeProvider([
    { calls: [call("d1", "delegate", TASKS)] },
    { calls: [call("h1", "web_fetch", { url: "https://blocked.example.com/x" })] },
    { text: "The helper could not fetch it." },
    { text: "Done." },
  ]);
  const rt = createRuntime(baseCfg({ mindBaseUrl: fake.base, mindApiKey: key }), { provider, store: createFileStore(dir), stateDir: dir });
  rt.permissions!.store.addRule({ effect: "deny", tool: "web_fetch", matcher: { kind: "domain", value: "blocked.example.com" }, scope: "fetch blocked.example.com" }, "read");
  const s = await rt.openSession({ surface: "web", identity: "admin" });
  try {
    await collect(s.send("use a helper in parallel to explore the codebase"));
    const toolMsg = provider.requests[2].messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
    assert.match(toolMsg, /blocked by a permission rule you \(the user\) set/, toolMsg.slice(0, 300));
  } finally { await s.close(); await fake.close(); }
});
