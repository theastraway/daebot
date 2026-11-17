// The local tier: a model on the user's own machine through Ollama's OpenAI-compatible endpoint (desktop and self-host only; the
// hosted gateway never looks for one). Detection is one GET /api/tags with a short timeout, done once at start; the result decides
// whether the router may send reflex and light work there at zero credit spend. Model ids are "ollama/<name>" so the policy table and
// the proof card say where a turn ran; the prefix is stripped on the wire.
import type { Provider } from "../types.ts";
import { createOpenRouterProvider } from "./openrouter.ts";
import type { Config } from "../types.ts";

export const LOCAL_PREFIX = "ollama/";
export const DEFAULT_OLLAMA = "http://127.0.0.1:11434";

export function ollamaBase(env: Record<string, string | undefined> = process.env): string {
  const v = (env.OLLAMA_HOST ?? "").trim();
  if (!v) return DEFAULT_OLLAMA;
  return (/^https?:\/\//.test(v) ? v : `http://${v}`).replace(/\/+$/, "");
}

export const isLocalModel = (id: string): boolean => id.startsWith(LOCAL_PREFIX);
export const localModelName = (id: string): string => (isLocalModel(id) ? id.slice(LOCAL_PREFIX.length) : id);

/** Embedding, reranking and speech models cannot chat: never offered or picked as the local chat model. */
export const isChatModelName = (n: string): boolean => !/(^|[\/:._-])(embed|embedding|rerank|reranker|whisper|bge|nomic-embed)/i.test(n);

/**
 * The models a local server serves, or undefined when none answers in time. Never throws.
 * Ollama answers GET /api/tags. Any other OpenAI-compatible server (LM Studio, llama.cpp's llama-server, vLLM) has no /api/tags
 * but answers GET /v1/models, so that is the fallback; point OLLAMA_HOST at it (for example 127.0.0.1:1234 for LM Studio).
 */
export async function detectOllama(o: { fetchImpl?: typeof fetch; base?: string; timeoutMs?: number } = {}): Promise<{ base: string; models: string[] } | undefined> {
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.base ?? ollamaBase();
  const ms = o.timeoutMs ?? 1200;
  try {
    const res = await f(`${base}/api/tags`, { signal: AbortSignal.timeout(ms) });
    if (res.ok) {
      const j = (await res.json()) as { models?: { name?: string }[] };
      return { base, models: (j.models ?? []).map((m) => String(m.name ?? "")).filter(Boolean).filter(isChatModelName) };
    }
  } catch { /* try the OpenAI-compatible listing below */ }
  try {
    const res = await f(`${base}/v1/models`, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { data?: { id?: string }[] };
    return { base, models: (j.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean).filter(isChatModelName) };
  } catch { return undefined; }
}

/** Picks the local model for the policy: the operator's choice when it is served, else the first served model. */
export function pickLocalModel(served: string[], preferred?: string): string | undefined {
  const want = preferred ? localModelName(preferred) : undefined;
  if (want && served.some((m) => m === want || m.split(":")[0] === want)) return `${LOCAL_PREFIX}${served.find((m) => m === want) ?? want}`;
  return served.length ? `${LOCAL_PREFIX}${served[0]}` : undefined;
}

/** A provider for the local Ollama (same SSE reader as OpenRouter; no key, no fallback list, no vision). */
export function createOllamaProvider(cfg: Config, fetchImpl: typeof fetch, base = ollamaBase()): Provider {
  const inner = createOpenRouterProvider({ ...cfg, models: { ...cfg.models, fallback: [] } }, fetchImpl, { url: `${base}/v1/chat/completions`, name: "ollama", headers: () => ({ "Content-Type": "application/json" }) });
  return { name: "ollama", stream: (req) => inner.stream({ ...req, model: localModelName(req.model), pinModel: true }) };
}

/** Routes "ollama/..." models to the local provider and everything else to the main one. */
export function withLocal(main: Provider, local: Provider): Provider {
  return { name: main.name, stream: (req) => (isLocalModel(req.model) ? local.stream(req) : main.stream(req)) };
}
