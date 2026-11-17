// The local model server (Connections > Local model server): desktop and self-host only. A hosted gateway (daebot.live) runs
// on a server that cannot reach the person's computer, so there the panel points at the desktop app instead.
//   GET  /settings/local-llm          -> { available, enabled, base, model, source, served: [...], detectedAt, env: { base, model } }
//   PUT  /settings/local-llm          -> body { enabled?, base?, model? } (null clears); saves DATA_DIR/local-llm.json, re-detects, answers like GET
//   POST /settings/local-llm/detect   -> body { base? }: probes that server (or the saved one) without saving; { ok, base, served }
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LocalLlmConfig, LocalLlmPatch } from "../provider/local-config.ts";
import { cleanBase, readLocalLlm, writeLocalLlm } from "../provider/local-config.ts";
import { DEFAULT_OLLAMA, LOCAL_PREFIX, applyLocalLlm, detectOllama, localEnabled, ollamaBase, pickLocalModel, preferredLocal } from "../provider/local.ts";

export interface LocalLlmOptions {
  hosted: boolean;
  dir: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** After a save: the runtime looks again and the model list drops its cached local rows. */
  onChange?: () => Promise<unknown> | unknown;
  readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
}

export interface LocalLlmView {
  available: boolean;
  enabled: boolean;
  base: string;
  model: string | null;
  /** where the address comes from */
  source: "panel" | "env" | "default";
  served: string[];
  detectedAt: number | null;
  reachable: boolean;
  env: { base: string | null; model: string | null };
  reason?: string;
}

/** Loads the saved file into the provider module. Call once at start. */
export function loadLocalLlm(dir: string): LocalLlmConfig {
  const c = readLocalLlm(dir);
  applyLocalLlm(c);
  return c;
}

export function createLocalLlmApi(o: LocalLlmOptions): (req: IncomingMessage, res: ServerResponse, path: string, method: string) => Promise<void> {
  const env = o.env ?? process.env;
  let last: { base: string; served: string[]; at: number } | undefined;

  const view = async (probe: boolean): Promise<LocalLlmView> => {
    const saved = readLocalLlm(o.dir);
    const base = ollamaBase(env);
    const envBase = (env.OLLAMA_HOST ?? "").trim() || null;
    const enabled = localEnabled(env);
    if (probe && enabled) {
      const r = await detectOllama({ fetchImpl: o.fetchImpl, base, timeoutMs: 2500 });
      last = { base, served: r?.models ?? [], at: Date.now() };
    }
    const served = last && last.base === base ? last.served : [];
    const pick = enabled ? pickLocalModel(served, preferredLocal(env)) : undefined;
    return {
      available: true, enabled, base, model: pick ? pick.slice(LOCAL_PREFIX.length) : saved.model ?? preferredLocal(env) ?? null,
      source: saved.base ? "panel" : envBase ? "env" : "default", served: served.map((m) => `${LOCAL_PREFIX}${m}`), detectedAt: last && last.base === base ? last.at : null,
      reachable: !!(last && last.base === base && last.served.length), env: { base: envBase, model: (env.DAEBOT_TIER_LOCAL ?? "").trim() || null },
    };
  };

  return async (req, res, path, method) => {
    if (o.hosted) {
      if (method !== "GET" && method !== "PUT" && method !== "POST") return o.sendJson(res, 405, { error: "method not allowed" });
      return o.sendJson(res, 200, { available: false, enabled: false, base: DEFAULT_OLLAMA, model: null, source: "default", served: [], detectedAt: null, reachable: false, env: { base: null, model: null }, reason: "A model on your computer is reached by the Daebot desktop app on that computer, not by daebot.live. Open Daebot there: its model list shows what Ollama, LM Studio or llama.cpp serve." });
    }
    if (path === "/settings/local-llm/detect") {
      if (method !== "POST") return o.sendJson(res, 405, { error: "method not allowed" });
      const b = await o.readJson(req);
      const base = b.base === undefined || b.base === "" ? ollamaBase(env) : cleanBase(b.base);
      if (!base) return o.sendJson(res, 400, { error: "bad_base", message: "Enter the server address, like http://127.0.0.1:11434." });
      const r = await detectOllama({ fetchImpl: o.fetchImpl, base, timeoutMs: 2500 });
      return o.sendJson(res, 200, { ok: !!r, base, served: (r?.models ?? []).map((m) => `${LOCAL_PREFIX}${m}`), message: r ? (r.models.length ? `${r.models.length} chat model${r.models.length === 1 ? "" : "s"} served.` : "The server answered but serves no chat model yet (pull one first).") : "Nothing answered at that address. Is the server running?" });
    }
    if (path !== "/settings/local-llm") return o.sendJson(res, 404, { error: "not found" });
    if (method === "GET") return o.sendJson(res, 200, await view(!last));
    if (method !== "PUT") return o.sendJson(res, 405, { error: "method not allowed" });
    const b = await o.readJson(req);
    const patch: LocalLlmPatch = {};
    if (b.enabled === null || typeof b.enabled === "boolean") patch.enabled = b.enabled as boolean | null;
    if (b.base === null || typeof b.base === "string") patch.base = b.base === "" ? null : (b.base as string | null);
    if (b.model === null || typeof b.model === "string") patch.model = b.model === "" ? null : (b.model as string | null);
    let saved: LocalLlmConfig;
    try { saved = writeLocalLlm(o.dir, patch); }
    catch (e) { return o.sendJson(res, 400, { error: (e as Error).message === "bad_model" ? "bad_model" : "bad_base", message: (e as Error).message === "bad_model" ? "That model name looks off." : "Enter the server address, like http://127.0.0.1:11434." }); }
    applyLocalLlm(saved);
    last = undefined;
    const v = await view(true);
    try { await o.onChange?.(); } catch { /* the next turn re-detects anyway */ }
    return o.sendJson(res, 200, v);
  };
}
