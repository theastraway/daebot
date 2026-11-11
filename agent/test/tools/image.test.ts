import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhotoStore } from "../../src/photos.ts";
import { createImageGenerateTool, imageUrlOf, modalitiesFor } from "../../src/tools/image.ts";
import { hostedToolAllowed } from "../../src/hosted.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const DATA = `data:image/png;base64,${PNG}`;
const ctx = { cwd: "/", sessionId: "sess-1" };
const MIND = { url: "https://mind.test/llm/chat/completions", via: "mind" as const, headers: () => ({ "X-API-Key": "mind_user" }) };
const DIRECT = { url: "https://or.test/chat/completions", via: "openrouter" as const, headers: () => ({ Authorization: "Bearer server-key" }) };
const reply = (images: unknown, cost = 0.014) => new Response(JSON.stringify({ model: "black-forest-labs/flux-3-image-klein", choices: [{ message: { role: "assistant", content: "", images } }], usage: { cost, prompt_tokens: 20, completion_tokens: 1000 } }), { status: 200 });
const store = () => new PhotoStore({ dir: mkdtempSync(join(tmpdir(), "img-")), owner: "owner" });

test("imageUrlOf reads the first usable image", () => {
  assert.equal(imageUrlOf({ choices: [{ message: { images: [{ image_url: { url: DATA } }] } }] }), DATA);
  assert.equal(imageUrlOf({ choices: [{ message: { images: [{ image_url: { url: "http://insecure" } }] } }] }), undefined);
  assert.equal(imageUrlOf({}), undefined);
});

test("image_generate stores the picture as a chat photo and returns the line that shows it, with the cost", async () => {
  const s = store();
  const seen: any[] = [];
  const tool = createImageGenerateTool({ store: s, endpoint: () => MIND, fetchImpl: (async (u: string, i: any) => { seen.push({ u, h: i.headers, b: JSON.parse(i.body) }); return reply([{ type: "image_url", image_url: { url: DATA } }]); }) as any });
  const r = await tool.run({ prompt: "A small red paper boat on calm blue water", aspect_ratio: "16:9" }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /saved it to this chat as photo p1 \(1x1\)/);
  assert.match(r.output, /!\[A small red paper boat on calm blue water\]\(\/sessions\/sess-1\/photos\/p1\)/);
  assert.equal(r.meta?.costUsd, 0.014);
  assert.equal(seen[0].h["X-API-Key"], "mind_user");
  assert.deepEqual(seen[0].b.modalities, ["image"]);
  assert.equal(seen[0].b.model, "recraft/recraft-v4.1-flash");
  assert.deepEqual(modalitiesFor("google/gemini-3.1-flash-image"), ["image", "text"]);
  assert.deepEqual(seen[0].b.image_config, { aspect_ratio: "16:9" });
  const stored = await s.read("sess-1", "p1");
  assert.equal(stored?.meta.mime, "image/png");
  assert.equal(stored?.data.toString("base64"), PNG);
  assert.equal(s.list("other-session").length, 0);
});

test("image_generate: validates input, reports no image, and refuses bytes that are not an image", async () => {
  const s = store();
  const mk = (res: () => Response) => createImageGenerateTool({ store: s, endpoint: () => MIND, fetchImpl: (async () => res()) as any });
  assert.equal((await mk(() => reply([])).run({ prompt: " " }, ctx)).ok, false);
  assert.equal((await mk(() => reply([])).run({ prompt: "x", aspect_ratio: "7:3" }, ctx)).ok, false);
  const none = await mk(() => reply([])).run({ prompt: "a cat" }, ctx);
  assert.equal(none.ok, false);
  assert.match(none.output, /no image/);
  const junk = await mk(() => reply([{ image_url: { url: "data:image/png;base64,AAAA" } }])).run({ prompt: "a cat" }, ctx);
  assert.equal(junk.ok, false);
  assert.equal(s.list("sess-1").length, 0);
  const broke = await mk(() => new Response(JSON.stringify({ error: "insufficient_credits" }), { status: 402 })).run({ prompt: "a cat" }, ctx);
  assert.match(broke.output, /no credits/);
});

test("image_generate: a model MIND does not offer falls back to the owner's own key only when a fallback is given", async () => {
  const refuse = () => new Response(JSON.stringify({ error: "model_not_available", message: "Model 'x' is not offered by MIND." }), { status: 400 });
  const calls: string[] = [];
  const f = (async (u: string) => { calls.push(u); return u.startsWith("https://mind.test") ? refuse() : reply([{ image_url: { url: DATA } }]); }) as any;
  const without = await createImageGenerateTool({ store: store(), endpoint: () => MIND, fetchImpl: f }).run({ prompt: "a cat" }, ctx);
  assert.equal(without.ok, false);
  assert.match(without.output, /not offered by MIND/);
  assert.deepEqual(calls, [MIND.url]);
  calls.length = 0;
  const withFb = await createImageGenerateTool({ store: store(), endpoint: () => MIND, fallback: () => DIRECT, fetchImpl: f }).run({ prompt: "a cat" }, ctx);
  assert.equal(withFb.ok, true);
  assert.equal(withFb.meta?.via, "openrouter");
  assert.deepEqual(calls, [MIND.url, DIRECT.url]);
});

test("image_generate is a hosted tool and a read-class tool", () => {
  assert.equal(hostedToolAllowed("image_generate"), true);
  assert.equal(createImageGenerateTool({ store: store(), endpoint: () => MIND }).class, "read");
});
