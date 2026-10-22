// HTTP face of the admin ledgers (see mistakes.ts): the two admin pages, their assets, and /api/admin/{mistakes,tasks}.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqual } from "./auth.ts";
import { AdminLedger } from "./mistakes.ts";

export const LOG_KEY_HEADER = "x-daebot-log-key";
const PAGES: Record<string, string> = { "/admin/mistakes": "mistakes", "/admin/kpis": "kpis" };
const ASSETS: Record<string, [string, string]> = {
  "/admin/assets/admin.js": ["admin.js", "text/javascript; charset=utf-8"],
  "/admin/assets/admin.css": ["admin.css", "text/css; charset=utf-8"],
};
const SEC = {
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(data)), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(data);
}
const TITLES: Record<string, string> = { mistakes: "Mistake Log", kpis: "Task KPIs" };
function pageHtml(kind: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${TITLES[kind]} - Daebot admin</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/admin/assets/admin.css"></head><body data-page="${kind}"><div id="root"></div><script src="/admin/assets/admin.js" defer></script></body></html>`;
}
function readBody(req: IncomingMessage, max = 8 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []; let n = 0;
    req.on("data", (c: Buffer) => { n += c.length; if (n > max) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

export interface AdminOptions {
  ledger: AdminLedger;
  /** The secret for writes (DAEBOT_MISTAKE_LOG_KEY), read per request so setting it on Render needs no code change. */
  logKey: () => string | undefined;
  /** True when the request carries an admin session (cookie) or, locally, the gateway token. */
  isAdmin: (req: IncomingMessage) => boolean;
  /** True when there is any signed-in session at all (to tell "sign in" from "not an admin"). */
  signedIn: (req: IncomingMessage) => boolean;
}

export function isAdminPath(path: string): boolean { return path.startsWith("/admin/") || path.startsWith("/api/admin/"); }

/** Handles /admin/* and /api/admin/*. Returns true when it answered. */
export async function handleAdmin(o: AdminOptions, req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
  if (!isAdminPath(path)) return false;
  const method = req.method ?? "GET";
  const secret = o.logKey();
  const presented = req.headers[LOG_KEY_HEADER];
  const keyOk = !!secret && typeof presented === "string" && presented.length > 0 && safeEqual(presented, secret);

  if (path.startsWith("/admin/")) {
    if (method !== "GET" && method !== "HEAD") { json(res, 405, { error: "method not allowed" }); return true; }
    if (!o.isAdmin(req)) {
      if (!o.signedIn(req)) { res.writeHead(302, { location: "/login", "cache-control": "no-store" }); res.end(); return true; }
      json(res, 403, { error: "admin only" }); return true;
    }
    const asset = ASSETS[path];
    if (asset) {
      try {
        const data = readFileSync(new URL(`./admin-assets/${asset[0]}`, import.meta.url));
        res.writeHead(200, { ...SEC, "content-type": asset[1], "content-length": String(data.length) });
        res.end(method === "HEAD" ? undefined : data);
      } catch { json(res, 404, { error: "not found" }); }
      return true;
    }
    const kind = PAGES[path.replace(/\/+$/, "")];
    if (!kind) { json(res, 404, { error: "not found" }); return true; }
    const html = pageHtml(kind);
    res.writeHead(200, { ...SEC, "content-type": "text/html; charset=utf-8", "content-length": String(Buffer.byteLength(html)) });
    res.end(method === "HEAD" ? undefined : html);
    return true;
  }

  // ---- API. Reads: log key or admin session. Writes: log key only (a browser session can never alter the ledger).
  const isMistakes = path === "/api/admin/mistakes", isTasks = path === "/api/admin/tasks";
  const delOcc = /^\/api\/admin\/mistakes\/occurrence\/([\w-]{1,80})$/.exec(path), delTask = /^\/api\/admin\/tasks\/([\w-]{1,80})$/.exec(path);
  if (!isMistakes && !isTasks && !delOcc && !delTask) { json(res, 404, { error: "not found" }); return true; }
  if (method === "GET") {
    if (!keyOk && !o.isAdmin(req)) { json(res, keyOk || !secret ? 401 : 401, { error: "unauthorized" }); return true; }
    if (isMistakes) { json(res, 200, o.ledger.mistakeView(query)); return true; }
    if (isTasks) { json(res, 200, o.ledger.taskView(query)); return true; }
    json(res, 405, { error: "method not allowed" }); return true;
  }
  if (!secret) { json(res, 503, { error: "DAEBOT_MISTAKE_LOG_KEY is not set on the server" }); return true; }
  if (!keyOk) { json(res, 401, { error: "unauthorized" }); return true; }
  try {
    if (method === "DELETE") {
      const ok = delOcc ? o.ledger.deleteOccurrence(delOcc[1]) : delTask ? o.ledger.deleteTask(delTask[1]) : false;
      json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "not found" }); return true;
    }
    if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
    let b: any;
    try { b = JSON.parse((await readBody(req)) || "{}"); } catch (e: any) { if (e?.status === 413) { json(res, 413, { error: "body too large" }); return true; } json(res, 400, { error: "invalid JSON" }); return true; }
    if (!b || typeof b !== "object") { json(res, 400, { error: "object body required" }); return true; }
    if (isMistakes) {
      if (Array.isArray(b.batch)) { json(res, 200, { ok: true, ...o.ledger.logMistakeBatch(b.batch) }); return true; }
      json(res, 200, { ok: true, ...o.ledger.logMistake(b) }); return true;
    }
    if (isTasks) {
      if (Array.isArray(b.batch)) { json(res, 200, { ok: true, ...o.ledger.upsertTaskBatch(b.batch) }); return true; }
      json(res, 200, { ok: true, ...o.ledger.upsertTask(b) }); return true;
    }
    json(res, 404, { error: "not found" }); return true;
  } catch (e: any) { json(res, 400, { error: String(e?.message ?? e).slice(0, 200) }); return true; }
}
