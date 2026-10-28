// OpenRouter chat-completions streaming provider (SSE). Retries once on 429/5xx with backoff,
// then falls through cfg.models.fallback. fetch is injectable so tests never touch the network.
import type { Config, Message, Provider, StreamEvent, ToolCall, ToolSpec, Usage } from "../types.ts";
import { abortError, readSse } from "./sse.ts";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const REFERER = "https://www.m-i-n-d.ai/mindclaw";
export const TITLE = "MINDClaw";

export interface ProviderOptions {
  backoffMs?: number;   // base delay before the single retry (default 800ms); tests pass 0
  url?: string;
  name?: string;        // Provider.name (default "openrouter")
  /** Request headers per call (default: OpenRouter bearer key + attribution). The MIND-billed provider sends X-API-Key here. */
  headers?: () => Record<string, string>;
  /** Sees every response (ok or not) before it is read, e.g. for billing headers. */
  onResponse?: (res: Response) => void;
  /** Maps a non-ok response to a typed error. Return undefined to keep the generic ProviderHttpError. */
  errorFor?: (status: number, body: string, model: string) => ProviderHttpError | undefined;
}

export class ProviderHttpError extends Error {
  status: number;
  /** A fatal error ends the whole stream: falling through to the next model cannot help (bad key, billing refusal). */
  fatal = false;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}

const retryable = (status: number) => status === 429 || status >= 500;

// Only the newest image-bearing tool results are sent as images: older screenshots are stale and cost tokens every call.
export const MAX_IMAGE_MESSAGES = 2;

export function toWireMessages(messages: Message[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let seenNonSystem = false;
  const withImages = messages.filter((m) => m.role === "tool" && m.images?.length);
  const sendImages = new Set(withImages.slice(-MAX_IMAGE_MESSAGES));
  // Tool messages must stay contiguous after their assistant turn, so images are held until the tool run ends.
  let pendingImages: Record<string, unknown>[] = [];
  const flushImages = () => { if (pendingImages.length) { out.push(...pendingImages); pendingImages = []; } };
  for (const m of messages) {
    if (m.role !== "tool") flushImages();
    if (m.role === "system") {
      // Mid-conversation system nudges are folded into a user turn: not every model behind
      // OpenRouter accepts system messages after the first assistant/user message.
      if (seenNonSystem) out.push({ role: "user", content: `[system] ${m.content}` });
      else out.push({ role: "system", content: m.content });
      continue;
    }
    seenNonSystem = true;
    if (m.role === "assistant") {
      const wire: Record<string, unknown> = { role: "assistant", content: m.content || (m.toolCalls?.length ? null : "") };
      if (m.toolCalls?.length) {
        wire.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        }));
      }
      out.push(wire);
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      // Most providers only accept images in user content, so the screenshot follows the tool results as a user turn.
      if (m.images?.length && sendImages.has(m)) {
        pendingImages.push({ role: "user", content: [
          { type: "text", text: `[screenshot from ${m.name ?? "tool"} ${m.toolCallId ?? ""}]`.replace(/\s+]/, "]") },
          ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
        ] });
      }
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  flushImages();
  return out;
}

function toWireTools(tools: ToolSpec[]): Record<string, unknown>[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

interface PartialCall { id: string; name: string; args: string }

function parseArgs(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { _invalidJson: raw };
  } catch {
    return { _invalidJson: raw };
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });

export function createOpenRouterProvider(cfg: Config, fetchImpl: typeof fetch = fetch, opts: ProviderOptions = {}): Provider {
  const backoffMs = opts.backoffMs ?? 800;
  const url = opts.url ?? OPENROUTER_URL;

  async function open(model: string, req: { messages: Message[]; tools: ToolSpec[]; signal?: AbortSignal }): Promise<Response> {
    const body: Record<string, unknown> = {
      model,
      messages: toWireMessages(req.messages),
      stream: true,
      usage: { include: true },
    };
    if (req.tools.length) { body.tools = toWireTools(req.tools); body.tool_choice = "auto"; }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (req.signal?.aborted) throw abortError();
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: opts.headers ? opts.headers() : {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.openrouterKey}`,
            "HTTP-Referer": REFERER,
            "X-Title": TITLE,
          },
          body: JSON.stringify(body),
          signal: req.signal,
        });
        opts.onResponse?.(res);
        if (res.ok && res.body) return res;
        const text = await res.text().catch(() => "");
        const err = opts.errorFor?.(res.status, text, model) ?? new ProviderHttpError(res.status, `${model}: HTTP ${res.status} ${text.slice(0, 300)}`);
        if (!retryable(res.status)) throw err;
        lastErr = err;
      } catch (e) {
        if ((e as Error)?.name === "AbortError" || req.signal?.aborted) throw e;
        if (e instanceof ProviderHttpError && !retryable(e.status)) throw e;
        lastErr = e;
      }
      if (attempt === 0) await sleep(backoffMs, req.signal);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async function* consume(res: Response, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const calls = new Map<number, PartialCall>();
    let usage: Usage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };
    let finishReason = "stop";
    for await (const data of readSse(res.body!, signal)) {
      if (data.trim() === "[DONE]") break;
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new Error(`provider stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        if (typeof delta.content === "string" && delta.content) yield { type: "text", delta: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          let p = calls.get(idx);
          if (!p) { p = { id: "", name: "", args: "" }; calls.set(idx, p); }
          if (tc.id) p.id = tc.id;
          if (tc.function?.name) p.name += tc.function.name;
          if (typeof tc.function?.arguments === "string") p.args += tc.function.arguments;
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        usage = {
          promptTokens: Number(chunk.usage.prompt_tokens ?? 0),
          completionTokens: Number(chunk.usage.completion_tokens ?? 0),
          costUsd: Number(chunk.usage.cost ?? 0),
        };
      }
    }
    const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [idx, p] of ordered) {
      if (!p.name) continue;
      const call: ToolCall = { id: p.id || `call_${idx}_${Date.now().toString(36)}`, name: p.name, args: parseArgs(p.args) };
      yield { type: "toolCall", call };
    }
    yield { type: "done", usage, finishReason };
  }

  return {
    name: opts.name ?? "openrouter",
    async *stream(req) {
      const models = [req.model, ...cfg.models.fallback.filter((m) => m !== req.model)];
      let lastErr: unknown;
      for (const model of models) {
        let res: Response;
        try {
          res = await open(model, req);
        } catch (e) {
          if ((e as Error)?.name === "AbortError") throw e;
          if (e instanceof ProviderHttpError && (e.status === 401 || e.status === 403 || e.fatal)) throw e; // bad key or billing refusal: fallback models will not help
          lastErr = e;
          continue; // fall through to the next model
        }
        // OpenRouter can answer 200 and then report an upstream failure (e.g. a provider's shared-pool 429) as the
        // first SSE chunk. Until an event has been yielded nothing reached the user, so fall through to the next
        // model. Once an event is out we are committed to this model and mid-stream errors propagate.
        let emitted = false;
        try {
          for await (const ev of consume(res, req.signal)) { emitted = true; yield ev; }
          return;
        } catch (e) {
          if (emitted || (e as Error)?.name === "AbortError") throw e;
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error("all models failed");
    },
  };
}
