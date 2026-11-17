// Your database (MIND's database bridge) for Daebot: the signed-in user's own Postgres, the same setting MIND shows under
// Settings > Bridges, reached through MIND's /developer/v1/bridges twins with the user's own MIND key.
//   GET    /bridges                     -> GET    /developer/v1/bridges                    { feature_available, providers, llm, db }
//   POST   /bridges/db/test             -> POST   /developer/v1/bridges/db/test            { ok, latency_ms, pgvector, error? }
//   PUT    /bridges/db                  -> PUT    /developer/v1/bridges/db                 (test, bootstrap, store encrypted)
//   POST   /bridges/db/bootstrap        -> POST   /developer/v1/bridges/db/bootstrap
//   POST   /bridges/db/verify-routing   -> POST   /developer/v1/bridges/db/verify-routing
//   DELETE /bridges/db                  -> DELETE /developer/v1/bridges/db
// The password travels in the JSON body to MIND and is never returned, logged or kept here. MIND stores it encrypted.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../auth/users.ts";

const UPSTREAM_TIMEOUT_MS = 45_000; // a bootstrap creates tables on the user's database
const SSL = new Set(["disable", "prefer", "require", "verify-ca", "verify-full"]);
const HOST_RE = /^[A-Za-z0-9._\-\[\]:]{1,253}$/;

export interface BridgesOptions {
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

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    let n = 0;
    req.on("data", (c: Buffer) => { n += c.length; if (n > 8 * 1024) req.destroy(); else chunks.push(c); });
    req.on("end", () => resolve());
    req.on("error", () => resolve());
    req.on("close", () => resolve());
  });
  try { const j = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}

/** The connection form, checked; or an error message. The password passes through untouched (and only to MIND). */
export function cleanDbBody(b: Record<string, unknown>): { body: Record<string, unknown> } | { error: string } {
  const host = typeof b.host === "string" ? b.host.trim() : "";
  if (!host || !HOST_RE.test(host) || /^\s*(https?:)?\/\//.test(host)) return { error: "Enter the database host name, without http://." };
  const port = b.port === undefined || b.port === "" ? 5432 : Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "Port must be between 1 and 65535." };
  const s = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const ssl = typeof b.ssl === "string" ? b.ssl.trim() : b.ssl === false ? "disable" : "require";
  if (!SSL.has(ssl)) return { error: "SSL mode must be disable, prefer, require, verify-ca or verify-full." };
  const out: Record<string, unknown> = { host, port, ssl };
  const database = s(b.database, 120); if (database) out.database = database;
  const user = s(b.user, 120); if (user) out.user = user;
  if (typeof b.password === "string" && b.password) { if (b.password.length > 500) return { error: "That password is too long." }; out.password = b.password; }
  return { body: out };
}

/** MIND's error detail as a sentence for the panel; the status the gateway answers with. */
function mapError(status: number, detail: unknown): { status: number; body: Record<string, unknown> } {
  const d: any = detail;
  const msg = typeof d === "string" ? d : typeof d?.message === "string" ? d.message : typeof d?.detail === "string" ? d.detail : typeof d?.detail?.message === "string" ? d.detail.message : "";
  const code = typeof d?.error === "string" ? d.error : typeof d?.detail?.error === "string" ? d.detail.error : "";
  if (status === 401 || status === 403) return { status: 401, body: { error: "bridges_unauth", message: "MIND did not accept your key. Sign in again." } };
  if (status === 404) return { status: 200, body: { feature_available: false, message: msg || "Your own database is not available on MIND yet." } };
  if (status === 429) return { status: 429, body: { error: "rate_limited", message: msg || "Too many checks. Try again in a minute." } };
  if (status === 409 || status === 400 || status === 422) return { status: 400, body: { error: code || "bridges_refused", message: msg || "MIND could not accept that request." } };
  return { status: 502, body: { error: code || "bridges_failed", message: msg || "MIND could not finish that request. Try again in a moment." } };
}

export function createBridgesHandler(o: BridgesOptions): (req: IncomingMessage, res: ServerResponse, path: string, p: Principal) => Promise<void> {
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.baseUrl.replace(/\/+$/, "");
  const call = async (res: ServerResponse, key: string, pathPart: string, method: string, body?: Record<string, unknown>): Promise<void> => {
    try {
      const r = await f(`${base}${pathPart}`, { method, headers: { Accept: "application/json", "X-API-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) { const m = mapError(r.status, j); return json(res, m.status, m.body); }
      return json(res, 200, j);
    } catch {
      return json(res, 502, { error: "bridges_failed", message: "MIND could not be reached. Try again in a moment." });
    }
  };

  return async (req, res, path, principal) => {
    const method = (req.method ?? "GET").toUpperCase();
    const key = o.keyFor(principal);
    if (!key) {
      if (path === "/bridges" && method === "GET") return json(res, 200, { feature_available: false, signed_out: true });
      return json(res, 403, { error: "sign_in_with_mind", message: "Sign in with MIND to connect your database." });
    }
    if (path === "/bridges" && method === "GET") return call(res, key, "/bridges", "GET");
    if (path === "/bridges/db/test" && method === "POST") {
      const c = cleanDbBody(await readBody(req));
      if ("error" in c) return json(res, 400, { error: "bad_db", message: c.error, ok: false });
      return call(res, key, "/bridges/db/test", "POST", c.body);
    }
    if (path === "/bridges/db" && method === "PUT") {
      const c = cleanDbBody(await readBody(req));
      if ("error" in c) return json(res, 400, { error: "bad_db", message: c.error });
      return call(res, key, "/bridges/db", "PUT", c.body);
    }
    if (path === "/bridges/db/bootstrap" && method === "POST") return call(res, key, "/bridges/db/bootstrap", "POST", {});
    if (path === "/bridges/db/verify-routing" && method === "POST") return call(res, key, "/bridges/db/verify-routing", "POST", {});
    if (path === "/bridges/db" && method === "DELETE") return call(res, key, "/bridges/db", "DELETE");
    return json(res, 405, { error: "method not allowed" });
  };
}
