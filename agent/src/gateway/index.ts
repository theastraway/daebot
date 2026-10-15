import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import type { AgentEvent, AgentSession, ClientFrame, Config, Runtime, ServerFrame } from "../types.ts";
import { COOKIE_NAME, hostnameOf, isLocalHost, isLocalOrigin, loadOrCreateToken, parseCookies, presentedToken, safeEqual } from "./auth.ts";
import { HostedConfigError, LoginLimiter, MIN_TOKEN_LEN, SESSION_TTL_MS, issueSession, verifySession } from "../hosted.ts";
import type { HostedOptions } from "../hosted.ts";
import { BusyError, NotFoundError, SessionManager } from "./sessions.ts";
import { STATIC_CSP, resolveStatic, serveFile } from "./static.ts";
import { acceptWebSocket } from "./ws.ts";
import type { WsConnection } from "./ws.ts";

// ---------- inbound webhooks (channel adapters register here) ----------
export interface WebhookRequest {
  channel: string;
  method: string;
  headers: IncomingHttpHeaders;
  query: Record<string, string>;
  body: Buffer;
  text: string;
}
export interface WebhookResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | object;
}
export type WebhookHandler = (req: WebhookRequest) => Promise<WebhookResponse | void> | WebhookResponse | void;

// auth "token" (default): caller must present the gateway bearer token.
// auth "none": third-party senders (SendBlue etc.) cannot hold our token, so the adapter MUST verify its
// own signature/secret inside the handler. Host/Origin checks are skipped for these routes only.
const webhooks = new Map<string, { handler: WebhookHandler; auth: "token" | "none" }>();

export function registerWebhook(channel: string, handler: WebhookHandler, opts: { auth?: "token" | "none" } = {}): () => void {
  if (!/^[a-z0-9_-]{1,40}$/i.test(channel)) throw new Error("invalid webhook channel name");
  const entry = { handler, auth: opts.auth ?? "token" };
  webhooks.set(channel.toLowerCase(), entry);
  return () => {
    if (webhooks.get(channel.toLowerCase()) === entry) webhooks.delete(channel.toLowerCase());
  };
}

export interface GatewayOptions {
  runtime: Runtime;
  cfg?: Config;
  port?: number;
  host?: string;
  staticDir?: string;
  tokenPath?: string;
  idleMs?: number; // tests
  /** Public deployment: login screen, Host allowlist, secure cookies, security headers. */
  hosted?: HostedOptions;
}

export const HOSTED_COOKIE = "mc_session";
// Reachable without a session in hosted mode (the login page and what it needs to render).
const HOSTED_PUBLIC_STATIC = new Set(["/login.html", "/login.js", "/login.css", "/style.css", "/favicon.svg"]);
const HSTS = "max-age=31536000; includeSubDomains";

const MAX_BODY = 1 << 20;

function defaultStaticDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  let v: unknown;
  try {
    v = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new HttpError(400, "expected a JSON object");
  return v as Record<string, unknown>;
}

const BASE_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(data)),
    "cache-control": "no-store",
    ...BASE_HEADERS,
  });
  res.end(data);
}

function optStr(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, "expected a string");
  if (v.length > max) throw new HttpError(400, "string too long");
  return v;
}

export interface GatewayHandle {
  url: string;
  token: string;
  // In-process entry for channel adapters (ChannelAdapter.start's gateway): opts.identity is forwarded to runtime.openSession.
  open(surface: string, title?: string, opts?: { identity?: string }): Promise<AgentSession>;
  close(): Promise<void>;
}

export async function startGateway(opts: GatewayOptions): Promise<GatewayHandle> {
  const hosted = opts.hosted;
  if (hosted) {
    if ((hosted.token ?? "").length < MIN_TOKEN_LEN) throw new HostedConfigError(`hosted mode needs a login secret of at least ${MIN_TOKEN_LEN} characters`);
    if (!hosted.allowedHosts?.length) throw new HostedConfigError("hosted mode needs a non-empty host allowlist");
  }
  const allowedHosts = new Set((hosted?.allowedHosts ?? []).map((h) => h.toLowerCase()));
  const limiter = new LoginLimiter({ maxFails: hosted?.loginMaxFails, windowMs: hosted?.loginWindowMs });
  const host = opts.host ?? (hosted ? "0.0.0.0" : "127.0.0.1");
  const token = hosted ? hosted.token : loadOrCreateToken(opts.tokenPath);
  const staticDir = opts.staticDir ?? defaultStaticDir();
  const manager = new SessionManager(opts.runtime, { idleMs: opts.idleMs });
  const subscribers = new Map<string, Set<WsConnection>>(); // sessionId -> ws conns
  const wsConns = new Set<WsConnection>();
  const SESSION_ROUTE = /^\/sessions\/([^/]+)(?:\/(send|abort|violations))?$/;

  function subscribe(id: string, c: WsConnection): void {
    let set = subscribers.get(id);
    if (!set) subscribers.set(id, (set = new Set()));
    set.add(c);
  }
  function broadcast(id: string, ev: AgentEvent): void {
    const frame: ServerFrame = { t: "event", sessionId: id, event: ev };
    const text = JSON.stringify(frame);
    for (const c of subscribers.get(id) ?? []) c.send(text);
  }

  function authorized(req: IncomingMessage, query: URLSearchParams, allowQuery: boolean): boolean {
    // Hosted: only a signed session cookie from /login counts. No bearer, no ?token=, so every guess goes through the rate limiter.
    if (hosted) return verifySession(token, parseCookies(req.headers["cookie"])[HOSTED_COOKIE]);
    const t = presentedToken(req, query, allowQuery);
    return t !== undefined && safeEqual(t, token);
  }

  function headerOne(req: IncomingMessage, name: string): string | undefined {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  }

  // Host check. Hosted: the Host header AND any X-Forwarded-Host must both be allowlisted, so a spoofed
  // forwarded header can neither smuggle in nor mask a bad Host.
  function hostOk(req: IncomingMessage): boolean {
    if (!hosted) return isLocalHost(req.headers.host);
    const h = req.headers.host;
    if (!h || !allowedHosts.has(hostnameOf(h))) return false;
    const xfh = headerOne(req, "x-forwarded-host");
    if (xfh === undefined) return true;
    return xfh.split(",").every((x) => allowedHosts.has(hostnameOf(x.trim().toLowerCase())));
  }

  function originOk(origin: string | undefined): boolean {
    if (!hosted) return isLocalOrigin(origin);
    if (origin === undefined) return true;
    try {
      const u = new URL(origin);
      const name = u.hostname.toLowerCase();
      if (!allowedHosts.has(name) && !allowedHosts.has(`[${name}]`)) return false;
      return u.protocol === "https:" || (u.protocol === "http:" && (name === "localhost" || name === "127.0.0.1"));
    } catch {
      return false;
    }
  }

  // Client IP for the login limiter: hosted trusts only the proxy-appended (right-most) X-Forwarded-For entry.
  function clientIp(req: IncomingMessage): string {
    if (hosted) {
      const xff = headerOne(req, "x-forwarded-for");
      if (xff) {
        const last = xff.split(",").pop()?.trim();
        if (last) return last;
      }
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function cookieAttrs(maxAge: number): string {
    return `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  }

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req);
    const wait = limiter.retryAfter(ip);
    if (wait > 0) {
      res.setHeader("retry-after", String(wait));
      return sendJson(res, 429, { error: "too many attempts; try again later" });
    }
    const b = await readJson(req);
    const presented = typeof b.token === "string" && b.token.length <= 512 ? b.token : "";
    if (!presented || !safeEqual(presented, token)) {
      limiter.fail(ip);
      return sendJson(res, 401, { error: "that access code was not accepted" });
    }
    limiter.success(ip);
    const s = issueSession(token, hosted?.sessionTtlMs ?? SESSION_TTL_MS);
    res.setHeader("set-cookie", `${HOSTED_COOKIE}=${s.value}; ${cookieAttrs(s.maxAgeSec)}`);
    return sendJson(res, 200, { ok: true });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? "/";
    const qi = raw.indexOf("?");
    const path = qi === -1 ? raw : raw.slice(0, qi);
    const query = new URLSearchParams(qi === -1 ? "" : raw.slice(qi + 1));
    const method = req.method ?? "GET";

    if (hosted) {
      res.setHeader("strict-transport-security", HSTS);
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("content-security-policy", STATIC_CSP);
      // Platform health probes may not carry our public Host; /health reveals nothing but liveness.
      if (path === "/health" && (method === "GET" || method === "HEAD")) return sendJson(res, 200, { ok: true, name: "mindclaw-gateway", hosted: true });
    }

    const hookMatch = /^\/hooks\/([^/]+)$/.exec(path);
    const hook = hookMatch ? webhooks.get(decodeURIComponent(hookMatch[1]).toLowerCase()) : undefined;
    const openHook = hook?.auth === "none";

    if (!openHook) {
      if (!hostOk(req)) return sendJson(res, 403, { error: "forbidden host" });
      if (!originOk(req.headers.origin as string | undefined)) return sendJson(res, 403, { error: "forbidden origin" });
      if (hosted && headerOne(req, "x-forwarded-proto")?.split(",")[0].trim().toLowerCase() === "http") {
        // Behind the platform proxy a plain-http hop means the client did not use TLS: send it to https.
        if (method === "GET" || method === "HEAD") {
          res.writeHead(308, { location: `https://${req.headers.host}${raw}`, "cache-control": "no-store" });
          return void res.end();
        }
        return sendJson(res, 400, { error: "https required" });
      }
    }

    if (hosted && !openHook) {
      if (path === "/login") {
        if (method === "POST") return login(req, res);
        if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
      } else if (path === "/logout") {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        res.setHeader("set-cookie", `${HOSTED_COOKIE}=; ${cookieAttrs(0)}`);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (path === "/health") {
      if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, { ok: true, name: "mindclaw-gateway", sessions: manager.count() });
    }

    // ---- API surface: everything below needs the token (except opted-out webhooks)
    const isApi = path === "/sessions" || path.startsWith("/sessions/") || path.startsWith("/hooks/") || path === "/ws";
    if (isApi) {
      if (!openHook && !authorized(req, query, false)) {
        res.setHeader("www-authenticate", "Bearer");
        return sendJson(res, 401, { error: "unauthorized" });
      }
      return api(req, res, path, query, method, hookMatch ? hookMatch[1] : undefined, hook);
    }

    // ---- static
    if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
    const extra: Record<string, string> = {};
    let staticPath = path;
    if (hosted) {
      const authed = authorized(req, query, false);
      const isRoot = path === "/" || path === "/index.html" || path === "/login";
      if (isRoot) {
        staticPath = authed && path !== "/login" ? "/index.html" : "/login.html";
        extra["cache-control"] = "no-store";
      } else if (!authed && !HOSTED_PUBLIC_STATIC.has(path)) {
        return sendJson(res, 401, { error: "unauthorized" });
      } else if (path === "/login.html" && authed) {
        extra["cache-control"] = "no-store";
      }
    }
    const file = resolveStatic(staticDir, staticPath);
    if (!file) return sendJson(res, 404, { error: "not found" });
    const qt = hosted ? null : query.get("token");
    if ((path === "/" || path === "/index.html") && qt && safeEqual(qt, token)) {
      extra["set-cookie"] = `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
    }
    serveFile(file, res, method === "HEAD", extra);
  }

  async function api(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    _query: URLSearchParams,
    method: string,
    hookChannel: string | undefined,
    hook: { handler: WebhookHandler; auth: "token" | "none" } | undefined,
  ): Promise<void> {
    if (path === "/ws") return sendJson(res, 426, { error: "websocket upgrade required" });

    if (hookChannel !== undefined) {
      if (!hook) return sendJson(res, 404, { error: "no such webhook" });
      const body = await readBody(req);
      const query: Record<string, string> = {};
      new URLSearchParams(req.url!.includes("?") ? req.url!.slice(req.url!.indexOf("?") + 1) : "").forEach((v, k) => (query[k] = v));
      const out = await hook.handler({ channel: hookChannel.toLowerCase(), method, headers: req.headers, query, body, text: body.toString("utf8") });
      const r = out ?? {};
      const status = r.status ?? 200;
      if (r.body !== undefined && typeof r.body !== "string") return sendJson(res, status, r.body);
      const data = r.body ?? "";
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...BASE_HEADERS, ...(r.headers ?? {}) });
      return void res.end(data);
    }

    if (path === "/sessions") {
      if (method === "GET") return sendJson(res, 200, { sessions: manager.list() });
      if (method === "POST") {
        const b = await readJson(req);
        const ls = await manager.open({
          surface: optStr(b.surface, 40) ?? "web",
          title: optStr(b.title, 200),
          resumeId: optStr(b.resumeId, 200),
        });
        return sendJson(res, 200, { sessionId: ls.id });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    const m = SESSION_ROUTE.exec(path);
    if (!m) return sendJson(res, 404, { error: "not found" });
    let id: string;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return sendJson(res, 400, { error: "bad session id" });
    }
    const action = m[2];
    const ls = manager.get(id);

    if (!action) {
      if (method !== "DELETE") return sendJson(res, 405, { error: "method not allowed" });
      if (!ls) return sendJson(res, 404, { error: "no such session" });
      await manager.close(id);
      subscribers.delete(id);
      return sendJson(res, 200, { ok: true });
    }
    if (!ls) return sendJson(res, 404, { error: "no such session" });

    if (action === "violations") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, { violations: ls.session.violations() });
    }
    if (action === "abort") {
      if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, { aborted: manager.abort(id) });
    }
    // send
    if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    const b = await readJson(req);
    const text = optStr(b.text, 200_000);
    if (!text || !text.trim()) return sendJson(res, 400, { error: "text required" });
    if (ls.busy) return sendJson(res, 409, { error: "session is busy with another turn" });

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...BASE_HEADERS,
    });
    res.write(": open\n\n");
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort(); // client went away mid-turn
    });
    try {
      await manager.turn(id, text, (ev) => {
        if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        broadcast(id, ev);
      }, ac.signal);
    } catch (err) {
      const msg = err instanceof BusyError || err instanceof NotFoundError ? err.message : "internal error";
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: "notice", level: "warn", text: msg })}\n\n`);
    }
    if (!res.writableEnded) res.end();
  }

  // ---------- WebSocket ----------
  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const raw = req.url ?? "/";
    const qi = raw.indexOf("?");
    const path = qi === -1 ? raw : raw.slice(0, qi);
    const query = new URLSearchParams(qi === -1 ? "" : raw.slice(qi + 1));
    const reject = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (path !== "/ws") return reject("404 Not Found");
    if (!hostOk(req) || !originOk(req.headers.origin as string | undefined)) return reject("403 Forbidden");
    if (!authorized(req, query, true)) return reject("401 Unauthorized");
    const conn = acceptWebSocket(req, socket, head);
    if (!conn) return;
    wsConns.add(conn);
    conn.on("close", () => {
      wsConns.delete(conn);
      for (const set of subscribers.values()) set.delete(conn);
    });
    conn.on("message", (text: string) => void onFrame(conn, text));
  }

  function sendFrame(c: WsConnection, f: ServerFrame): void {
    c.send(JSON.stringify(f));
  }

  async function onFrame(c: WsConnection, text: string): Promise<void> {
    let f: ClientFrame;
    try {
      f = JSON.parse(text) as ClientFrame;
    } catch {
      return sendFrame(c, { t: "error", message: "invalid JSON frame" });
    }
    if (typeof f !== "object" || f === null || typeof (f as { t?: unknown }).t !== "string") {
      return sendFrame(c, { t: "error", message: "invalid frame" });
    }
    try {
      switch (f.t) {
        case "open": {
          const ls = await manager.open({
            surface: typeof f.surface === "string" ? f.surface.slice(0, 40) : "web",
            title: typeof f.title === "string" ? f.title.slice(0, 200) : undefined,
            resumeId: typeof f.resumeId === "string" ? f.resumeId : undefined,
          });
          subscribe(ls.id, c);
          return sendFrame(c, { t: "opened", sessionId: ls.id });
        }
        case "send": {
          if (typeof f.sessionId !== "string" || typeof f.text !== "string" || !f.text.trim()) {
            return sendFrame(c, { t: "error", message: "send needs sessionId and text" });
          }
          const ls = manager.get(f.sessionId);
          if (!ls) return sendFrame(c, { t: "error", message: "no such session" });
          if (ls.busy) return sendFrame(c, { t: "error", message: "session is busy with another turn" });
          subscribe(ls.id, c);
          await manager.turn(ls.id, f.text, (ev) => broadcast(ls.id, ev));
          return;
        }
        case "abort": {
          manager.abort(String(f.sessionId));
          return;
        }
        case "close": {
          await manager.close(String(f.sessionId));
          subscribers.delete(String(f.sessionId));
          return;
        }
        default:
          return sendFrame(c, { t: "error", message: "unknown frame type" });
      }
    } catch (err) {
      sendFrame(c, { t: "error", message: err instanceof Error ? err.message.slice(0, 300) : "error" });
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      sendJson(res, 500, { error: err instanceof Error ? err.message.slice(0, 300) : "internal error" });
    });
  });
  server.on("upgrade", onUpgrade);

  const pinger = setInterval(() => {
    for (const c of wsConns) c.ping();
  }, 30_000);
  pinger.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 7777, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const shownHost = host === "::1" ? "[::1]" : host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${shownHost}:${addr.port}`;

  return {
    url,
    token,
    async open(surface, title, o) {
      const ls = await manager.open({ surface: surface.slice(0, 40), title: title?.slice(0, 200), identity: o?.identity });
      return ls.session;
    },
    async close() {
      clearInterval(pinger);
      for (const c of wsConns) c.close(1001, "server shutting down");
      await manager.closeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
