import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createOpenRouterProvider } from "../../src/provider/index.ts";
import { acceptsImages, clearVisionCapabilities, setVisionCapabilities } from "../../src/provider/vision.ts";
import type { Message, StreamEvent } from "../../src/types.ts";
import { baseCfg } from "./helpers.ts";

beforeEach(() => clearVisionCapabilities());

const ok = (text = "ok") => new Response(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`), { status: 200, headers: { "content-type": "text/event-stream" } });
const drain = async (it: AsyncIterable<StreamEvent>) => { const o: StreamEvent[] = []; for await (const e of it) o.push(e); return o; };
const NOIMG = JSON.stringify({ error: { message: "No endpoints found that support image input", code: 404 } });
const shot: Message[] = [
  { role: "user", content: "look at my screen" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "screen", args: {} }] },
  { role: "tool", toolCallId: "c1", name: "screen", content: "captured", images: ["data:image/png;base64,AAAA"] },
];
const hasImg = (body: any) => JSON.stringify(body.messages).includes("image_url");

// Like production: text-only models 404 on any image part.
function fakeFetch(log: { model: string; img: boolean }[]) {
  return (async (_u: string, init: any) => {
    const b = JSON.parse(init.body);
    const img = hasImg(b);
    log.push({ model: b.model, img });
    if (img && !acceptsImages(b.model)) return new Response(NOIMG, { status: 404 });
    if (b.model === "vis/primary") return new Response("boom", { status: 503 });
    return ok();
  }) as any;
}

test("primary fails, fallback is text-only, request carries a screenshot: no image ever reaches the text-only model", async () => {
  setVisionCapabilities({ "vis/primary": true, "text/fallback": false });
  const log: { model: string; img: boolean }[] = [];
  const cfg = baseCfg(); cfg.models = { ...cfg.models, fallback: ["text/fallback"] };
  const p = createOpenRouterProvider(cfg, fakeFetch(log), { backoffMs: 0 });
  const ev = await drain(p.stream({ model: "vis/primary", messages: shot, tools: [] }));
  assert.equal(ev.at(-1)?.type, "done");
  assert.deepEqual(log.filter((l) => l.model === "text/fallback").map((l) => l.img), [false]);
  assert.ok(log.some((l) => l.model === "vis/primary" && l.img));
});

test("selected model is text-only (deepseek) and a screenshot is attached: the call is routed to the vision default, not erred", async () => {
  setVisionCapabilities({ "text/only": false, "vis/default": true });
  const log: { model: string; img: boolean }[] = [];
  const cfg = baseCfg(); cfg.models = { default: "vis/default", cheap: "vis/default", fallback: ["text/only"] };
  const ev = await drain(createOpenRouterProvider(cfg, fakeFetch(log), { backoffMs: 0 }).stream({ model: "text/only", messages: shot, tools: [] }));
  assert.equal(ev.at(-1)?.type, "done");
  assert.deepEqual(log, [{ model: "vis/default", img: true }]);
});

test("only text-only models exist: the turn completes with the screenshot stripped and a note", async () => {
  setVisionCapabilities({ "text/only": false });
  let sent: any;
  const f = (async (_u: string, init: any) => { sent = JSON.parse(init.body); return ok(); }) as any;
  const cfg = baseCfg(); cfg.models = { default: "text/only", cheap: "text/only", fallback: [] }; cfg.vision = undefined;
  const ev = await drain(createOpenRouterProvider(cfg, f, { backoffMs: 0 }).stream({ model: "text/only", messages: shot, tools: [] }));
  assert.equal(ev.at(-1)?.type, "done");
  assert.equal(hasImg(sent), false);
  assert.match(JSON.stringify(sent.messages), /not shown/);
});

test("free-tier shape: explicit imageModels route screenshots to the free vision model", async () => {
  setVisionCapabilities({ "free/text": false, "free/vision": true });
  const log: { model: string; img: boolean }[] = [];
  const cfg = baseCfg(); cfg.models = { ...cfg.models, fallback: [] };
  await drain(createOpenRouterProvider(cfg, fakeFetch(log), { backoffMs: 0, imageModels: ["free/vision"] }).stream({ model: "free/text", messages: shot, tools: [] }));
  assert.equal(log[0]?.model, "free/vision");
});

test("no images: model order is unchanged and text-only fallbacks still work", async () => {
  setVisionCapabilities({ "text/fallback": false, "vis/primary": true });
  const log: { model: string; img: boolean }[] = [];
  const cfg = baseCfg(); cfg.models = { ...cfg.models, fallback: ["text/fallback"] };
  await drain(createOpenRouterProvider(cfg, fakeFetch(log), { backoffMs: 0 }).stream({ model: "vis/primary", messages: [{ role: "user", content: "hi" }], tools: [] }));
  assert.deepEqual(log.map((l) => l.model), ["vis/primary", "vis/primary", "text/fallback"]);
});

test("static list knows the live models", () => {
  assert.equal(acceptsImages("qwen/qwen3.8-flash"), true);
  assert.equal(acceptsImages("deepseek/deepseek-v4-flash"), false);
  assert.equal(acceptsImages("nvidia/nemotron-3-super-120b-a12b:free"), false);
  assert.equal(acceptsImages("google/gemma-4-31b-it:free"), true);
});
