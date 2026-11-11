// Image-input capability for chat models. A text-only model (deepseek-v4-flash, the Explorer free nemotron) answers any request that
// carries an image with OpenRouter's "No endpoints found that support image input". Tool results carry screenshots (loop.ts), so the
// provider must never send an image to a model that cannot take one. Source of truth: OpenRouter model metadata
// (architecture.input_modalities), cached at startup; a static pattern list covers the window before the cache fills and an offline start.
import type { Message } from "../types.ts";

const cache = new Map<string, boolean>();
let warmed = false;

// Families known to accept image input (checked against OpenRouter metadata 2026-11-11). Unknown ids are treated as text-only until the cache says otherwise.
const VISION_PATTERNS: RegExp[] = [
  /^qwen\/qwen3\.[5-9]/, /^qwen\/qwen3-vl/, /^qwen\/qwen2\.5-vl/,
  /^google\/gemini/, /^google\/gemma-[34]/,
  /^anthropic\/claude/, /^openai\/(gpt-4o|gpt-4\.1|gpt-5|o3|o4)/, /^meta-llama\/llama-4/, /^mistralai\/(pixtral|mistral-(medium|small)-3)/,
  /^x-ai\/grok-[4-9]/, /^moonshotai\/kimi-k2\.[5-9]/,
];

export function acceptsImages(model: string): boolean {
  const id = model.replace(/:(free|nitro|floor|online)$/, "");
  const hit = cache.get(model) ?? cache.get(id);
  if (hit !== undefined) return hit;
  return VISION_PATTERNS.some((p) => p.test(id));
}

/** Test hook and metadata loader: ids -> accepts image input. */
export function setVisionCapabilities(entries: Record<string, boolean>): void {
  for (const [k, v] of Object.entries(entries)) cache.set(k, v);
}
export function clearVisionCapabilities(): void { cache.clear(); warmed = false; }

/** Best-effort, once per process: load OpenRouter's model list (public, no key) and record which models take image input. */
export async function warmVisionCapabilities(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (warmed) return;
  warmed = true;
  try {
    const res = await fetchImpl("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const j: any = await res.json();
    for (const m of j?.data ?? []) {
      const mods = m?.architecture?.input_modalities;
      if (typeof m?.id === "string" && Array.isArray(mods)) {
        const v = mods.includes("image");
        cache.set(m.id, v);
        if (!cache.has(`${m.id}:free`)) cache.set(`${m.id}:free`, v);
      }
    }
  } catch { warmed = false; /* offline or slow: the static list keeps working; retry on the next provider creation */ }
}

/** Does this message list put an image on the wire? (any user image turn, or tool results carrying screenshots) */
export function carriesImages(messages: Message[]): boolean {
  return messages.some((m) => !!m.images?.length);
}

/** The same conversation with every image removed; tool screenshots keep a one-line note so the model knows one existed. */
export function stripImages(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (!m.images?.length) return m;
    const { images, ...rest } = m;
    return m.role === "tool"
      ? { ...rest, content: `${m.content}\n[${images.length} screenshot${images.length > 1 ? "s" : ""} attached, not shown: this model cannot read images]` }
      : rest;
  });
}
