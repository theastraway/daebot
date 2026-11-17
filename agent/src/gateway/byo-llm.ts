// BYO LLM ("LLM connectors", Bring your own AI) for Daebot: the signed-in user's own provider key for every model call, the same
// setting MIND shows under Settings > Bring your own AI, so it is one config for MIND and Daebot.
//   GET    /byo-llm         -> MIND's GET    /developer/v1/byo-llm  (feature_enabled, configured, provider, base_url, model, key_last4)
//   POST   /byo-llm         -> MIND's PUT    /developer/v1/byo-llm  (body: { provider, base_url?, model?, api_key })
//   DELETE /byo-llm         -> MIND's DELETE /developer/v1/byo-llm
//   POST   /byo-llm/test    -> MIND's POST   /developer/v1/byo-llm/test (tests the stored key; MIND returns { ok, reason })
// Every call goes to MIND with the SIGNED-IN USER'S OWN MIND key as X-API-Key. The provider key is POSTed in the JSON body and
// never returned by the gateway; MIND encrypts it at rest. Nothing here is logged.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../auth/users.ts";

const UPSTREAM_TIMEOUT_MS = 20_000;

/** MIND's provider ids (services/byo_llm_service.py PROVIDER_PRESETS + ollama + openai-compat) and the base URL each preset implies. */
export const BYO_PROVIDERS: { id: string; label: string; baseUrl: string; needsUrl?: boolean; keyOptional?: boolean }[] = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "xai", label: "xAI", baseUrl: "https://api.x.ai/v1" },
  { id: "perplexity", label: "Perplexity", baseUrl: "https://api.perplexity.ai" },
  { id: "qwen", label: "Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "kimi", label: "Kimi", baseUrl: "https://api.moonshot.ai/v1" },
  { id: "llama", label: "Llama (Groq)", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", needsUrl: true, keyOptional: true },
  { id: "openai-compat", label: "OpenAI-compatible", baseUrl: "", needsUrl: true },
];
const PROVIDER_OK = new RegExp(`^(${BYO_PROVIDERS.map((p) => p.id).join("|")})$`);
const BASE_OK = /^https?:\/\/[^\s]{1,2000}$/;
const MODEL_OK = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,199}$/;

export interface ByoLlmOptions {
  /** MIND API base, e.g. https://m-i-n-d.ai/developer/v1 */
  baseUrl: string;
  /** The signed-in user's own MIND key; undefined for the owner access-code login. */
  keyFor(p: Principal): string | undefined;
  fetchImpl?: typeof fetch;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(data)), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(data);
}

/** Reads the small JSON body for POST /byo-llm. Caps the body at 8 KB so a stray paste can't blow the request up; the API key is short. */
async function readBody(req: IncomingMessage): Promise<{ provider: string; base_url: string; model: string; api_key: string }> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    let n = 0;
    req.on("data", (c: Buffer) => { n += c.length; if (n > 8 * 1024) req.destroy(); else chunks.push(c); });
    req.on("end", () => resolve());
    req.on("error", () => resolve());
    req.on("close", () => resolve());
  });
  let j: any = {};
  try { j = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { j = {}; }
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  return { provider: str(j?.provider).toLowerCase(), base_url: str(j?.base_url), model: str(j?.model), api_key: typeof j?.api_key === "string" ? j.api_key.trim() : "" };
}

function mapError(status: number, code: string): { status: number; body: Record<string, unknown> } {
  if (status === 401 || status === 403) return { status: 401, body: { error: code + "_unauth", message: "MIND did not accept your key. Sign in again." } };
  if (status === 404 || status === 501 || status === 503) return { status: 503, body: { error: code + "_unavailable", message: "Bring your own AI is not switched on at MIND yet." } };
  if (status === 409 || status === 400 || status === 422) return { status: 400, body: { error: code + "_refused", message: "MIND could not accept that request." } };
  return { status: 502, body: { error: code + "_failed", message: "MIND could not finish that request. Try again in a moment." } };
}

/** The non-secret status fields MIND returns, and nothing else (no stray key ever reaches the browser). */
function statusView(j: any): Record<string, unknown> {
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return { feature_enabled: j?.feature_enabled !== false, configured: j?.configured === true, provider: s(j?.provider), base_url: s(j?.base_url), model: s(j?.model), key_last4: s(j?.key_last4), updated_at: s(j?.updated_at) };
}

export function createByoLlmHandler(o: ByoLlmOptions): (req: IncomingMessage, res: ServerResponse, path: string, p: Principal) => Promise<void> {
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.baseUrl.replace(/\/+$/, "");
  const upstream = async (pathPart: string, init: RequestInit & { method?: string }): Promise<Response> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.headers) Object.assign(headers, init.headers as Record<string, string>);
    return f(`${base}${pathPart}`, { ...init, headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  };

  return async (req, res, path, principal) => {
    const method = (req.method ?? "GET").toUpperCase();
    const key = o.keyFor(principal);
    const needsSignIn = !key;
    const isTest = path.endsWith("/test");

    // GET /byo-llm -> status
    if (method === "GET" && !isTest) {
      if (needsSignIn) return json(res, 200, { feature_enabled: false, configured: false, providers: BYO_PROVIDERS });
      try {
        const r = await upstream("/byo-llm", { method: "GET", headers: { "X-API-Key": key! } });
        if (!r.ok) {
          if (r.status === 404 || r.status === 501 || r.status === 503) return json(res, 200, { feature_enabled: false, configured: false, providers: BYO_PROVIDERS });
          const m = mapError(r.status, "byo_llm_status");
          return json(res, m.status, m.body);
        }
        const j = await r.json().catch(() => ({}));
        return json(res, 200, { ...statusView(j), providers: BYO_PROVIDERS });
      } catch {
        return json(res, 502, { error: "byo_llm_failed", message: "MIND could not be reached. Try again in a moment." });
      }
    }

    // POST /byo-llm/test
    if (method === "POST" && isTest) {
      if (needsSignIn) return json(res, 403, { error: "sign_in_with_mind", message: "Sign in with MIND to test your key." });
      try {
        const r = await upstream("/byo-llm/test", { method: "POST", headers: { "X-API-Key": key!, "Content-Type": "application/json" }, body: "{}" });
        if (!r.ok) {
          let detail = "";
          try { const j = await r.json(); detail = typeof j?.detail === "string" ? j.detail : typeof j?.reason === "string" ? j.reason : ""; } catch { /* nothing */ }
          const m = mapError(r.status, "byo_llm_test");
          return json(res, m.status, { ...m.body, ok: false, reason: detail || m.body.message });
        }
        const j: any = await r.json().catch(() => ({}));
        return json(res, 200, { ok: j?.ok !== false, reason: typeof j?.reason === "string" ? j.reason : "" });
      } catch {
        return json(res, 502, { error: "byo_llm_failed", message: "MIND could not be reached. Try again in a moment.", ok: false });
      }
    }

    // POST /byo-llm -> save (MIND: PUT)
    if (method === "POST") {
      if (needsSignIn) return json(res, 403, { error: "sign_in_with_mind", message: "Sign in with MIND to save your LLM key." });
      const body = await readBody(req);
      const preset = BYO_PROVIDERS.find((p) => p.id === body.provider);
      if (!preset || !PROVIDER_OK.test(body.provider)) return json(res, 400, { error: "bad_provider", message: "Pick one of the listed providers." });
      if (body.api_key && (body.api_key.length < 8 || body.api_key.length > 500)) return json(res, 400, { error: "bad_key", message: "API key looks off. Paste it again." });
      if (!body.api_key && !preset.keyOptional) return json(res, 400, { error: "bad_key", message: "Paste the provider's API key." });
      if (body.base_url && !BASE_OK.test(body.base_url)) return json(res, 400, { error: "bad_base_url", message: "Base URL must start with http(s)://" });
      const baseUrl = body.base_url || preset.baseUrl;
      if (!baseUrl) return json(res, 400, { error: "bad_base_url", message: "Enter the server's base URL (ending in /v1)." });
      if (body.model && !MODEL_OK.test(body.model)) return json(res, 400, { error: "bad_model", message: "That model name looks off." });
      try {
        const r = await upstream("/byo-llm", {
          method: "PUT",
          headers: { "X-API-Key": key!, "Content-Type": "application/json" },
          body: JSON.stringify({ provider: body.provider, base_url: baseUrl, ...(body.model ? { model: body.model } : {}), api_key: body.api_key }),
        });
        if (!r.ok) {
          let detail = "";
          try { const j = await r.json(); detail = typeof j?.detail === "string" ? j.detail : ""; } catch { /* nothing */ }
          const m = mapError(r.status, "byo_llm_save");
          return json(res, m.status, { ...m.body, message: detail || m.body.message });
        }
        const j = await r.json().catch(() => ({}));
        return json(res, 200, { ok: true, ...statusView({ configured: true, ...j }) });
      } catch {
        return json(res, 502, { error: "byo_llm_failed", message: "MIND could not be reached. Try again in a moment." });
      }
    }

    // DELETE /byo-llm -> clear
    if (method === "DELETE" && !isTest) {
      if (needsSignIn) return json(res, 403, { error: "sign_in_with_mind", message: "Sign in with MIND to clear your LLM key." });
      try {
        const r = await upstream("/byo-llm", { method: "DELETE", headers: { "X-API-Key": key! } });
        if (!r.ok && r.status !== 404) {
          const m = mapError(r.status, "byo_llm_clear");
          return json(res, m.status, m.body);
        }
        return json(res, 200, { ok: true });
      } catch {
        return json(res, 502, { error: "byo_llm_failed", message: "MIND could not be reached. Try again in a moment." });
      }
    }

    return json(res, 405, { error: "method not allowed" });
  };
}
