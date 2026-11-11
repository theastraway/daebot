// Where a tool that needs ONE non-streaming model call (web_search, image_generate) sends it.
// MIND billing (DAEBOT_BILLING=mind): the user's own MIND key, to MIND's OpenRouter-compatible proxy, so the cost is deducted from their
// MIND credits. Otherwise (self-host): OPENROUTER_API_KEY straight to OpenRouter. Pure; nothing here touches the network.
import type { Config } from "../types.ts";
import { OPENROUTER_URL, REFERER, TITLE } from "../provider/openrouter.ts";

export interface LlmEndpoint {
  url: string;
  headers: () => Record<string, string>;
  via: "mind" | "openrouter";
}

export function llmEndpoint(cfg: Pick<Config, "billing" | "mindBaseUrl" | "openrouterKey">, getMindKey: () => string, bot?: string): LlmEndpoint | undefined {
  if (cfg.billing === "mind") {
    return { url: `${cfg.mindBaseUrl.replace(/\/+$/, "")}/llm/chat/completions`, via: "mind", headers: () => ({ "Content-Type": "application/json", "X-API-Key": getMindKey(), ...(bot ? { "X-Daebot-Bot": bot } : {}) }) };
  }
  if (!cfg.openrouterKey) return undefined;
  return {
    url: OPENROUTER_URL, via: "openrouter",
    headers: () => ({ "Content-Type": "application/json", Authorization: `Bearer ${cfg.openrouterKey}`, "HTTP-Referer": REFERER, "X-Title": TITLE }),
  };
}

/** A refusal from MIND's proxy or OpenRouter, in words the model can pass on. Never includes a key. */
export function refusalText(status: number, body: string): string {
  let code = "", msg = "";
  try {
    const j = JSON.parse(body);
    code = typeof j?.error === "string" ? j.error : typeof j?.error?.code === "string" ? j.error.code : "";
    msg = typeof j?.message === "string" ? j.message : typeof j?.error?.message === "string" ? j.error.message : typeof j?.detail === "string" ? j.detail : "";
  } catch { /* not JSON */ }
  if (code === "spend_cap_reached") return msg || "the spend cap is reached. Raise it in Settings";
  if (status === 402 || code === "insufficient_credits") return "the MIND plan has no credits left for this call (upgrade or top up at m-i-n-d.ai)";
  if (code === "model_not_in_plan") return "this model needs a paid MIND plan";
  if (code === "model_not_available") return msg || "MIND does not offer this model";
  if (/<html|<!doctype/i.test(body)) return `the model service could not be reached (HTTP ${status} from the web edge)`;
  return `HTTP ${status}${msg ? ` ${msg}` : body ? ` ${body.slice(0, 160)}` : ""}`.replace(/\s+/g, " ").slice(0, 240);
}
