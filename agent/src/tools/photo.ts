// view_photo: read photos the user attached to this chat, with a vision model.
//
// The chat model is text-first (measured: it answered an image with empty content), so photos never go into the chat
// context. This tool loads them from the PhotoStore, asks a dedicated vision model through the SAME provider the chat uses
// (hosted: the user's own MIND key and plan; self-host: OPENROUTER_API_KEY), and hands the model's text back with the cost.
//
// Read-only: it changes nothing anywhere. It can only reach photos of the session it runs in (ctx.sessionId), through the
// PhotoStore of the runtime's own owner, so another chat's or another user's photo is never reachable from here.
import type { Message, Provider, Tool, VisionConfig } from "../types.ts";
import { MindBillingError } from "../provider/mind.ts";
import { ProviderHttpError } from "../provider/openrouter.ts";
import type { PhotoMeta, PhotoStore } from "../photos.ts";
import { cap, errMsg, fail, ok } from "./util.ts";

export const DEFAULT_VISION: VisionConfig = {
  model: "google/gemini-2.5-flash-lite",
  fallback: ["anthropic/claude-haiku-5.5"],
  freeModel: "google/gemma-4-31b-it:free",
};

const MAX_ALL = 8;           // "all" reads the newest this many photos of the chat
const MAX_QUESTION = 2000;
const MAX_ANSWER = 12_000;
const ATTEMPT_MS = 60_000;

const SYSTEM = [
  "You read photos for another assistant, which cannot see them. Answer only from what is visible in the photo or photos.",
  "Quote printed text and numbers exactly as they appear, with their units and punctuation. Never guess: if something is blurry, cut off or hidden, say exactly what you could not read.",
  "Be concise. Use a list or a table when reading line items, and give totals as printed.",
].join(" ");

export interface ViewPhotoOptions {
  store: Pick<PhotoStore, "list" | "read">;
  /** The chat provider (MIND-billed on the hosted deployment, OpenRouter on self-host). */
  provider: Provider;
  vision?: VisionConfig;
  /** MIND free tier (Explorer): only the free vision model may be used. Absent = never free. */
  isFree?: () => Promise<boolean> | boolean;
  attemptMs?: number;
}

const FREE_BUSY = "The free vision model is busy right now (its shared pool is rate limited). Try the photo again in a minute, or use a paid MIND plan for a faster vision model.";
const BUSY = "The vision model is busy right now (rate limited). Try the photo again in a minute.";

const isBusy = (e: unknown): boolean => (e instanceof ProviderHttpError && e.status === 429) || /\b429\b|rate.?limit/i.test(String((e as Error)?.message ?? e));

function wanted(raw: unknown, have: PhotoMeta[]): { ok: true; photos: PhotoMeta[]; capped: boolean } | { ok: false; error: string } {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/) : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const ids = list(raw);
  if (ids.length === 0 || ids.includes("all")) {
    const photos = have.slice(-MAX_ALL);
    return { ok: true, photos, capped: have.length > photos.length };
  }
  const picked: PhotoMeta[] = [];
  for (const id of ids) {
    const norm = /^\d+$/.test(id) ? `p${id}` : id;
    const hit = have.find((p) => p.id === norm);
    if (!hit) return { ok: false, error: `view_photo: no photo "${id.slice(0, 20)}" in this chat. Available: ${have.map((p) => `${p.id} (${p.name})`).join(", ")}` };
    if (!picked.includes(hit)) picked.push(hit);
  }
  return { ok: true, photos: picked.slice(0, MAX_ALL), capped: picked.length > MAX_ALL };
}

export function createViewPhotoTool(o: ViewPhotoOptions): Tool {
  const vision = o.vision ?? DEFAULT_VISION;
  const attemptMs = o.attemptMs ?? ATTEMPT_MS;

  return {
    class: "read",     // changes nothing, so it never raises a permission card
    receipt: "surface", // a read of what the user showed us: it backs the numbers the answer quotes
    spec: {
      name: "view_photo",
      description:
        "Read photos the user attached to this chat, using a vision model. You cannot see photos yourself, so call this before you say anything about one. " +
        "Ask a specific question tied to what the user wants (for example \"read every line item, amount and total exactly\"). Photos are listed in the user's message as [photo p1: ...]. Costs a fraction of a cent.",
      parameters: {
        type: "object",
        properties: {
          photo: { type: "string", description: "A photo id from the user's message (p1), several ids separated by commas, or \"all\" for the photos of this chat (newest 8)." },
          question: { type: "string", description: "What to find out, specific to the user's request. Say what to read exactly (items, amounts, totals, names, dates)." },
        },
        required: ["photo", "question"],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) return fail("view_photo: question is required (say what to read or find in the photo)");
      if (question.length > MAX_QUESTION) return fail(`view_photo: question is over ${MAX_QUESTION} characters`);
      const have = o.store.list(ctx.sessionId);
      if (have.length === 0) return fail("view_photo: this chat has no photos. Tell the user none arrived and ask them to attach it again.");
      const pick = wanted(args.photo, have);
      if (!pick.ok) return fail(pick.error);

      const loaded: { meta: PhotoMeta; url: string }[] = [];
      for (const meta of pick.photos) {
        const r = await o.store.read(ctx.sessionId, meta.id);
        if (!r) return fail(`view_photo: ${meta.id} could not be read from storage. Ask the user to attach it again.`);
        loaded.push({ meta, url: `data:${r.meta.mime};base64,${r.data.toString("base64")}` });
      }

      const free = await Promise.resolve(o.isFree?.()).catch(() => false);
      const models = free ? [vision.freeModel] : [...new Set([vision.model, ...vision.fallback])];
      const listing = loaded.map((l) => `${l.meta.id} (${l.meta.name}, ${l.meta.width}x${l.meta.height})`).join("; ");
      const messages: Message[] = [
        { role: "system", content: SYSTEM },
        { role: "user", content: `${question}\n\n${loaded.length === 1 ? "Photo" : "Photos, in this order"}: ${listing}`, images: loaded.map((l) => l.url) },
      ];

      let spent = 0, inTok = 0, outTok = 0;
      const errors: unknown[] = [];
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        if (ctx.signal?.aborted) return fail("view_photo: stopped");
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(attemptMs)]) : AbortSignal.timeout(attemptMs);
        let text = "";
        try {
          for await (const ev of o.provider.stream({ model, messages, tools: [], signal, pinModel: true })) {
            if (ev.type === "text") text += ev.delta;
            else if (ev.type === "done") { spent += ev.usage.costUsd; inTok += ev.usage.promptTokens; outTok += ev.usage.completionTokens; }
          }
        } catch (e) {
          if (ctx.signal?.aborted) return fail("view_photo: stopped");
          // Out of credits is the user's to fix, and no other model helps. Everything else: try the next model.
          if (e instanceof MindBillingError && e.code === "insufficient_credits") return fail(`view_photo: ${e.userNotice}`);
          errors.push(e);
          continue;
        }
        if (!text.trim()) { errors.push(new Error(`${model} returned no text`)); continue; }
        const meta = { costUsd: spent, inputTokens: inTok, outputTokens: outTok, model, fellBack: i > 0, photos: loaded.map((l) => l.meta.id), free };
        const note = pick.capped ? `\n[Only the newest ${MAX_ALL} of ${have.length} photos were read; ask for the others by id.]` : "";
        return ok(cap(text.trim(), MAX_ANSWER) + note, meta);
      }

      // Every model failed. Word it for the user: a plain reason, no stack, nothing described from imagination.
      const busy = errors.some(isBusy);
      const billing = errors.find((e): e is MindBillingError => e instanceof MindBillingError);
      const why = busy ? (free ? FREE_BUSY : BUSY) : billing ? billing.userNotice : `the vision model could not read it (${errMsg(errors[errors.length - 1]).slice(0, 160)})`;
      const out = `view_photo: ${why} Tell the user this plainly and do not describe the photo.`;
      return { ok: false, output: out, meta: { costUsd: spent, inputTokens: inTok, outputTokens: outTok, busy } };
    },
  };
}
