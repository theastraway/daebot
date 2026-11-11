// image_generate: make an image from a prompt with an image-output model on OpenRouter and keep it in the chat as a photo.
//
// One non-streaming chat call with `modalities: ["image"]`. The reply carries the picture as a data URL in message.images[].image_url.url.
// The bytes are validated like any attached photo (real PNG/JPEG/WebP/GIF, size caps) and stored in this chat's PhotoStore, so the image
// shows in the chat, survives a reload, and syncs to the user's other devices with the chat (src/sync/photos.ts trades every local photo).
// Billing: MIND billing sends the call to MIND's /llm/chat/completions with the user's own key; recraft/recraft-v4.1-flash is on MIND's model
// list (MINDapp PR 3002), so every signed-in paid user is billed from their own MIND credits at provider cost + 12%, and MIND writes the
// llm_call_ledger row. There is no server-key fallback. The cost of every image is in result.meta.costUsd (OpenRouter's reported usage.cost).
import type { PhotoStore } from "../photos.ts";
import { checkPhotos } from "../photos.ts";
import type { Tool } from "../types.ts";
import { fail, ok } from "./util.ts";
import { refusalText, type LlmEndpoint } from "./llm-call.ts";

// Cheapest image model that OpenRouter serves on /chat/completions (measured $0.007 per image; the flux, qwen, krea and tencent image models are
// /images-only and the chat endpoint refuses them). DAEBOT_IMAGE_MODEL overrides it.
export const IMAGE_MODEL = "recraft/recraft-v4.1-flash";
/** Image-only models take ["image"]; models that also write text (Gemini image models) need ["image", "text"]. */
export const modalitiesFor = (model: string): string[] => (/^google\//.test(model) ? ["image", "text"] : ["image"]);
const ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
const TIMEOUT_MS = 120_000;
const MAX_PROMPT = 2000;

export interface ImageGenerateOptions {
  endpoint: () => LlmEndpoint | undefined;
  store: Pick<PhotoStore, "add">;
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
}

/** The first image of a chat completion as a data URL (a data URL straight from the model, or an https URL it returned). */
export function imageUrlOf(body: unknown): string | undefined {
  const msg = (body as any)?.choices?.[0]?.message;
  const imgs = Array.isArray(msg?.images) ? msg.images : [];
  for (const i of imgs) {
    const u = i?.image_url?.url ?? i?.url;
    if (typeof u === "string" && (/^data:image\//i.test(u) || /^https:\/\//i.test(u))) return u;
  }
  return undefined;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "image";

export function createImageGenerateTool(o: ImageGenerateOptions): Tool {
  const model = o.model || IMAGE_MODEL;
  const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function call(ep: LlmEndpoint, prompt: string, aspect: string | undefined, signal: AbortSignal): Promise<{ status: number; text: string }> {
    const res = await doFetch(ep.url, {
      method: "POST",
      headers: ep.headers(),
      body: JSON.stringify({
        model, messages: [{ role: "user", content: prompt }], modalities: modalitiesFor(model), usage: { include: true },
        ...(aspect ? { image_config: { aspect_ratio: aspect } } : {}),
      }),
      signal,
    });
    return { status: res.status, text: await res.text() };
  }

  return {
    class: "read", // it spends a few cents of the user's own credits and changes only this chat's photos: never a card
    receipt: "surface",
    spec: {
      name: "image_generate",
      description:
        "Generate an image from a text prompt and show it in this chat (it is saved as a chat photo and syncs to the user's devices). Use it when the user asks you to draw, design, illustrate or make a picture, logo, mockup or photo. " +
        "Write a concrete prompt: subject, style, composition, colors, any text to appear. After it succeeds, put the markdown image line it returns in your reply so the user sees the picture, and say what you made in a sentence. Costs a few cents per image (deducted from the user's MIND credits).",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What to draw, in detail." },
          aspect_ratio: { type: "string", enum: [...ASPECTS], description: "Shape of the image (default 1:1)." },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const prompt = typeof args.prompt === "string" ? args.prompt.replace(/\s+/g, " ").trim() : "";
      if (!prompt) return fail("image_generate: prompt is required");
      if (prompt.length > MAX_PROMPT) return fail(`image_generate: prompt is over ${MAX_PROMPT} characters`);
      const aspect = typeof args.aspect_ratio === "string" && (ASPECTS as readonly string[]).includes(args.aspect_ratio) ? args.aspect_ratio : undefined;
      if (args.aspect_ratio !== undefined && !aspect) return fail(`image_generate: aspect_ratio must be one of ${ASPECTS.join(", ")}`);
      const primary = o.endpoint();
      if (!primary) return fail("image_generate: no model provider is configured on this server (needs a MIND key or OPENROUTER_API_KEY)");
      const timeout = AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      try {
        const ep = primary;
        const r = await call(ep, prompt, aspect, signal);
        if (r.status < 200 || r.status >= 300) return fail(`image_generate: ${refusalText(r.status, r.text)}`);
        let body: any;
        try { body = JSON.parse(r.text); } catch { return fail("image_generate: the image service sent a reply that was not JSON"); }
        if (body?.error) return fail(`image_generate: ${String(body.error?.message ?? body.error).slice(0, 200)}`);
        const costUsd = Math.max(0, Number(body?.usage?.cost) || 0);
        let url = imageUrlOf(body);
        if (url && /^https:/i.test(url)) {
          const img = await doFetch(url, { signal });
          const mime = (img.headers.get("content-type") ?? "image/png").split(";")[0].trim();
          url = `data:${mime};base64,${Buffer.from(await img.arrayBuffer()).toString("base64")}`;
        }
        const meta = { costUsd, model: String(body?.model ?? model), via: ep.via, inputTokens: Number(body?.usage?.prompt_tokens) || 0, outputTokens: Number(body?.usage?.completion_tokens) || 0 };
        if (!url) return { ok: false, output: `image_generate: the model returned no image${typeof body?.choices?.[0]?.message?.content === "string" && body.choices[0].message.content ? ` (it said: ${body.choices[0].message.content.slice(0, 160)})` : ""}. Tell the user it failed.`, meta };
        const ext = /^data:image\/(png|jpeg|webp|gif)/i.exec(url)?.[1]?.toLowerCase().replace("jpeg", "jpg") ?? "png";
        const checked = checkPhotos([{ name: `${slug(prompt)}.${ext}`, dataUrl: url }]);
        if (!checked.ok) return { ok: false, output: `image_generate: the model's image could not be used (${checked.error})`, meta };
        const added = await o.store.add(ctx.sessionId, checked.photos);
        if (!added.ok) return { ok: false, output: `image_generate: the image was made but could not be saved to this chat (${added.error})`, meta };
        const p = added.photos[0];
        return ok(
          `Generated an image and saved it to this chat as photo ${p.id} (${p.width}x${p.height}). To show it, put exactly this line in your reply: ![${prompt.replace(/[\[\]()!]/g, "").slice(0, 60).trim()}](/sessions/${encodeURIComponent(ctx.sessionId)}/photos/${p.id})`,
          { ...meta, photo: p.id, width: p.width, height: p.height },
        );
      } catch (e) {
        if (ctx.signal?.aborted) return fail("image_generate: stopped");
        return fail(`image_generate: ${(e as Error)?.name === "TimeoutError" ? "image generation timed out" : String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200)}`);
      }
    },
  };
}
