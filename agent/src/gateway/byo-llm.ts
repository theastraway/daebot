// BYO LLM (Bring Your Own AI) for Daebot: the signed-in user's own provider key for chat and ingestion.
//   GET    /byo-llm         -> MIND's /developer/v1/byo-llm status  (feature_enabled, configured, provider, base_url, key_last4)
//   POST   /byo-llm         -> MIND's /developer/v1/byo-llm save     (body: { provider, base_url?, api_key })
//   DELETE /byo-llm         -> MIND's /developer/v1/byo-llm clear
//   POST   /byo-llm/test    -> MIND's /developer/v1/byo-llm/test     (tests the stored key; MIND returns { ok, reason })
// Every call goes to MIND with the SIGNED-IN USER'S OWN MIND key as X-API-Key. The provider key is POSTed in
// the JSON body and never returned by the gateway; MIND encrypts it at rest.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../auth/users.ts";

const UPSTREAM_TIMEOUT_MS = 20_000;
const PROVIDER_OK = /^(openrouter|openai|anthropic|gemini|xai|openai-compat|ollama)$/;
const BASE_OK = /^https?:\/\/[^\s]{1,2000}$/;

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
async function readBody(req: IncomingMessage): Promise<{ provider: string; base_url: string; api_key: string }> {
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
  return {
    provider: typeof j?.provider === "string" ? j.provider : "",
    base_url: typeof j?.base_url === "string" ? j.base_url : "",
    api_key: typeof j?.api_key === "string" ? j.api_key : "",
  };
}

function mapError(status: number, code: string): { status: number; body: Record<string, unknown> } {
  if (status === 401 || status === 403) return { status: 401, body: { error: code + "_unauth", message: "MIND did not accept your key. Sign in again." } };
  if (status === 404 || status === 501) return { status: 503, body: { error: code + "_unavailable", message: "BYO LLM is not switched on at MIND yet." } };
  if (status === 409 || status === 400) return { status: 400, body: { error: code + "_refused", message: "MIND could not accept that request." } };
  return { status: 502, body: { error: code + "_failed", message: "MIND could not finish that request. Try again in a moment." } };
}

export function createByoLlmHandler(o: ByoLlmOptions): (req: IncomingMessage, res: ServerResponse, path: string, p: Principal) => Promise<void> {
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.baseUrl.replace(/\/+$/, "");
  const upstream = async (pathPart: string, init: RequestInit & { method?: string }): Promise<Response> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.headers) Object.assign(headers, init.headers as Record<string, string>);
    return f(`${base}${pathPart}`, { ...init, headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  };

  return async (req, res, _path, principal) => {
    const method = (req.method ?? "GET").toUpperCase();
    const key = o.keyFor(principal);
    const needsSignIn = !key;

    // GET /byo-llm -> status
    if (method === "GET") {
      if (needsSignIn) return json(res, 200, { feature_enabled: false, configured: false });
      try {
        const r = await upstream("/byo-llm", { method: "GET", headers: { "X-API-Key": key! } });
        if (!r.ok) {
          if (r.status === 404 || r.status === 501) return json(res, 200, { feature_enabled: false, configured: false });
          const m = mapError(r.status, "byo_llm_status");
          return json(res, m.status, m.body);
        }
        const j = await r.json().catch(() => ({}));
        return json(res, 200, j);
      } catch {
        return json(res, 502, { error: "byo_llm_failed", message: "MIND could not be reached. Try again in a moment." });
      }
    }

    // POST /byo-llm/test
    if (method === "POST" && req.url?.includes("/test")) {
      if (needsSignIn) return json(res, 403, { error: "sign_in_with_mind", message: "Sign in with MIND to test your key." });
      try {
        const r = await upstream("/byo-llm/test", { method: "POST", headers: { "X-API-Key": key!, "Content-Type": "application/json" }, body: "{}" });
        if (!r.ok) {
          const m = mapError(r.status, "byo_llm_test");
          return json(res, m.status, { ...m.body, ok: false });
        }
        const j: any = await r.json().catch(() => ({}));
        return json(res, 200, { ok: j?.ok !== false, reason: typeof j?.reason === "string" ? j.reason : "" });
      } catch {
        return json(res, 502, { error: "byo_llm_failed", message: "MIND could not be reached. Try again in a moment.", ok: false });
      }
    }

    // POST /byo-llm -> save
    if (method === "POST") {
      if (needsSignIn) return json(res, 403, { error: "sign_in_with_mind", message: "Sign in with MIND to save your LLM key." });
      const body = await readBody(req);
      if (!PROVIDER_OK.test(body.provider)) return json(res, 400, { error: "bad_provider", message: "Pick one of the listed providers." });
      if (!body.api_key || body.api_key.length < 8 || body.api_key.length > 512) return json(res, 400, { error: "bad_key", message: "API key looks off. Paste it again." });
      if (body.base_url && !BASE_OK.test(body.base_url)) return json(res, 400, { error: "bad_base_url", message: "Base URL must start with http(s)://" });
      try {
        const r = await upstream("/byo-llm", {
          method: "POST",
          headers: { "X-API-Key": key!, "Content-Type": "application/json" },
          body: JSON.stringify({ provider: body.provider, base_url: body.base_url || undefined, api_key: body.api_key }),
        });
        if (!r.ok) {
          let detail = "";
          try { const j = await r.json(); detail = typeof j?.detail === "string" ? j.detail : ""; } catch { /* nothing */ }
          const m = mapError(r.status, "byo_llm_save");
          return json(res, m.status, { ...m.body, message: detail || m.body.message });
        }
        return json(res, 200, { ok: true });
      } catch {
        return json(res, 502, { error: "byo_llm_failed", message: "MIND could not be reached. Try again in a moment." });
      }
    }

    // DELETE /byo-llm -> clear
    if (method === "DELETE") {
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
