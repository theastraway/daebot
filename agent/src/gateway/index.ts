import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { AgentEvent, AgentSession, ClientFrame, Config, MindClient, Runtime, ServerFrame } from "../types.ts";
import { COOKIE_NAME, hostnameOf, isLocalHost, isLocalOrigin, loadOrCreateToken, parseCookies, presentedToken, safeEqual } from "./auth.ts";
import { HostedConfigError, LoginLimiter, MIN_TOKEN_LEN, SESSION_TTL_MS, issueSession, parseSession } from "../hosted.ts";
import type { HostedOptions } from "../hosted.ts";
import { RunRegistry } from "./runs.ts";
import type { Run } from "./runs.ts";
import { BusyError, ForbiddenError, NotFoundError, SessionManager } from "./sessions.ts";
import { OWNER } from "../auth/users.ts";
import type { Principal } from "../auth/users.ts";
import type { AuthContext } from "../auth/tenancy.ts";
import { MindAuthError, whoami } from "../auth/mind-auth.ts";
import { AppHandoff, appRedirect, isValidChallenge } from "../auth/app-handoff.ts";
import { AGENT_SURFACE_RE, AGENT_TURN_PATH, KeyIdentityCache, TurnRateLimiter } from "./agent-api.ts";
import { userIdFor } from "../auth/users.ts";
import { FREE_TIER, usageLeftPct } from "../provider/mind.ts";
import { createBotBus } from "../bots/bus.ts";
import { BotError, safeUpgradeUrl } from "../bots/types.ts";
import type { BotRecord, BotsContext } from "../bots/types.ts";
import { botsEnabled } from "../bots/flag.ts";
import { versionInfo } from "../bots/versions.ts";
import { createModelCatalog } from "../models.ts";
import { McpConnectError } from "../mcpconnect/service.ts";
import type { McpConnectService } from "../mcpconnect/service.ts";
import { createHmac } from "node:crypto";
import { validModelId } from "../settings.ts";
import { STATIC_CSP, resolveStatic, serveEmbedded, serveFile } from "./static.ts";
import { EMBEDDED_FILES } from "../embedded.generated.ts";
import { hasEmbeddedSite } from "../embedded.ts";
import { acceptWebSocket } from "./ws.ts";
import { createVoiceHandler } from "./voice.ts";
import { buildId, handleAppFeed } from "./appfeed.ts";
import { createAppsHandler } from "./apps.ts";
import type { AppsOptions } from "./apps.ts";
import type { VoiceOptions } from "./voice.ts";
import type { WsConnection } from "./ws.ts";
import { handleAdmin, isAdminPath } from "./admin.ts";
import { AdminLedger } from "./mistakes.ts";
import { AngerLedger } from "./anger.ts";
import { MindFeed } from "./mind-feed.ts";
import { createMindClient } from "../mind/client.ts";
import { dataDir } from "../persist.ts";

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
  /** Web UI baked into a compiled binary (path -> base64). Defaults to the generated module, which is empty on Node. Tests only. */
  embeddedFiles?: Record<string, string>;
  tokenPath?: string;
  idleMs?: number; // tests
  /** Public deployment: login screen, Host allowlist, secure cookies, security headers. */
  hosted?: HostedOptions;
  /** Hosted multi-user sign-in (MIND OAuth / API key) and the per-user runtimes. Owner access-code login keeps working without it. */
  auth?: AuthContext;
  /** The shared session store (DATA_DIR/sessions); lets ownership of persisted sessions be checked without a live session. */
  sessionStore?: { meta?(id: string): { owner?: string } | undefined };
  /** MIND Voice (/voice/stt, /voice/tts). Defaults from cfg + auth; pass to override (tests). */
  voice?: Partial<VoiceOptions>;
  /** Apps card (/apps/integrations): MIND integrations proxied with the signed-in user's own key. Defaults from cfg + auth; pass to override (tests). */
  apps?: Partial<AppsOptions>;
  /** POST /api/agent/turn per-user limit (turns per minute). Default DAEBOT_AGENT_API_RPM or 30. */
  agentApiPerMinute?: number;
  /** Bots: the late-bound bus holder shared with the runtimes. startGateway sets bus.current to the in-process bot bus. */
  bots?: BotsContext;
  /** Feature flag override (default: env DAEBOT_BOTS_ENABLED, read per request). */
  botsEnabled?: () => boolean;
  /** Tests: the fetch used for the model catalog. */
  fetchImpl?: typeof fetch;
  /** Connected MCP servers (consent card routes under /mcp/*). Absent = the feature is not offered here. */
  mcpConnect?: McpConnectService;
  /** Admin ledgers (/admin/mistakes, /admin/kpis, /api/admin/*). dir defaults to DATA_DIR; logKey to env DAEBOT_MISTAKE_LOG_KEY (read per request). */
  adminLog?: { dir?: string; logKey?: () => string | undefined; mindClient?: Pick<MindClient, "remember" | "call"> | null };
}

export const HOSTED_COOKIE = "mc_session";
export const OAUTH_COOKIE = "mc_oauth";
// Marks that THIS auth sheet was started by the native app, so a callback that arrives after the in-memory flow expired still ends at daebot:// (with an error) instead of stranding the sheet on a web page.
export const OAUTH_APP_COOKIE = "mc_oauth_app";
// Reachable without a session in hosted mode (the login page and what it needs to render).
// The download page (daebot.live/download) is public: it only links to release files hosted elsewhere.
const HOSTED_PUBLIC_STATIC = new Set([
  "/login.html", "/login.js", "/login.css", "/style.css", "/favicon.svg", "/brand/mbot.js", "/brand/daebot-head.webp",
  "/download", "/download/", "/download/index.html", "/download/download.js", "/download/download.css", "/download/releases.json", "/download/ios-latest.json",
]);
const HSTS = "max-age=31536000; includeSubDomains";

const MAX_BODY = 1 << 20;

// Where the web UI lives when it is not embedded: a web/ folder next to a compiled binary, else the source tree.
function defaultStaticDir(): string {
  if (typeof (process.versions as Record<string, string | undefined>).bun === "string") {
    const beside = join(dirname(process.execPath), "web");
    if (existsSync(join(beside, "index.html"))) return beside;
  }
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
  // Static source order: an explicit staticDir, then the site embedded in a compiled binary, then web/ beside it, then the source tree.
  const embeddedFiles = opts.embeddedFiles ?? EMBEDDED_FILES;
  const useEmbedded = !opts.staticDir && hasEmbeddedSite(embeddedFiles);
  const staticDir = opts.staticDir ?? (useEmbedded ? "" : defaultStaticDir());
  const auth = hosted ? opts.auth : undefined;
  const deadRuntime = { openSession: async () => { throw new Error("Your MIND sign-in expired. Sign in again."); }, listSessions: () => [] };
  // Sessions are owned by the principal that opened them; each owner gets its own runtime (users: their own MIND).
  const manager = new SessionManager(opts.runtime, {
    idleMs: opts.idleMs,
    storedOwner: (id) => { const m = opts.sessionStore?.meta?.(id); return m ? (m.owner ?? "owner") : undefined; },
    runtimeFor: auth
      ? (ownerId) => {
          if (ownerId === OWNER.id) return opts.runtime;
          const p = auth.store.principal(ownerId);
          return p ? auth.runtimeFor(p) : deadRuntime;
        }
      : undefined,
  });
  const botsOn = (): boolean => (opts.botsEnabled ? opts.botsEnabled() : botsEnabled());
  const mcp = opts.mcpConnect;
  const mcpOn = (): boolean => !!mcp?.enabled();
  const mcpField = (): { mcp?: boolean } => (mcp ? { mcp: mcpOn() } : {}); // only reported where the feature is wired in
  // ---- Bots: the bus runs a recipient bot's turn in-process through this same SessionManager.
  if (opts.bots) opts.bots.bus.current = createBotBus({ manager, botsFor: (owner) => manager.runtimeOf(owner).bots, tierOf: (owner) => (owner === OWNER.id ? OWNER.tier : auth?.store.principal(owner)?.tier) });
  const catalog = createModelCatalog({ cfg: opts.cfg ?? ({ mindBaseUrl: "", models: { default: "", cheap: "", fallback: [] } } as unknown as Config), fetchImpl: opts.fetchImpl ?? opts.auth?.fetchImpl });
  // ---- MIND Voice: billed to the caller's own MIND key (owner: the server key). Off when there is no MIND base URL.
  const voiceBase = opts.voice?.baseUrl ?? opts.cfg?.mindBaseUrl;
  const voice = voiceBase
    ? createVoiceHandler({
        baseUrl: voiceBase,
        keyFor: opts.voice?.keyFor ?? ((p) => (auth ? auth.billingKey(p) : opts.cfg?.mindApiKey || undefined)),
        fetchImpl: opts.voice?.fetchImpl ?? opts.auth?.fetchImpl,
        now: opts.voice?.now,
        onUsed: opts.voice?.onUsed ?? ((key) => { try { auth?.credits?.get(key, true).catch(() => {}); } catch { /* best effort */ } }),
      })
    : undefined;
  // ---- Apps: the user's MIND integrations, always with THEIR key (owner login: a plain sign-in-with-MIND answer).
  const appsBase = opts.apps?.baseUrl ?? opts.cfg?.mindBaseUrl;
  const apps = appsBase
    ? createAppsHandler({
        baseUrl: appsBase,
        // Hosted: each signed-in user's own key (the access-code owner has none). Desktop/CLI (no auth): the key the app signed in with.
        keyFor: opts.apps?.keyFor ?? ((p) => (auth ? (p.owner ? undefined : auth.billingKey(p)) : opts.cfg?.mindApiKey || undefined)),
        returnTo: opts.apps?.returnTo ?? (process.env.DAEBOT_PUBLIC_URL?.trim() || (hosted?.allowedHosts?.[0] && hosted.allowedHosts[0] !== "localhost" ? `https://${hosted.allowedHosts[0]}` : undefined)),
        fetchImpl: opts.apps?.fetchImpl ?? opts.auth?.fetchImpl,
      })
    : undefined;
  let adminLedger: AdminLedger | undefined;
  let angerLedger: AngerLedger | undefined;
  const anger = (): AngerLedger => (angerLedger ??= new AngerLedger(opts.adminLog?.dir ?? dataDir()));
  const ledger = (): AdminLedger => (adminLedger ??= new AdminLedger(opts.adminLog?.dir ?? dataDir()));
  // The ledger feeds Daebot's own MIND (the server's owner key = Anthony's MIND, never a client tenant) in the same request as each write.
  const feedClient = opts.adminLog?.mindClient !== undefined ? opts.adminLog.mindClient : opts.cfg?.mindApiKey ? createMindClient(opts.cfg) : null;
  const mindFeed = feedClient ? new MindFeed(feedClient, ledger) : undefined;
  if (mindFeed && hosted && !opts.adminLog?.mindClient) mindFeed.start();
  const turnLimiter = new TurnRateLimiter({ max: opts.agentApiPerMinute ?? (Number(process.env.DAEBOT_AGENT_API_RPM) || 30) });
  const keyIdentities = new KeyIdentityCache();
  const wsWho = new WeakMap<WsConnection, Principal>();
  const subscribers = new Map<string, Set<WsConnection>>(); // sessionId -> ws conns
  const runs = new RunRegistry(); // server-owned turns: they outlive the request that started them
  const wsConns = new Set<WsConnection>();
  const SESSION_ROUTE = /^\/sessions\/([^/]+)(?:\/(send|abort|violations|history|events))?$/;
  // Which LLM answers (shown in the UI). Absent when the gateway was started without a Config (tests, fakes).
  const modelInfo = (): { model?: string; provider?: string } => (opts.cfg ? { model: opts.cfg.models.default, provider: opts.cfg.billing === "mind" ? "MIND" : "openrouter" } : {});

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

  // Who is this request? Hosted: the signed session cookie names the owner (access code) or one stored MIND user.
  function principalOf(req: IncomingMessage): Principal | undefined {
    const s = parseSession(token, parseCookies(req.headers["cookie"])[HOSTED_COOKIE]);
    if (!s) return undefined;
    if (s.uid === "owner") return OWNER;
    return auth?.store.principal(s.uid); // a removed user's old cookie stops working
  }

  function authorized(req: IncomingMessage, query: URLSearchParams, allowQuery: boolean): boolean {
    // Hosted: only a signed session cookie from /login counts. No bearer, no ?token=, so every guess goes through the rate limiter.
    if (hosted) return principalOf(req) !== undefined;
    const t = presentedToken(req, query, allowQuery);
    return t !== undefined && safeEqual(t, token);
  }

  function who(req: IncomingMessage): Principal {
    return hosted ? principalOf(req) ?? OWNER : OWNER; // callers have already passed authorized()
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

  function userCookie(uid: string): string {
    const s = issueSession(token, hosted?.sessionTtlMs ?? SESSION_TTL_MS, Date.now(), uid);
    return `${HOSTED_COOKIE}=${s.value}; ${cookieAttrs(s.maxAgeSec)}`;
  }

  function mayUse(username: string): boolean {
    return !auth || auth.allowedUsers.length === 0 || auth.allowedUsers.includes(username.trim().toLowerCase());
  }

  // "Use a MIND API key": validated live against MIND, then stored sealed under the key's own username.
  async function keyLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!auth?.store.enabled) return sendJson(res, 404, { error: "sign-in with a MIND account is not enabled on this deployment" });
    const ip = clientIp(req);
    const wait = limiter.retryAfter(ip);
    if (wait > 0) {
      res.setHeader("retry-after", String(wait));
      return sendJson(res, 429, { error: "too many attempts; try again later" });
    }
    const b = await readJson(req);
    const key = typeof b.key === "string" && b.key.length <= 600 ? b.key.trim() : "";
    let name: string;
    try {
      name = (await whoami(auth.mindBaseUrl, key, auth.fetchImpl)).username;
    } catch (e) {
      const status = e instanceof MindAuthError ? e.status : 502;
      if (status === 400 || status === 401) limiter.fail(ip);
      return sendJson(res, status === 400 ? 401 : status, { error: e instanceof MindAuthError ? e.message : "could not check that key" });
    }
    if (!mayUse(name)) {
      limiter.fail(ip);
      return sendJson(res, 403, { error: "That MIND account is not enabled for Daebot." });
    }
    limiter.success(ip);
    const user = auth.store.upsert(name, { kind: "key", mindKey: key });
    auth.evict(user.id);
    res.setHeader("set-cookie", userCookie(user.id));
    return sendJson(res, 200, { ok: true, username: user.username });
  }

  // Lax, not Strict: the callback is a cross-site top-level navigation arriving from MIND.
  function oauthCookieAttrs(maxAge: number): string {
    return `HttpOnly; Secure; SameSite=Lax; Path=/auth/mind; Max-Age=${maxAge}`;
  }

  function loginRedirect(res: ServerResponse, code: string): void {
    res.writeHead(302, { location: `/login?e=${code}`, "cache-control": "no-store", "set-cookie": [`${OAUTH_COOKIE}=; ${oauthCookieAttrs(0)}`, `${OAUTH_APP_COOKIE}=; ${oauthCookieAttrs(0)}`] });
    res.end();
  }

  // The native app starts sign-in with ?app=ios&cc=<challenge> inside ASWebAuthenticationSession; the callback then ends at daebot://auth/callback.
  const appHandoff = new AppHandoff();

  /** Ends an app-started flow: the auth sheet must navigate to the app's custom scheme to close. */
  function appReturn(res: ServerResponse, params: { code?: string; error?: string }): void {
    res.writeHead(302, { location: appRedirect(params), "cache-control": "no-store", "set-cookie": [`${OAUTH_COOKIE}=; ${oauthCookieAttrs(0)}`, `${OAUTH_APP_COOKIE}=; ${oauthCookieAttrs(0)}`] });
    res.end();
  }

  // POST /auth/app/exchange {code, verifier}: the app trades its one-time code for the session cookie inside the WebView.
  async function appExchange(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!auth?.store.enabled) return sendJson(res, 404, { error: "not enabled" });
    const ip = clientIp(req);
    const wait = limiter.retryAfter(ip);
    if (wait > 0) {
      res.setHeader("retry-after", String(wait));
      return sendJson(res, 429, { error: "too many attempts; try again later" });
    }
    const b = await readJson(req);
    const uid = appHandoff.redeem(b.code, b.verifier);
    const user = uid ? auth.store.principal(uid) : undefined;
    if (!uid || !user) {
      limiter.fail(ip);
      return sendJson(res, 401, { error: "That sign-in expired. Start again." });
    }
    limiter.success(ip);
    res.setHeader("set-cookie", userCookie(uid));
    return sendJson(res, 200, { ok: true });
  }

  async function oauthStart(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    if (!auth?.store.enabled || !auth.oauth) return loginRedirect(res, "oauth_off");
    const ip = clientIp(req);
    if (limiter.retryAfter(ip) > 0) return loginRedirect(res, "slow");
    const fromApp = query.get("app") === "ios";
    const cc = query.get("cc");
    if (fromApp && !isValidChallenge(cc)) return appReturn(res, { error: "bad_request" });
    try {
      const { url, state } = await auth.oauth.start();
      if (fromApp) appHandoff.beginFlow(state, cc as string);
      res.writeHead(302, { location: url, "cache-control": "no-store", "set-cookie": fromApp ? [`${OAUTH_COOKIE}=${state}; ${oauthCookieAttrs(600)}`, `${OAUTH_APP_COOKIE}=1; ${oauthCookieAttrs(600)}`] : `${OAUTH_COOKIE}=${state}; ${oauthCookieAttrs(600)}` });
      return void res.end();
    } catch {
      return fromApp ? appReturn(res, { error: "oauth_down" }) : loginRedirect(res, "oauth_down");
    }
  }

  async function oauthCallback(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    if (!auth?.store.enabled || !auth.oauth) return loginRedirect(res, "oauth_off");
    const ip = clientIp(req);
    if (limiter.retryAfter(ip) > 0) return loginRedirect(res, "slow");
    const state = query.get("state") ?? "";
    const bound = parseCookies(req.headers["cookie"])[OAUTH_COOKIE] ?? "";
    // The state must be the one this browser was given at /auth/mind/start (blocks login-CSRF / code injection).
    if (!state || !bound || !safeEqual(state, bound)) { limiter.fail(ip); return loginRedirect(res, "state"); }
    const appCc = appHandoff.takeFlow(state); // set only when the native app started this flow
    const appSheet = appCc !== undefined || parseCookies(req.headers["cookie"])[OAUTH_APP_COOKIE] === "1";
    // The app started this sheet but the flow has expired (a slow sign-in): close the sheet with an error rather than stranding it on a web page.
    if (appSheet && appCc === undefined) return appReturn(res, { error: "expired" });
    const fail = (code: string) => (appSheet ? appReturn(res, { error: code }) : loginRedirect(res, code));
    if (query.get("error")) return fail(query.get("error") === "access_denied" ? "denied" : "oauth");
    try {
      const t = await auth.oauth.finish(query.get("code") ?? "", state);
      const name = (await whoami(auth.mindBaseUrl, t.accessToken, auth.fetchImpl)).username;
      if (!mayUse(name)) return fail("notallowed");
      const user = auth.store.upsert(name, { kind: "oauth", accessToken: t.accessToken, refreshToken: t.refreshToken, clientId: t.clientId });
      auth.evict(user.id);
      // App flow: no cookie here (this is the auth sheet, not the WebView). Hand back a one-time code the app exchanges over HTTPS.
      if (appCc) return appReturn(res, { code: appHandoff.mintCode(user.id, appCc) });
      // A 200 page that navigates itself (not a 302): the next request is then same-site, so the Strict session cookie is sent.
      const body = '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>Signed in</title><a href="/">Continue</a>';
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": [userCookie(user.id), `${OAUTH_COOKIE}=; ${oauthCookieAttrs(0)}`, `${OAUTH_APP_COOKIE}=; ${oauthCookieAttrs(0)}`] });
      return void res.end(body);
    } catch {
      limiter.fail(ip);
      return fail("oauth");
    }
  }

  // POST /api/agent/turn: server-to-server (MIND backend). Header-authenticated with the user's own mind_ key, never a cookie,
  // so it sits outside the browser Origin/CSRF rules. It is deliberately STRICTER than them: any Origin header at all is refused
  // (a browser always sends one on a cross-site POST; a server caller sends none), and the Host allowlist + https rules still apply.
  async function agentTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    if (!auth?.store.enabled) return sendJson(res, 404, { error: "agent API is not enabled on this deployment" });
    if (!hostOk(req)) return sendJson(res, 403, { error: "forbidden host" });
    if (req.headers.origin !== undefined) return sendJson(res, 403, { error: "browser origins are not allowed on the agent API" });
    if (headerOne(req, "x-forwarded-proto")?.split(",")[0].trim().toLowerCase() === "http") return sendJson(res, 400, { error: "https required" });
    const ip = clientIp(req);
    const wait = limiter.retryAfter(ip);
    if (wait > 0) {
      res.setHeader("retry-after", String(wait));
      return sendJson(res, 429, { error: "too many attempts; try again later" });
    }
    const key = (headerOne(req, "x-mind-key") ?? "").trim();
    if (!key) return sendJson(res, 401, { error: "X-MIND-Key header required" });
    let name = keyIdentities.get(key);
    if (!name) {
      try {
        name = (await whoami(auth.mindBaseUrl, key, auth.fetchImpl)).username;
      } catch (e) {
        const status = e instanceof MindAuthError ? e.status : 502;
        if (status === 400 || status === 401) limiter.fail(ip);
        return sendJson(res, status === 400 ? 401 : status, { error: e instanceof MindAuthError ? e.message : "could not check that key" });
      }
      keyIdentities.set(key, name);
    }
    if (!mayUse(name)) return sendJson(res, 403, { error: "That MIND account is not enabled for Daebot." });
    const uid = userIdFor(name);
    const retry = turnLimiter.take(uid);
    if (retry > 0) {
      res.setHeader("retry-after", String(retry));
      return sendJson(res, 429, { error: "too many agent turns; slow down" });
    }
    const b = await readJson(req);
    const text = optStr(b.text, 200_000);
    if (!text || !text.trim()) return sendJson(res, 400, { error: "text required" });
    const surface = optStr(b.surface, 40) ?? "mind-chat";
    if (!AGENT_SURFACE_RE.test(surface)) return sendJson(res, 400, { error: "bad surface" });
    const sessionId = optStr(b.sessionId, 200);
    // The user's runtime is built from THEIR key. A browser sign-in (OAuth or key) already stored is kept; a new or rotated key is stored.
    const have = auth.store.creds(uid);
    if (!have || (have.kind === "key" && have.mindKey !== key)) {
      auth.store.upsert(name, { kind: "key", mindKey: key });
      auth.evict(uid);
    }
    const principal = auth.store.principal(uid);
    if (!principal) return sendJson(res, 500, { error: "could not load the user" });
    let ls;
    try {
      ls = await manager.open({ surface, title: optStr(b.title, 200) ?? "MIND chat", resumeId: sessionId || undefined, owner: principal.id });
    } catch (e) {
      if (e instanceof ForbiddenError) throw e;
      return sendJson(res, 502, { error: e instanceof Error ? e.message.slice(0, 300) : "could not open a session" });
    }
    if (ls.busy) return sendJson(res, 409, { error: "session is busy with another turn", sessionId: ls.id });
    return streamTurn(res, ls.id, text, { "x-daebot-session": ls.id }, { type: "session", sessionId: ls.id }, principal);
  }

  // One turn, shared by POST /sessions/:id/send and POST /api/agent/turn. The turn is a server-owned run: it is started here
  // but does NOT belong to this response. If the client goes away (app closed, tab closed, phone locked, another session
  // opened) the run keeps going and is persisted; GET /sessions/:id/events re-attaches. Only POST .../abort stops it.
  function sseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...BASE_HEADERS,
      ...extra,
    };
  }

  /** Streams a run's events to one response from `after` (exclusive); ends when the run ends. Closing the response never stops the run. */
  function attachRun(res: ServerResponse, run: Run, after: number, first?: Record<string, unknown>, withUser = false): void {
    res.write(": open\n\n");
    if (first) res.write(`data: ${JSON.stringify(first)}\n\n`);
    if (withUser && after === 0) res.write(`id: 0\ndata: ${JSON.stringify({ type: "user", text: run.userText })}\n\n`);
    const send = (seq: number, ev: unknown) => { if (!res.writableEnded && !res.destroyed) res.write(`id: ${seq}\ndata: ${JSON.stringify(ev)}\n\n`); };
    let last = after;
    for (const e of run.events) if (e.seq > after) { send(e.seq, e.ev); last = e.seq; }
    if (run.status === "done") return void res.end();
    const hb = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n"); }, 15_000);
    hb.unref();
    const onEv = (e: { seq: number; ev: unknown }) => {
      if (e.seq === -1) return cleanup(true); // run ended
      if (e.seq > last) { last = e.seq; send(e.seq, e.ev); }
    };
    const cleanup = (end: boolean) => {
      clearInterval(hb);
      run.listeners.delete(onEv);
      if (end && !res.writableEnded) res.end();
    };
    run.listeners.add(onEv);
    res.on("close", () => cleanup(false)); // the client left: the run does not
  }

  async function streamTurn(res: ServerResponse, id: string, text: string, extraHeaders: Record<string, string> = {}, first?: Record<string, unknown>, me?: Principal): Promise<void> {
    res.writeHead(200, sseHeaders(extraHeaders));
    const run = runs.start(id, text);
    // The run is detached from this request: it publishes into the run feed, the WebSocket subscribers and (via the runtime) the disk.
    void (async () => {
      try {
        if (me) {
          const note = await enforceModel(me, id).catch(() => undefined);
          if (note) run.publish({ type: "notice", level: "warn", text: note });
        }
        await manager.turn(id, text, (ev) => {
          run.publish(ev);
          broadcast(id, ev);
        });
      } catch (err) {
        const msg = err instanceof BusyError || err instanceof NotFoundError ? err.message : "internal error";
        run.publish({ type: "notice", level: "warn", text: msg });
      } finally {
        run.finish();
      }
    })();
    attachRun(res, run, 0, first);
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
      res.setHeader("x-robots-tag", "noindex, nofollow"); // private bot: never indexed
      if (path === "/robots.txt" && (method === "GET" || method === "HEAD")) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" });
        return void res.end(method === "HEAD" ? undefined : "User-agent: *\nDisallow: /\n");
      }
      if (await handleAppFeed(path, method, res)) return;
      // Platform health probes may not carry our public Host; /health reveals nothing but liveness and which model answers.
      if (path === "/health" && (method === "GET" || method === "HEAD")) return sendJson(res, 200, { ok: true, name: "mindclaw-gateway", hosted: true, build: buildId(), bots: botsOn(), ...mcpField(), ...modelInfo() });
    }

    if (hosted && path === AGENT_TURN_PATH) return agentTurn(req, res);

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

    if (isAdminPath(path)) {
      return void (await handleAdmin({
        get ledger() { return ledger(); },
        get anger() { return anger(); },
        feed: mindFeed,
        logKey: opts.adminLog?.logKey ?? (() => process.env.DAEBOT_MISTAKE_LOG_KEY?.trim() || undefined),
        isAdmin: (r) => (hosted ? principalOf(r)?.tier === "admin" : authorized(r, query, false)),
        signedIn: (r) => authorized(r, query, false),
      }, req, res, path, query));
    }

    if (hosted && !openHook) {
      if (path === "/login") {
        if (method === "POST") return login(req, res);
        if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
      } else if (path === "/auth/methods") {
        if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        return sendJson(res, 200, { owner: true, key: !!auth?.store.enabled, oauth: !!(auth?.store.enabled && auth.oauth) });
      } else if (path === "/auth/key") {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        return keyLogin(req, res);
      } else if (path === "/auth/mind/start") {
        if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        return oauthStart(req, res, query);
      } else if (path === "/auth/app/exchange") {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        return appExchange(req, res);
      } else if (path === "/auth/mind/callback") {
        if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        return oauthCallback(req, res, query);
      } else if (path === "/auth/me") {
        if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const p = principalOf(req);
        if (!p) return sendJson(res, 401, { error: "unauthorized" });
        const me: Record<string, unknown> = { username: p.owner ? "Owner" : p.username, owner: p.owner, tier: p.tier, bots: botsOn(), ...mcpField() };
        // DAEBOT_BILLING=mind: the MIND plan and credits this principal's calls are billed to (`tier` stays Daebot's identity tier,
        // so the MIND plan id is `planTier`). ?fresh=1 (sent after a turn) re-reads
        // unless a response header already refreshed the number moments ago.
        if (auth?.credits) {
          const key = auth.billingKey(p);
          const b = key ? await auth.credits.get(key, false, query.get("fresh") ? 2000 : undefined) : undefined;
          if (b) Object.assign(me, { planTier: b.tier, tierName: b.tierName, creditsRemaining: b.creditsRemaining, creditsLimit: b.creditsLimit, usageLeftPct: usageLeftPct(b), upgradeUrl: b.upgradeUrl });
        }
        return sendJson(res, 200, me);
      } else if (path === "/logout") {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        res.setHeader("set-cookie", `${HOSTED_COOKIE}=; ${cookieAttrs(0)}`);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (path === "/health") {
      if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, { ok: true, name: "mindclaw-gateway", sessions: manager.count(), build: buildId(), bots: botsOn(), ...mcpField(), ...modelInfo() });
    }

    // The MCP server's sign-in page sends the browser back here: a cross-site navigation, so the Strict session cookie is NOT sent.
    // The user is identified by the short-lived Lax cookie set when they pressed Connect on the card.
    if (path === "/mcp/oauth/callback") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      return mcpOauthCallback(req, res, query);
    }

    // ---- API surface: everything below needs the token (except opted-out webhooks)
    const isApi = path === "/sessions" || path.startsWith("/sessions/") || path === "/bots" || path.startsWith("/bots/") || path === "/models" || path.startsWith("/models/") || path.startsWith("/hooks/") || path.startsWith("/voice/") || path.startsWith("/apps/") || path.startsWith("/mcp/") || path === "/ws";
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
    const file = useEmbedded ? null : resolveStatic(staticDir, staticPath);
    if (!file && !useEmbedded) return sendJson(res, 404, { error: "not found" });
    const qt = hosted ? null : query.get("token");
    if ((path === "/" || path === "/index.html") && qt && safeEqual(qt, token)) {
      extra["set-cookie"] = `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
    }
    if (file) return serveFile(file, res, method === "HEAD", extra);
    if (!serveEmbedded(staticPath, res, method === "HEAD", extra, embeddedFiles)) return sendJson(res, 404, { error: "not found" });
  }

  // ---------- connected MCP servers: consent card routes. Cookie-authenticated, same origin rules as everything else.
  // Nothing here is reachable by a model: approving needs the signed-in user's browser session.
  const MCP_COOKIE = "mc_mcpo";
  const mcpMac = (uid: string, state: string): string => createHmac("sha256", token).update(`mcp-oauth:${uid}:${state}`).digest("base64url");
  const mcpCookieAttrs = (maxAge: number): string => `HttpOnly; Secure; SameSite=Lax; Path=/mcp/oauth; Max-Age=${maxAge}`;
  function mcpRedirectUri(req: IncomingMessage): string {
    const pub = (process.env.DAEBOT_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
    if (hosted) return `${pub || `https://${[...allowedHosts][0]}`}/mcp/oauth/callback`;
    return `http://${hostnameOf(String(req.headers.host ?? "127.0.0.1"))}${(/:(\d+)$/.exec(String(req.headers.host ?? "")) ?? [])[0] ?? ""}/mcp/oauth/callback`;
  }
  function mcpFail(res: ServerResponse, e: unknown): void {
    if (e instanceof McpConnectError) return sendJson(res, e.status, { error: e.message });
    throw e;
  }
  const mcpDonePage = (msg: string, ok: boolean): string =>
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/?mcp=${ok ? "connected" : "failed"}"><title>${ok ? "Connected" : "Not connected"}</title><p>${msg}</p><a href="/">Continue</a>`;

  async function mcpOauthCallback(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    if (!mcp || !mcp.enabled()) return sendJson(res, 404, { error: "not found" });
    const state = query.get("state") ?? "";
    const raw = parseCookies(req.headers["cookie"])[MCP_COOKIE] ?? "";
    const parts = raw.split(".");
    const clear = `${MCP_COOKIE}=; ${mcpCookieAttrs(0)}`;
    const page = (msg: string, ok: boolean, status = 200) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": clear }); res.end(mcpDonePage(msg, ok)); };
    // uid.state.mac: must be the browser that pressed Connect, for this very state (blocks login-CSRF / code injection).
    if (parts.length !== 3 || !state || parts[1] !== state || !safeEqual(parts[2], mcpMac(parts[0], state))) return page("That sign-in did not come from this browser. Start again from the card.", false, 400);
    if (query.get("error")) return page("The sign-in was cancelled.", false);
    try {
      await mcp.completeOAuth(parts[0], state, query.get("code") ?? "");
      return page("Connected. Returning to Daebot.", true);
    } catch (e) {
      return page(e instanceof McpConnectError ? e.message.replace(/[<>&"]/g, "") : "The sign-in did not complete.", false);
    }
  }

  async function mcpApi(req: IncomingMessage, res: ServerResponse, path: string, method: string, me: Principal): Promise<void> {
    if (!mcp || !mcpOn()) return sendJson(res, 404, { error: "connecting MCP servers is not enabled on this deployment" });
    try {
      if (path === "/mcp/servers") {
        if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        return sendJson(res, 200, { servers: mcp.list(me.id), pending: mcp.pending(me.id), limits: mcp.limits() });
      }
      // The MIND App Store connectors for the Apps card (MIND's list, fetched server-side). Listing reaches no third party.
      if (path === "/mcp/catalog") {
        if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const items = await mcp.catalogItems(me.id);
        return sendJson(res, 200, { items, counts: { official: items.filter((i) => i.publisher === "official").length, community: items.filter((i) => i.publisher === "community").length } });
      }
      // Connect on a connector: creates the same pending request a model's proposal would. The URL is looked up here by id; the body never carries one.
      if (path === "/mcp/catalog/connect") {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const b = await readJson(req);
        return sendJson(res, 200, { pending: await mcp.proposeFromCatalog(me.id, optStr(b.id, 80) ?? "") });
      }
      let m = /^\/mcp\/pending\/([A-Za-z0-9_-]{1,40})\/(approve|deny)$/.exec(path);
      if (m) {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        if (m[2] === "deny") return sendJson(res, 200, { ok: mcp.deny(me.id, m[1]) });
        const b = await readJson(req);
        const mode = b.mode === "none" || b.mode === "key" || b.mode === "oauth" ? b.mode : undefined;
        const allow = Array.isArray(b.allow) ? b.allow.filter((x): x is string => typeof x === "string").slice(0, 500) : undefined;
        const r = await mcp.approve(me.id, m[1], { mode, apiKey: optStr(b.apiKey, 5000), allow, name: optStr(b.name, 40), redirectUri: mcpRedirectUri(req) });
        if (r.status === "authorize") {
          res.setHeader("set-cookie", `${MCP_COOKIE}=${me.id}.${r.state}.${mcpMac(me.id, r.state)}; ${mcpCookieAttrs(600)}`);
          return sendJson(res, 200, { status: "authorize", url: r.url });
        }
        return sendJson(res, 200, r);
      }
      m = /^\/mcp\/servers\/([A-Za-z0-9_-]{1,40})(?:\/(refresh))?$/.exec(path);
      if (m) {
        if (m[2] === "refresh") {
          if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
          return sendJson(res, 200, { server: await mcp.refreshTools(me.id, m[1]) });
        }
        if (method === "DELETE") return sendJson(res, 200, { ok: mcp.remove(me.id, m[1]) });
        if (method === "PATCH") {
          const b = await readJson(req);
          return sendJson(res, 200, { server: mcp.update(me.id, m[1], { enabled: typeof b.enabled === "boolean" ? b.enabled : undefined, allow: Array.isArray(b.allow) ? (b.allow as unknown[]).filter((x): x is string => typeof x === "string") : undefined }) });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (e) { return mcpFail(res, e); }
  }

  // ---------- bots + models REST (same cookie auth and origin rules as /sessions; one owner's bots are invisible to everyone else) ----------
  const botView = (b: BotRecord) => ({ id: b.id, slug: b.slug, name: b.name, purpose: b.purpose, color: b.color, createdAt: b.createdAt, updatedAt: b.updatedAt, ...versionInfo(b) });

  function botFail(res: ServerResponse, e: unknown): void {
    if (e instanceof BotError) return sendJson(res, e.status, { error: e.code, message: e.message, ...(e.extra ?? {}) });
    throw e;
  }

  async function botsApi(req: IncomingMessage, res: ServerResponse, path: string, method: string, me: Principal): Promise<void> {
    const bots = manager.runtimeOf(me.id).bots;
    if (!botsOn() || !bots) return sendJson(res, 404, { error: "bots are not enabled on this deployment" });
    try {
      if (path === "/bots") {
        if (method === "GET") return sendJson(res, 200, { bots: (await bots.list()).map((b) => ({ ...botView(b), ...manager.botState(me.id, b.id) })) });
        if (method === "POST") {
          const b = await readJson(req);
          // The web UI sends only a name: the slug is derived from it (made unique with a numeric suffix).
          const name = optStr(b.name, 120);
          let slug = optStr(b.slug, 64);
          if (!slug) {
            if (!name || !name.trim()) return sendJson(res, 400, { error: "name_required", message: "name required" });
            const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "bot";
            const taken = new Set((await bots.list()).map((x) => x.slug));
            slug = base;
            for (let i = 2; taken.has(slug) || slug === "main"; i++) slug = `${base}-${i}`;
          }
          const instr = b.instructions === undefined ? undefined : typeof b.instructions === "string" ? b.instructions : null;
          if (instr === null) return sendJson(res, 400, { error: "bad_instructions", message: "instructions must be text" });
          if (instr !== undefined && Buffer.byteLength(instr, "utf8") > 8 * 1024) return sendJson(res, 413, { error: "instructions_too_long", message: "DAEBOT.md is capped at 8 KB" });
          const rec = await bots.create({ slug, name, purpose: optStr(b.purpose, 1000), color: optStr(b.color, 20) });
          if (instr) bots.setInstructions(rec.id, instr);
          return sendJson(res, 201, { bot: { ...botView(rec), live: false, busy: false } });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      const m = /^\/bots\/([^/]+)(?:\/(instructions|update))?$/.exec(path);
      if (!m) return sendJson(res, 404, { error: "not found" });
      let id: string;
      try { id = decodeURIComponent(m[1]); } catch { return sendJson(res, 400, { error: "bad bot id" }); }
      const rec = bots.get(id);
      if (!rec) return sendJson(res, 404, { error: "not_found", message: "no such bot" });
      if (m[2] === "instructions") {
        if (method === "GET") { const t = bots.instructions(id); return sendJson(res, 200, { text: t, instructions: t, updatedAt: rec.updatedAt }); }
        if (method === "PUT") {
          const b = await readJson(req);
          const t = typeof b.text === "string" ? b.text : b.instructions;
          if (typeof t !== "string") return sendJson(res, 400, { error: "bad_instructions", message: "text must be a string" });
          bots.setInstructions(id, t); // counted in UTF-8 bytes (8 KB)
          return sendJson(res, 200, { ok: true, updatedAt: bots.get(id)?.updatedAt ?? Date.now() });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      }
      if (m[2] === "update") {
        if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const from = versionInfo(rec).version;
        const up = bots.upgrade(id); // DAEBOT.md, threads and the bot's MIND are untouched
        return sendJson(res, 200, { ok: true, from, bot: botView(up) });
      }
      if (method === "PATCH") {
        const b = await readJson(req);
        return sendJson(res, 200, { bot: botView(bots.update(id, { name: optStr(b.name, 120), purpose: optStr(b.purpose, 1000), color: optStr(b.color, 20) })) });
      }
      if (method === "DELETE") {
        await bots.remove(id);
        await manager.closeBotSessions(me.id, id);
        await manager.runtimeOf(me.id).purgeBotSessions?.(id); // saved threads (and DM threads with it as peer or recipient) go too
        return sendJson(res, 200, { ok: true });
      }
      if (method === "GET") return sendJson(res, 200, { bot: botView(rec) });
      return sendJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      return botFail(res, e);
    }
  }

  /**
   * The plan can change after a model was chosen (a downgrade, a resumed old session, a stored default). Before a turn and when a
   * session resumes, re-run the catalog check on the session's model and on the user default; a model that is no longer allowed is
   * replaced by the free model. Returns the notice to show, if any.
   */
  async function enforceModel(me: Principal, id: string): Promise<string | undefined> {
    const free = opts.cfg?.freeModel;
    if (!opts.cfg || !free) return undefined;
    const rt = manager.runtimeOf(me.id);
    let notice: string | undefined;
    const dflt = rt.settings?.get().defaultModel;
    if (dflt && (await modelProblem(me, dflt))?.status === 402) {
      rt.settings?.set({ defaultModel: null });
      notice = `Your default model (${dflt}) is not on your plan. Using the free model.`;
    }
    const cur = rt.sessionInfo?.(id)?.model;
    if (cur && cur !== free && (await modelProblem(me, cur))?.status === 402) {
      manager.setModel(id, free);
      notice = `The model for this chat (${cur}) is not on your plan. Switched to the free model.`;
    } else if (!cur && notice) manager.setModel(id, free);
    return notice;
  }

  function billingKeyOf(p: Principal): string | undefined {
    return auth ? auth.billingKey(p) : opts.cfg?.mindApiKey || undefined;
  }

  async function planOf(p: Principal): Promise<{ free: boolean; upgradeUrl?: string }> {
    const key = billingKeyOf(p);
    if (!auth?.credits || !key) return { free: false };
    try {
      const b = await auth.credits.get(key, false);
      return { free: b?.tier === FREE_TIER, upgradeUrl: b?.upgradeUrl };
    } catch {
      return { free: false };
    }
  }

  /** undefined = the model may be used; else the status + body to answer with (free plan: only free models). */
  async function modelProblem(p: Principal, model: string): Promise<{ status: number; body: Record<string, unknown> } | undefined> {
    if (!validModelId(model)) return { status: 400, body: { error: "bad_model", message: "that is not a valid model id" } };
    if (!opts.cfg) return undefined;
    const plan = await planOf(p);
    const cat = await catalog.list(billingKeyOf(p), plan.free);
    const row = cat.models.find((m) => m.id === model);
    if (!row) return { status: 400, body: { error: "unknown_model", message: "that model is not in your model list (GET /models)" } };
    if (!row.allowed) return { status: 402, body: { error: "model_not_in_plan", message: "That model is not on the free plan. Pick a free model or upgrade.", ...(safeUpgradeUrl(plan.upgradeUrl) ? { upgradeUrl: safeUpgradeUrl(plan.upgradeUrl), upgrade_url: safeUpgradeUrl(plan.upgradeUrl) } : {}) } };
    return undefined;
  }

  async function modelsApi(req: IncomingMessage, res: ServerResponse, path: string, method: string, me: Principal): Promise<void> {
    if (!opts.cfg) return sendJson(res, 404, { error: "models are not available here" });
    const settings = manager.runtimeOf(me.id).settings;
    if (path === "/models") {
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const plan = await planOf(me);
      const cat = await catalog.list(billingKeyOf(me), plan.free);
      return sendJson(res, 200, {
        models: cat.models, source: cat.source, plan: auth?.credits ? (plan.free ? "free" : "paid") : null,
        default: settings?.get().defaultModel ?? opts.cfg.models.default, freeModel: opts.cfg.freeModel ?? null,
      });
    }
    if (path === "/models/default") {
      if (method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
      if (!settings) return sendJson(res, 404, { error: "settings are not enabled on this deployment" });
      const b = await readJson(req);
      const model = b.model === null ? null : optStr(b.model, 130);
      if (model === undefined) return sendJson(res, 400, { error: "model required (or null to clear)" });
      if (model) { const bad = await modelProblem(me, model); if (bad) return sendJson(res, bad.status, bad.body); }
      settings.set({ defaultModel: model });
      return sendJson(res, 200, { ok: true, default: model ?? opts.cfg.models.default });
    }
    return sendJson(res, 404, { error: "not found" });
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

    const me = who(req);
    if (path.startsWith("/voice/")) return voice ? voice(req, res, path, _query, me) : sendJson(res, 404, { error: "voice is not available" });
    if (path.startsWith("/apps/")) return apps ? apps(req, res, path, me) : sendJson(res, 404, { error: "apps are not available" });
    if (path === "/bots" || path.startsWith("/bots/")) return botsApi(req, res, path, method, me);
    if (path.startsWith("/mcp/")) return mcpApi(req, res, path, method, me);
    if (path === "/models" || path.startsWith("/models/")) return modelsApi(req, res, path, method, me);
    if (path === "/sessions") {
      if (method === "GET") return sendJson(res, 200, { sessions: manager.list(me.id, { bot: optStr(_query.get("bot") ?? undefined, 80) || undefined }) });
      if (method === "POST") {
        const b = await readJson(req);
        const model = optStr(b.model, 130);
        if (model) { const bad = await modelProblem(me, model); if (bad) return sendJson(res, bad.status, bad.body); }
        if (b.bot && !botsOn()) return sendJson(res, 404, { error: "bots are not enabled on this deployment" });
        let ls;
        try {
          ls = await manager.open({
            surface: optStr(b.surface, 40) ?? "web",
            title: optStr(b.title, 200),
            resumeId: optStr(b.resumeId, 200),
            owner: me.id,
            bot: optStr(b.bot, 40),
            model: model || undefined,
          });
        } catch (e) {
          if (e instanceof Error && (e.message === "no such bot" || e.message === "bots are not enabled")) return sendJson(res, 404, { error: "no such bot" });
          if (e instanceof Error && e.message === "session belongs to a different bot") return sendJson(res, 409, { error: e.message });
          throw e;
        }
        const notice = b.resumeId ? await enforceModel(me, ls.id).catch(() => undefined) : undefined;
        return sendJson(res, 200, { sessionId: ls.id, ...(notice ? { notice } : {}) });
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
    const acc = manager.access(id, me.id);
    if (acc === "forbidden") return sendJson(res, 403, { error: "forbidden" });
    const ls = acc;

    if (action === "history") {
      // The visible transcript, from the live session or from disk after a restart (no live session needed).
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const events = manager.runtimeOf(me.id).history?.(id);
      if (!events) return sendJson(res, 404, { error: "no such session" });
      // A turn still running on the server: hand back the transcript up to (not including) that turn plus a pointer to it,
      // so the client rebuilds the running turn from GET .../events (replay + live) and nothing is drawn twice.
      const run = runs.active(id);
      if (run) {
        let cut = events.length;
        for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "user") { cut = i; break; }
        return sendJson(res, 200, { events: events.slice(0, cut), run: { id: run.id, status: "running", startedAt: run.startedAt } });
      }
      return sendJson(res, 200, { events });
    }
    if (action === "events") {
      // Re-attach to the latest run of this session: replays what the client missed (?after=<seq>, or Last-Event-ID) and streams the rest.
      if (method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const run = runs.get(id);
      if (!run || !ls) return sendJson(res, 404, { error: "no run" });
      const after = Math.max(0, Number(_query.get("after") ?? headerOne(req, "last-event-id") ?? 0) || 0);
      res.writeHead(200, sseHeaders());
      return attachRun(res, run, after, undefined, true);
    }

    if (!action && method === "PATCH") {
      // Change the model of a session (its next turn onward). A persisted session is brought back to life first.
      const b = await readJson(req);
      const model = b.model === null ? null : optStr(b.model, 130);
      if (model === undefined) return sendJson(res, 400, { error: "model required (or null for the default)" });
      if (model) { const bad = await modelProblem(me, model); if (bad) return sendJson(res, bad.status === 402 ? 403 : bad.status, bad.body); }
      let target = ls;
      if (!target) {
        if (!manager.runtimeOf(me.id).history?.(id)) return sendJson(res, 404, { error: "no such session" });
        try { target = await manager.open({ surface: "web", resumeId: id, owner: me.id }); } catch (e) { if (e instanceof ForbiddenError) throw e; return sendJson(res, 404, { error: "no such session" }); }
      }
      return sendJson(res, manager.setModel(id, model || undefined) ? 200 : 409, { ok: true, model: model || null });
    }

    if (!action) {
      if (method !== "DELETE") return sendJson(res, 405, { error: "method not allowed" });
      if (_query.get("purge") === "1") {
        // Delete for good: the live session (if any) closes, its saved transcript is removed. Ownership was checked above (403 for another owner's id).
        const gone = await manager.deleteSession(id, me.id);
        subscribers.delete(id);
        return gone ? sendJson(res, 200, { ok: true, deleted: true }) : sendJson(res, 404, { error: "no such session" });
      }
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

    return streamTurn(res, id, text, {}, undefined, me);
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
    wsWho.set(conn, hosted ? principalOf(req) ?? OWNER : OWNER);
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
    const me = wsWho.get(c) ?? OWNER;
    try {
      switch (f.t) {
        case "open": {
          const ls = await manager.open({
            surface: typeof f.surface === "string" ? f.surface.slice(0, 40) : "web",
            title: typeof f.title === "string" ? f.title.slice(0, 200) : undefined,
            resumeId: typeof f.resumeId === "string" ? f.resumeId : undefined,
            owner: me.id,
          });
          subscribe(ls.id, c);
          return sendFrame(c, { t: "opened", sessionId: ls.id });
        }
        case "send": {
          if (typeof f.sessionId !== "string" || typeof f.text !== "string" || !f.text.trim()) {
            return sendFrame(c, { t: "error", message: "send needs sessionId and text" });
          }
          const ls = manager.access(f.sessionId, me.id);
          if (ls === "forbidden") return sendFrame(c, { t: "error", message: "forbidden" });
          if (!ls) return sendFrame(c, { t: "error", message: "no such session" });
          if (ls.busy) return sendFrame(c, { t: "error", message: "session is busy with another turn" });
          subscribe(ls.id, c);
          await manager.turn(ls.id, f.text, (ev) => broadcast(ls.id, ev));
          return;
        }
        case "abort": {
          if (manager.access(String(f.sessionId), me.id) === "forbidden") return sendFrame(c, { t: "error", message: "forbidden" });
          manager.abort(String(f.sessionId));
          return;
        }
        case "close": {
          if (manager.access(String(f.sessionId), me.id) === "forbidden") return sendFrame(c, { t: "error", message: "forbidden" });
          await manager.close(String(f.sessionId));
          subscribers.delete(String(f.sessionId));
          return;
        }
        default:
          return sendFrame(c, { t: "error", message: "unknown frame type" });
      }
    } catch (err) {
      sendFrame(c, { t: "error", message: err instanceof ForbiddenError ? "forbidden" : err instanceof Error ? err.message.slice(0, 300) : "error" });
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof ForbiddenError) return sendJson(res, 403, { error: "forbidden" });
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
      mindFeed?.stop();
      for (const c of wsConns) c.close(1001, "server shutting down");
      await manager.closeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
