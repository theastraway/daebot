/**
 * Minimal MIND API client used by the MINDClaw wrapper.
 *
 * Talks to the public MIND endpoints — registration, login, account status,
 * and the typed-document save flow used by `mindclaw seed-templates`.  No
 * partner-key embedding (the open-source distribution must not ship secrets);
 * all auth flows go through the same endpoints the web app uses.
 */

const DEFAULT_BASE = "https://www.m-i-n-d.ai";

async function request(baseUrl, path, { method = "GET", apiKey, jwt, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  else if (jwt) headers.Authorization = `Bearer ${jwt}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const detail =
      typeof parsed?.detail === "string"
        ? parsed.detail
        : parsed?.detail?.message ?? parsed?.message ?? `HTTP ${res.status}`;
    const error = new Error(detail);
    error.status = res.status;
    error.body = parsed;
    throw error;
  }
  return parsed;
}

export function makeClient(opts = {}) {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  return {
    baseUrl,
    register: (payload) =>
      request(baseUrl, "/api/auth/register", {
        method: "POST",
        body: payload,
      }),
    login: (payload) =>
      request(baseUrl, "/api/auth/login", {
        method: "POST",
        body: payload,
      }),
    issueApiKey: ({ jwt, name }) =>
      request(baseUrl, "/api/developer/keys", {
        method: "POST",
        jwt,
        body: { name: name ?? "MINDClaw" },
      }),
    me: ({ apiKey }) =>
      request(baseUrl, "/api/auth/me", { apiKey }),
    saveTyped: ({ apiKey, type, title, content, tags }) =>
      request(baseUrl, "/v1/templates/save", {
        method: "POST",
        apiKey,
        body: { type, title, content, tags },
      }),
    bootstrapTemplates: ({ apiKey }) =>
      request(baseUrl, "/v1/templates/bootstrap", {
        method: "POST",
        apiKey,
        body: {},
      }),
    upgradeCheckoutUrl: ({ apiKey, tier }) =>
      request(baseUrl, "/api/billing/checkout", {
        method: "POST",
        apiKey,
        body: { tier, success_url: "https://www.m-i-n-d.ai/mindclaw.html?upgraded=1" },
      }),
    googleAuthUrl: ({ redirectAfter }) =>
      request(
        baseUrl,
        `/oauth/google/url?redirect_after=${encodeURIComponent(redirectAfter)}`
      ),
  };
}
