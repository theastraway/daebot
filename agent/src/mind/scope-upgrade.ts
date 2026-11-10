// Daebot logs every session to the signed-in user's own MIND, which needs chat:read + chat:write on the key the user handed Daebot. A key made
// before those scopes existed (or with fewer) answers 403 "API key lacks required scope: chat:write". MIND has one admin-only route that adds
// exactly those two scopes to one active key (POST /developer/v1/agent-sessions/daebot-scopes); this server calls it with its own admin key for
// the key it holds. No other key is touched and nothing is widened beyond chat:read/chat:write.
import { edgeFallbackFetch } from "../provider/edge-fallback.ts";

export const SCOPE_UPGRADE_PATH = "/agent-sessions/daebot-scopes";

/** True when a MIND error means "the key lacks a chat scope". */
export function isChatScopeError(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  return /lacks required scope:\s*chat:(read|write)/i.test(String(err?.message ?? "")) && (err?.status === undefined || err.status === 403);
}

export interface UpgradeOpts { baseUrl: string; adminKey: string; key: string; fetchImpl?: typeof fetch }

/** Asks MIND to add chat:read + chat:write to `key`. Never throws: false = not upgraded (no admin key, MIND refused, unreachable). */
export async function upgradeChatScopes(o: UpgradeOpts): Promise<boolean> {
  if (!o.adminKey || !o.key) return false;
  const base = (o.baseUrl || "https://m-i-n-d.ai/developer/v1").replace(/\/+$/, "");
  try {
    const f = edgeFallbackFetch(o.fetchImpl ?? ((...a) => fetch(...a)));
    const res = await f(`${base}${SCOPE_UPGRADE_PATH}`, {
      method: "POST",
      headers: { "X-API-Key": o.adminKey, "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ key: o.key }),
      signal: AbortSignal.timeout(20_000),
    });
    return res.ok;
  } catch { return false; }
}
