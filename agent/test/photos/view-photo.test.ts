// view_photo: the tool (provider stubbed), the providers' pinModel and user-image support, the prompt skill, the hosted allowlist,
// and the whole path through a MIND-billed hosted runtime (free tier and paid) with a fake MIND.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthContext } from "../../src/auth/index.ts";
import { userIdFor } from "../../src/auth/users.ts";
import { loadConfig } from "../../src/config.ts";
import { DailyCostCap, filterHostedTools, hostedToolAllowed } from "../../src/hosted.ts";
import { PHOTOS_SECTION, botSessionTools, composeSystemPrompt, createRuntime } from "../../src/runtime.ts";
import { MindBillingError, MindCredits, createMindProvider } from "../../src/provider/mind.ts";
import { ProviderHttpError, createOpenRouterProvider, toWireMessages } from "../../src/provider/openrouter.ts";
import { PhotoStore } from "../../src/photos.ts";
import { PermissionService } from "../../src/permissions/index.ts";
import { factsOf } from "../../src/permissions/rules.ts";
import { DEFAULT_VISION, createViewPhotoTool } from "../../src/tools/photo.ts";
import { createBuiltinTools } from "../../src/tools/index.ts";
import type { Message, Provider, StreamEvent, ToolContext } from "../../src/types.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { baseCfg, collect, fakeTool } from "../core/helpers.ts";
import { jpeg, png } from "./images.ts";

const rnd = () => randomBytes(18).toString("hex");

// ---------------------------------------------------------------- the tool, with a stub provider
interface Seen { model: string; pinned: boolean; messages: Message[]; tools: number }
type Step = { text?: string; cost?: number; throws?: Error };

class Stub implements Provider {
  name = "stub";
  seen: Seen[] = [];
  private step: (model: string, n: number) => Step;
  constructor(step: (model: string, n: number) => Step) { this.step = step; }
  async *stream(req: { model: string; messages: Message[]; tools: unknown[]; pinModel?: boolean }): AsyncIterable<StreamEvent> {
    this.seen.push({ model: req.model, pinned: req.pinModel === true, messages: req.messages, tools: req.tools.length });
    const r = this.step(req.model, this.seen.length);
    if (r.throws) throw r.throws;
    if (r.text) yield { type: "text", delta: r.text };
    yield { type: "done", usage: { promptTokens: 284, completionTokens: 40, costUsd: r.cost ?? 0.000087 }, finishReason: "stop" };
  }
}

const ctx = (sessionId = "s1"): ToolContext => ({ cwd: "/", sessionId });
async function rig(o: { photos?: number; free?: boolean; vision?: typeof DEFAULT_VISION; step?: (model: string, n: number) => Step } = {}) {
  const store = new PhotoStore({ dir: mkdtempSync(join(tmpdir(), "vp-")), owner: "u_alice" });
  const n = o.photos ?? 1;
  await store.add("s1", Array.from({ length: n }, (_, i) => ({ name: `estimate-${i + 1}.jpg`, mime: "image/jpeg" as const, data: jpeg(1024, 700, i), width: 1024, height: 700 })));
  const stub = new Stub(o.step ?? (() => ({ text: "Total: $5,211.50" })));
  const tool = createViewPhotoTool({ store, provider: stub, vision: o.vision, isFree: o.free === undefined ? undefined : () => o.free! });
  return { store, stub, tool };
}

test("view_photo: asks the default vision model (pinned, no tools) with the question and the photo, and reports the answer, model and cost", async () => {
  const { stub, tool } = await rig();
  const r = await tool.run({ photo: "p1", question: "read every line item, amount and total exactly" }, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.output, "Total: $5,211.50");
  assert.equal(stub.seen.length, 1);
  assert.equal(stub.seen[0].model, "google/gemini-2.5-flash-lite");
  assert.equal(stub.seen[0].pinned, true, "the vision call must not fall onto the chat fallbacks");
  assert.equal(stub.seen[0].tools, 0);
  const [sys, user] = stub.seen[0].messages;
  assert.equal(sys.role, "system");
  assert.match(sys.content, /Quote printed text and numbers exactly/);
  assert.equal(user.role, "user");
  assert.match(user.content, /read every line item, amount and total exactly/);
  assert.match(user.content, /p1 \(estimate-1\.jpg, 1024x700\)/);
  assert.equal(user.images?.length, 1);
  assert.match(user.images![0], /^data:image\/jpeg;base64,/);
  assert.deepEqual(Buffer.from(user.images![0].split(",")[1], "base64"), jpeg(1024, 700, 0), "the stored bytes, unchanged");
  assert.equal(r.meta?.costUsd, 0.000087);
  assert.equal(r.meta?.model, "google/gemini-2.5-flash-lite");
  assert.equal(r.meta?.fellBack, false);
  assert.equal(r.meta?.inputTokens, 284);
});

test("view_photo: it is a read tool with a surface receipt, so no permission card and the answer's numbers can cite it", async () => {
  const { tool } = await rig();
  assert.equal(tool.class, "read");
  assert.equal(tool.receipt, "surface");
  assert.equal(tool.classFor, undefined);
  assert.equal(tool.spec.name, "view_photo");
  assert.deepEqual((tool.spec.parameters as any).required, ["photo", "question"]);
});

test("view_photo never raises a permission card, in any mode (it only reads what the user attached; web reads still ask in Ask-for-everything)", () => {
  const svc = new PermissionService({ dir: mkdtempSync(join(tmpdir(), "vp-perm-")), owner: "u1" });
  const vp = factsOf("view_photo", "read", { photo: "p1", question: "total?" }, "/");
  const web = factsOf("web_fetch", "read", { url: "https://example.com/a" }, "/");
  for (const mode of ["risky", "writes", "everything"] as const) {
    svc.store.setMode(mode);
    assert.equal(svc.needsPrompt(vp), false, `view_photo in ${mode}`);
  }
  svc.store.setMode("everything");
  assert.equal(svc.needsPrompt(web), true, "the contrast: a web read still asks in this mode");
  assert.equal(svc.needsPrompt(vp, "everything"), false);
  assert.equal(svc.needsPrompt(vp, "writes"), false);
});

test("view_photo: when the first model fails the fallback model answers; cost is what was spent, and fellBack says so", async () => {
  const { stub, tool } = await rig({ step: (model) => (model.startsWith("google/") ? { throws: new ProviderHttpError(500, "boom") } : { text: "Total: $5,211.50", cost: 0.00018 }) });
  const r = await tool.run({ photo: "p1", question: "total?" }, ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(stub.seen.map((s) => s.model), ["google/gemini-2.5-flash-lite", "anthropic/claude-haiku-5.5"]);
  assert.ok(stub.seen.every((s) => s.pinned));
  assert.equal(r.meta?.model, "anthropic/claude-haiku-5.5");
  assert.equal(r.meta?.fellBack, true);
  assert.equal(r.meta?.costUsd, 0.00018);
});

test("view_photo: a model that answers with nothing (the chat model did that on images) counts as a failure and the next one is tried", async () => {
  const { stub, tool } = await rig({ step: (model) => (model.startsWith("google/") ? { text: "   ", cost: 0.00001 } : { text: "Total: $5,211.50", cost: 0.00018 }) });
  const r = await tool.run({ photo: "p1", question: "total?" }, ctx());
  assert.equal(r.ok, true);
  assert.equal(stub.seen.length, 2);
  assert.equal(r.meta?.costUsd, 0.00001 + 0.00018, "the empty attempt still cost money and is counted");
});

test("view_photo: an override model and fallback list (DAEBOT_VISION_MODEL / DAEBOT_VISION_FALLBACK) are used in order", async () => {
  const { stub, tool } = await rig({ vision: { model: "x/vision-a", fallback: ["x/vision-b", "x/vision-c", "x/vision-a"], freeModel: "x/free" }, step: (m) => (m === "x/vision-c" ? { text: "ok" } : { throws: new Error("down") }) });
  const r = await tool.run({ photo: "p1", question: "q" }, ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(stub.seen.map((s) => s.model), ["x/vision-a", "x/vision-b", "x/vision-c"], "deduped, in order");
});

test("view_photo: free-tier (Explorer) users are read with the free vision model only, never a paid one", async () => {
  const { stub, tool } = await rig({ free: true });
  const r = await tool.run({ photo: "p1", question: "total?" }, ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(stub.seen.map((s) => s.model), ["google/gemma-4-31b-it:free"]);
  assert.equal(stub.seen[0].pinned, true);
  assert.equal(r.meta?.free, true);
  // even when it fails, no paid model is tried (a paid fallback would only 402)
  const f = await rig({ free: true, step: () => ({ throws: new Error("down") }) });
  const bad = await f.tool.run({ photo: "p1", question: "total?" }, ctx());
  assert.equal(bad.ok, false);
  assert.equal(f.stub.seen.length, 1);
});

test("view_photo: a 429 from the free pool is a plain message, not a crash and not a stack", async () => {
  const f = await rig({ free: true, step: () => ({ throws: new ProviderHttpError(429, "google/gemma-4-31b-it:free: HTTP 429 {\"error\":{\"message\":\"Provider returned error\",\"code\":429}}") }) });
  const r = await f.tool.run({ photo: "p1", question: "total?" }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.output, /free vision model is busy right now/);
  assert.match(r.output, /try the photo again in a minute/i);
  assert.match(r.output, /do not describe the photo/i);
  assert.ok(!/HTTP 429|Provider returned|\bat \w+\.ts/.test(r.output), "no raw error text");
  // a 429 reported as the first SSE chunk (a plain Error) is recognised too
  const g = await rig({ free: true, step: () => ({ throws: new Error("provider stream error: Provider returned error 429 rate limited") }) });
  assert.match((await g.tool.run({ photo: "p1", question: "total?" }, ctx())).output, /free vision model is busy/);
  // paid users hear a different line
  const p = await rig({ step: () => ({ throws: new ProviderHttpError(429, "x") }) });
  const pr = await p.tool.run({ photo: "p1", question: "q" }, ctx());
  assert.match(pr.output, /vision model is busy right now \(rate limited\)/);
  assert.equal(p.stub.seen.length, 2, "both paid models were tried");
});

test("view_photo: out of MIND credits stops at once with MIND's own words", async () => {
  const err = new MindBillingError("insufficient_credits", { tier: "starter", creditsRemaining: 0, upgradeUrl: "https://m-i-n-d.ai/pricing-test" });
  const f = await rig({ step: () => ({ throws: err }) });
  const r = await f.tool.run({ photo: "p1", question: "q" }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.output, /used this month's plan usage/);
  assert.match(r.output, /pricing-test/);
  assert.equal(f.stub.seen.length, 1, "no other model can help");
});

test("view_photo: it only reaches the photos of the session it runs in", async () => {
  const { store, tool, stub } = await rig();
  await store.add("someone-elses-session", [{ name: "secret.jpg", mime: "image/jpeg", data: png(10, 10), width: 10, height: 10 }]);
  const mine = await tool.run({ photo: "all", question: "q" }, ctx("s1"));
  assert.equal(mine.ok, true);
  assert.equal(stub.seen[0].messages[1].images?.length, 1, "only s1's photo went to the model");
  // another session id (the model cannot choose it: it comes from the runtime) sees only its own photos
  const other = await tool.run({ photo: "p1", question: "q" }, ctx("a-session-with-no-photos"));
  assert.equal(other.ok, false);
  assert.match(other.output, /no photos/);
  // a photo id from another chat is just "not here"
  const miss = await tool.run({ photo: "p7", question: "q" }, ctx("s1"));
  assert.equal(miss.ok, false);
  assert.match(miss.output, /no photo "p7" in this chat\. Available: p1 \(estimate-1\.jpg\)/);
});

test("view_photo: ids, 'all', lists and the cap on how many go in one call", async () => {
  const { tool, stub } = await rig({ photos: 10 });
  const all = await tool.run({ photo: "all", question: "q" }, ctx());
  assert.equal(stub.seen[0].messages[1].images?.length, 8);
  assert.match(all.output, /Only the newest 8 of 10 photos were read/);
  assert.match(stub.seen[0].messages[1].content, /p3 \(estimate-3\.jpg/);
  await tool.run({ photo: "p1, p2", question: "q" }, ctx());
  assert.equal(stub.seen[1].messages[1].images?.length, 2);
  await tool.run({ photo: "2", question: "q" }, ctx());
  assert.match(stub.seen[2].messages[1].content, /p2 \(estimate-2\.jpg/);
  await tool.run({ question: "q" }, ctx()); // no photo argument reads the chat's photos
  assert.equal(stub.seen[3].messages[1].images?.length, 8);
});

test("view_photo: bad calls are refused before any model is paid", async () => {
  const { tool, stub } = await rig();
  assert.match((await tool.run({ photo: "p1" }, ctx())).output, /question is required/);
  assert.match((await tool.run({ photo: "p1", question: "x".repeat(2001) }, ctx())).output, /over 2000/);
  assert.equal(stub.seen.length, 0);
});

test("view_photo: an abort stops it without calling the next model", async () => {
  const { tool, stub } = await rig({ step: () => ({ throws: new Error("aborted") }) });
  const ac = new AbortController();
  ac.abort();
  const r = await tool.run({ photo: "p1", question: "q" }, { ...ctx(), signal: ac.signal });
  assert.equal(r.ok, false);
  assert.match(r.output, /stopped/);
  assert.equal(stub.seen.length, 0);
});

// ---------------------------------------------------------------- providers
test("toWireMessages: a user message with images becomes text then image_url parts; plain user messages are untouched", () => {
  const w = toWireMessages([{ role: "system", content: "S" }, { role: "user", content: "what is this?", images: ["data:image/jpeg;base64,AAAA", "data:image/png;base64,BBBB"] }, { role: "user", content: "plain" }]);
  assert.deepEqual(w[1], { role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }, { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }] });
  assert.deepEqual(w[2], { role: "user", content: "plain" });
});

const sse = (chunks: (object | string)[]): Response =>
  new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(chunks.map((x) => `data: ${typeof x === "string" ? x : JSON.stringify(x)}\n\n`).join(""))); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
const okSse = (text = "hi"): Response => sse([{ choices: [{ delta: { content: text } }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0.001 } }, "[DONE]"]);
const drain = async (it: AsyncIterable<StreamEvent>) => { const out: StreamEvent[] = []; for await (const e of it) out.push(e); return out; };

test("OpenRouter provider: pinModel tries exactly the one model; without it the fallback list still applies", async () => {
  const models: string[] = [];
  const f = (async (_u: unknown, init?: RequestInit) => { models.push(JSON.parse(String(init?.body)).model); return new Response("nope", { status: 500 }); }) as typeof fetch;
  const p = createOpenRouterProvider(baseCfg({ models: { default: "m/a", cheap: "m/a", fallback: ["m/b", "m/c"] } }), f, { backoffMs: 0 });
  await assert.rejects(drain(p.stream({ model: "v/vision", messages: [{ role: "user", content: "x" }], tools: [], pinModel: true })));
  assert.deepEqual(models.filter((m, i) => models.indexOf(m) === i), ["v/vision"]);
  models.length = 0;
  await assert.rejects(drain(p.stream({ model: "v/vision", messages: [{ role: "user", content: "x" }], tools: [] })));
  assert.deepEqual(models.filter((m, i) => models.indexOf(m) === i), ["v/vision", "m/b", "m/c"]);
});

test("MIND provider: pinModel on the free plan uses the exact model asked for (not the chat free model) and has no fallback", async () => {
  const calls: { model: string; key: string }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/credits")) return new Response(JSON.stringify({ tier: "free", credits_balance: 10, credits_limit: 10 }), { status: 200 });
    const body = JSON.parse(String(init?.body));
    calls.push({ model: body.model, key: (init?.headers as Record<string, string>)["X-API-Key"] });
    return okSse("seen");
  }) as typeof fetch;
  const cfg = baseCfg({ mindBaseUrl: "https://mind.test/developer/v1", billing: "mind", freeModel: "chat/free", openrouterKey: "" });
  const credits = new MindCredits({ mindBaseUrl: cfg.mindBaseUrl, fetchImpl: f });
  const p = createMindProvider(cfg, { getKey: () => "mind_alice", credits, fetchImpl: f, backoffMs: 0 });
  await drain(p.stream({ model: "google/gemma-4-31b-it:free", messages: [{ role: "user", content: "x" }], tools: [], pinModel: true }));
  assert.deepEqual(calls, [{ model: "google/gemma-4-31b-it:free", key: "mind_alice" }]);
  // unpinned chat on the same plan still swaps to the chat free model
  await drain(p.stream({ model: "m/paid", messages: [{ role: "user", content: "x" }], tools: [] }));
  assert.equal(calls[1].model, "chat/free");
});

// ---------------------------------------------------------------- prompt skill, allowlist, config
test("the system prompt has a short ## Photos skill when view_photo is offered, and not otherwise", () => {
  const withIt = composeSystemPrompt({ bootContext: "", surface: "web", cwd: "/", photos: true });
  assert.match(withIt, /## Photos/);
  assert.match(withIt, /\[photo p1: name\.jpg, 1024x768\]/);
  assert.match(withIt, /Call view_photo FIRST, with a specific question tied to what they asked/);
  assert.match(withIt, /read every line item, amount and total exactly/);
  assert.match(withIt, /Never describe or summarise a photo/);
  assert.match(withIt, /Quote numbers and text exactly as view_photo returned them/);
  assert.match(withIt, /SURFACE✓ #cN/);
  assert.match(withIt, /unreadable.*ask for a clearer photo/);
  assert.ok(PHOTOS_SECTION.join("\n").length < 1200, "short");
  assert.ok(!composeSystemPrompt({ bootContext: "", surface: "web", cwd: "/" }).includes("## Photos"));
  assert.ok(!composeSystemPrompt({ bootContext: "", surface: "web", cwd: "/", photos: false }).includes("view_photo"));
});

test("the hosted allowlist contains view_photo (and still refuses host tools)", () => {
  assert.equal(hostedToolAllowed("view_photo"), true);
  assert.equal(hostedToolAllowed("bash"), false);
  assert.equal(hostedToolAllowed("view_photos"), false, "exact name only");
  const kept = filterHostedTools([fakeTool("view_photo", "read"), fakeTool("bash", "write"), fakeTool("web_fetch", "read")]).map((t) => t.spec.name);
  assert.deepEqual(kept, ["view_photo", "web_fetch"]);
});

test("config: vision models default to the measured pair and read DAEBOT_VISION_MODEL / _FALLBACK / _FREE_MODEL", () => {
  const empty = { MINDCLAW_CONFIG: "/nonexistent/cfg.json" } as NodeJS.ProcessEnv;
  assert.deepEqual(loadConfig(empty).vision, { model: "google/gemini-2.5-flash-lite", fallback: ["anthropic/claude-haiku-5.5"], freeModel: "google/gemma-4-31b-it:free" });
  assert.deepEqual(loadConfig({ ...empty, DAEBOT_VISION_MODEL: "a/b", DAEBOT_VISION_FALLBACK: "c/d, e/f ,", DAEBOT_VISION_FREE_MODEL: "g/h:free" }).vision, { model: "a/b", fallback: ["c/d", "e/f"], freeModel: "g/h:free" });
  assert.deepEqual(DEFAULT_VISION, loadConfig(empty).vision);
});

test("the builtin tools do not include view_photo (it needs a runtime's store and provider)", () => {
  assert.ok(!createBuiltinTools({ computer: false }).some((t) => t.spec.name === "view_photo"));
});

// ---------------------------------------------------------------- through a hosted, MIND-billed runtime
const SSE_TOOL = (args: object): Response => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_vp", function: { name: "view_photo", arguments: JSON.stringify(args) } }] } }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } }, "[DONE]"]);

interface Llm { model: string; key: string; body: any }
async function hosted(tier: "starter" | "free") {
  const alice = "mind_" + rnd();
  const fake = await startFakeMind({ [alice]: "alice" });
  const llm: Llm[] = [];
  const script = (n: number, model: string): Response => {
    // chat round 1 asks for the photo; the vision call answers; chat round 2 answers the user
    if (model.includes("gemini") || model.includes("gemma") || model.includes("haiku")) return okSse("Estimate total: $5,211.50");
    return llm.filter((c) => !/gemini|gemma|haiku/.test(c.model)).length === 1 ? SSE_TOOL({ photo: "p1", question: "read every line item, amount and total exactly" }) : okSse("SURFACE✓ #c1 view_photo -> the total is $5,211.50");
  };
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = (init?.headers ?? {}) as Record<string, string>;
    if (url.endsWith("/llm/chat/completions")) {
      const body = JSON.parse(String(init?.body));
      llm.push({ model: body.model, key: h["X-API-Key"], body });
      return script(llm.length - 1, body.model);
    }
    if (url.endsWith("/credits")) return new Response(JSON.stringify({ tier, credits_balance: 100, credits_limit: 100 }), { status: 200 });
    return fetch(input as never, init);
  }) as typeof fetch;
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "mind_server_" + rnd(), openrouterKey: "", billing: "mind", freeModel: "chat/free", models: { default: "chat/default", cheap: "chat/cheap", fallback: [] } });
  const credits = new MindCredits({ mindBaseUrl: cfg.mindBaseUrl, fetchImpl: f });
  const dir = mkdtempSync(join(tmpdir(), "vp-hosted-"));
  const globalCap = new DailyCostCap(50);
  const ownerRuntime = createRuntime(cfg, { fetchImpl: f, credits, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const hostedOpts = { token: rnd(), allowedHosts: ["daebot.live", "localhost"] };
  const auth = createAuthContext({ env: { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd() }, cfg, hosted: hostedOpts, ownerRuntime, globalCap, fetchImpl: f, credits, bots: { dir, bus: {} } });
  auth.store.upsert("alice", { kind: "key", mindKey: alice });
  const rt = auth.runtimeFor(auth.store.principal(userIdFor("alice"))!);
  return { rt, llm, alice, close: () => fake.close() };
}

async function runPhotoTurn(w: Awaited<ReturnType<typeof hosted>>) {
  const s = await w.rt.openSession({ surface: "web" });
  const added = await w.rt.photos!.add(s.id, [{ name: "estimate.jpg", mime: "image/jpeg", data: jpeg(1024, 700), width: 1024, height: 700 }]);
  assert.ok(added.ok);
  const refs = added.photos.map(({ id, name, width, height }) => ({ id, name, width, height }));
  const ev = await collect(s.send("What is the total on this estimate?", { interactive: true, photos: refs }));
  return { s, ev };
}

test("hosted + MIND billing, paid plan: the model is told about the photo, calls view_photo with no permission card, and the vision call bills the user's own key on the default vision model", async () => {
  const w = await hosted("starter");
  try {
    const { ev } = await runPhotoTurn(w);
    // the first chat request carried the Photos skill and the photo line, and offered view_photo
    const chat = w.llm.filter((c) => c.model === "chat/default");
    assert.equal(chat.length, 2);
    const first = chat[0].body.messages;
    assert.match(first[0].content, /## Photos/);
    assert.match(first.at(-1).content, /What is the total on this estimate\?\n\n\[photo p1: estimate\.jpg, 1024x700\]/);
    assert.ok(chat[0].body.tools.some((t: any) => t.function.name === "view_photo"));
    // the vision call: user's key, default vision model, the image as an image_url part, and only that one model tried
    const vision = w.llm.filter((c) => c.model !== "chat/default");
    assert.equal(vision.length, 1);
    assert.equal(vision[0].model, "google/gemini-2.5-flash-lite");
    assert.equal(vision[0].key, w.alice);
    const parts = vision[0].body.messages.find((m: any) => m.role === "user").content;
    assert.equal(parts[0].type, "text");
    assert.match(parts[0].text, /read every line item, amount and total exactly/);
    assert.match(parts[1].image_url.url, /^data:image\/jpeg;base64,/);
    // no permission card, the tool ran ok, its cost joined the turn, and the answer reached the user
    assert.ok(!ev.some((e) => e.type === "permission"), "view_photo is read-only: no card");
    const end = ev.find((e) => e.type === "toolEnd") as any;
    assert.equal(end.tool, "view_photo");
    assert.equal(end.ok, true);
    assert.match(end.preview, /\$5,211\.50/);
    const usage = ev.filter((e) => e.type === "usage") as any[];
    assert.ok(usage.some((u) => u.model === "google/gemini-2.5-flash-lite" && u.usage.costUsd > 0), "vision cost is reported");
    const done = ev.at(-1) as any;
    assert.match(done.finalText, /\$5,211\.50/);
    assert.ok(!ev.some((e) => e.type === "gate" && (e as any).verdict.gate === "receipt"), "the surface receipt of view_photo backs the quoted total");
    // the transcript keeps the user's own words and the photo, not the model-facing photo line
    const hist = w.rt.history!((await w.rt.listSessions())[0].id)!;
    const user = hist.find((h) => h.type === "user") as any;
    assert.equal(user.text, "What is the total on this estimate?");
    assert.deepEqual(user.photos, [{ id: "p1", name: "estimate.jpg", width: 1024, height: 700 }]);
  } finally { await w.close(); }
});

test("hosted + MIND billing, free plan (Explorer): the photo is read with the free vision model only", async () => {
  const w = await hosted("free");
  try {
    await runPhotoTurn(w);
    const vision = w.llm.filter((c) => !c.model.startsWith("chat/"));
    assert.equal(vision.length, 1);
    assert.equal(vision[0].model, "google/gemma-4-31b-it:free");
    assert.equal(vision[0].key, w.alice);
    assert.ok(w.llm.filter((c) => c.model.startsWith("chat/")).every((c) => c.model === "chat/free"), "chat itself runs on the free chat model");
  } finally { await w.close(); }
});

test("bot sessions keep view_photo (they lose only shell and file writes)", async () => {
  const { tool } = await rig();
  const kept = botSessionTools([tool, fakeTool("bash", "write"), fakeTool("write_file", "write"), fakeTool("web_fetch", "read")]).map((t) => t.spec.name);
  assert.deepEqual(kept, ["view_photo", "web_fetch"]);
});

test("deleting a chat deletes its photos", async () => {
  const w = await hosted("starter");
  try {
    const { s } = await runPhotoTurn(w);
    assert.equal(w.rt.photos!.list(s.id).length, 1);
    assert.equal(await w.rt.deleteSession!(s.id), true);
    assert.equal(w.rt.photos!.list(s.id).length, 0, "photos go with the chat");
    assert.equal(await w.rt.photos!.read(s.id, "p1"), undefined);
  } finally { await w.close(); }
});
