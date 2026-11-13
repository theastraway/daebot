// A fake MIND server for sign-in tests: /developer/v1/profile, the MCP OAuth surface (register, authorize with
// PKCE, token with code + refresh, discovery) and a request log. Localhost only; all keys are throwaway.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen { method: string; path: string; key: string; body: any; bot?: string }

export interface FakeAgentSession { id: string; user: string; source_key: string; external_session_id: string; title: string; status: string; summary?: string; messages: { role: string; content: string; client_message_id?: string }[] }

export interface FakeMind {
  /** Focused-context harness: per-section text for /context (a request for sections returns only those it asked for), and /query answers. */
  contextText?: Record<string, string>;
  queryAnswer?: (q: string) => string;
  /** Agent Sessions (open is idempotent per user + source_key + external_session_id; append/close keep what they were given) */
  agentSessions: Map<string, FakeAgentSession>;
  /** Agent Session shares (MIND agent_session_shares): who each session is shared with, and as what */
  sessionShares: { id: string; session_id: string; owner: string; grantee: string; role: string }[];
  /** keys that lack chat:read/chat:write (agent-sessions answers 403 for them) until an admin key upgrades them via POST /agent-sessions/daebot-scopes */
  chatScopeless: Set<string>;
  /** admin API keys (may call /agent-sessions/daebot-scopes) */
  adminKeys: Set<string>;
  url: string;            // origin
  base: string;           // /developer/v1
  seen: Seen[];
  /** username by API key (mutable: tests add/revoke) */
  keys: Map<string, string>;
  registered: { client_id: string; redirect_uris: string[] }[];
  /** who is "logged in" on the consent screen when /authorize is hit */
  consentUser: string;
  codes: Map<string, { challenge: string; username: string; client: string; redirect: string }>;
  refreshTokens: Map<string, { username: string; key: string; client: string }>;
  lastVerifier?: string;
  /** audio endpoints: force an HTTP status (e.g. 402 / 404) for the next calls; undefined = succeed */
  audioStatus?: number;
  /** bots by username -> slug -> record (POST/GET/DELETE /developer/v1/bots) */
  bots: Map<string, Map<string, { slug: string; label: string; workspace_id: string; created_at: string }>>;
  /** max bots per user before POST /bots answers 402 bot_limit (default: unlimited) */
  botLimit?: number;
  /** when true GET /bots answers 503 (MIND down) */
  botsDown?: boolean;
  /** GET /profile/models (MIND's model list); undefined = the route answers the generic {ok:true} */
  models?: { id: string; name: string; tier?: string }[];
  /** MIND integrations by username -> provider -> connected account label (GET/POST /developer/v1/integrations) */
  integrations: Map<string, Map<string, string>>;
  /** when set, /integrations answers this HTTP status */
  integrationsStatus?: number;
  /** when set, /referral answers this HTTP status */
  referralStatus?: number;
  /** GET/PUT /developer/v1/usage, per username: plan, percent used, switch state. A user missing here answers a free plan at 2% used. */
  spendCaps?: Map<string, { account: unknown; bots: Record<string, unknown> }>;
  usage: Map<string, { plan: string; percentUsed: number; unlimited?: boolean; resetAt?: string; available: boolean; enabled: boolean; automatic?: boolean; rateNote?: string; putStatus?: number }>;
  /** LIFE board, Focuses and documents per username (GET/POST/PATCH/DELETE /life/items, /focuses, /documents). */
  life: Map<string, { focuses: Map<string, any>; items: Map<string, any>; docs: Map<string, any> }>;
  /** when set, /life/*, /focuses and /documents answer this HTTP status */
  lifeStatus?: number;
  /** multi-MIND accounts: grants by grantee username -> MINDs they hold (GET /developer/v1/accounts, POST /accounts/switch, POST /developer/keys). undefined = the routes answer 404 (feature off) */
  grants?: Map<string, { username: string; role: "owner" | "viewer"; label?: string }[]>;
  /** every key minted through /developer/keys with a switch token: [tenant, actor] */
  minted: { key: string; tenant: string; actor: string }[];
  newKey(username: string): string;
  close(): Promise<void>;
}

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => { let b = ""; req.setEncoding("utf8"); req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });

const json = (res: ServerResponse, status: number, v: unknown, extra: Record<string, string> = {}) => {
  const d = JSON.stringify(v);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(d)), ...extra });
  res.end(d);
};

export async function startFakeMind(initial: Record<string, string> = {}): Promise<FakeMind> {
  const m: FakeMind = {
    url: "", base: "", seen: [], keys: new Map(Object.entries(initial)), registered: [], consentUser: "", codes: new Map(), refreshTokens: new Map(),
    minted: [], agentSessions: new Map(), sessionShares: [], chatScopeless: new Set(), adminKeys: new Set(), bots: new Map(), integrations: new Map(), usage: new Map(), life: new Map(),
    newKey(username) { const k = "mind_" + randomBytes(24).toString("base64url"); m.keys.set(k, username); return k; },
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const raw = await body(req);
    const key = String(req.headers["x-api-key"] ?? "");
    let parsed: any = raw;
    try { parsed = raw && String(req.headers["content-type"]).includes("json") ? JSON.parse(raw) : raw; } catch { /* keep raw */ }
    const botHdr = req.headers["x-mind-bot"] ? String(req.headers["x-mind-bot"]) : undefined;
    m.seen.push({ method: req.method ?? "GET", path: u.pathname, key, body: parsed, ...(botHdr ? { bot: botHdr } : {}) });

    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: m.url, authorization_endpoint: `${m.url}/oauth/mcp/authorize`, token_endpoint: `${m.url}/oauth/mcp/token`,
        registration_endpoint: `${m.url}/oauth/mcp/register`, code_challenge_methods_supported: ["S256"],
      });
    }
    if (u.pathname === "/oauth/mcp/register" && req.method === "POST") {
      const client_id = "mcp_client_" + randomBytes(6).toString("hex");
      m.registered.push({ client_id, redirect_uris: parsed.redirect_uris });
      return json(res, 201, { client_id, redirect_uris: parsed.redirect_uris, token_endpoint_auth_method: "none" });
    }
    if (u.pathname === "/oauth/mcp/authorize") {
      const q = u.searchParams;
      const client = m.registered.find((c) => c.client_id === q.get("client_id"));
      if (!client || !client.redirect_uris.includes(q.get("redirect_uri") ?? "")) return json(res, 400, { detail: "bad client or redirect" });
      if (!q.get("code_challenge") || q.get("code_challenge_method") !== "S256") return json(res, 400, { detail: "PKCE required" });
      const code = randomBytes(12).toString("hex");
      m.codes.set(code, { challenge: q.get("code_challenge")!, username: m.consentUser, client: client.client_id, redirect: q.get("redirect_uri")! });
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("code", code);
      if (q.get("state")) back.searchParams.set("state", q.get("state")!);
      res.writeHead(302, { location: back.toString() });
      return void res.end();
    }
    if (u.pathname === "/oauth/mcp/token" && req.method === "POST") {
      const f = new URLSearchParams(raw);
      const issue = (username: string, client: string) => {
        const access = m.newKey(username);
        const refresh = "mind_rt_" + randomBytes(18).toString("base64url");
        m.refreshTokens.set(refresh, { username, key: access, client });
        return json(res, 200, { access_token: access, token_type: "Bearer", scope: "mind:full", refresh_token: refresh });
      };
      if (f.get("grant_type") === "authorization_code") {
        const c = m.codes.get(f.get("code") ?? "");
        m.codes.delete(f.get("code") ?? "");
        const verifier = f.get("code_verifier") ?? "";
        m.lastVerifier = verifier;
        if (!c || createHash("sha256").update(verifier, "ascii").digest("base64url") !== c.challenge) return json(res, 400, { error: "invalid_grant" });
        if (f.get("redirect_uri") !== c.redirect) return json(res, 400, { error: "invalid_grant" });
        return issue(c.username, c.client);
      }
      if (f.get("grant_type") === "refresh_token") {
        const rt = m.refreshTokens.get(f.get("refresh_token") ?? "");
        if (!rt) return json(res, 400, { error: "invalid_grant" });
        m.refreshTokens.delete(f.get("refresh_token")!);
        m.keys.delete(rt.key); // rotation revokes the old key
        return issue(rt.username, rt.client);
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (u.pathname === "/developer/v1/agent-sessions/daebot-scopes" && req.method === "POST") {
      if (!m.adminKeys.has(key)) return json(res, 403, { detail: "Admin API key required." });
      const target = String(parsed?.key ?? "");
      if (!m.keys.has(target)) return json(res, 404, { detail: "no active key matches" });
      const had = m.chatScopeless.delete(target);
      return json(res, 200, { ok: true, added: had ? ["chat:read", "chat:write"] : [] });
    }
    if (u.pathname === "/developer/keys" && req.method === "POST") {
      const jwt = String(req.headers["authorization"] ?? "").replace(/^Bearer /, "");
      const [pre, tenant, actor] = jwt.split("|");
      if (pre !== "fakejwt" || !tenant) return json(res, 401, { detail: "Not authenticated" });
      const k = m.newKey(tenant);
      m.minted.push({ key: k, tenant, actor });
      return json(res, 200, { id: "k_" + m.minted.length, name: parsed?.name, key: k, prefix: k.slice(0, 12), scopes: [], created_at: new Date().toISOString() });
    }
    if (u.pathname.startsWith("/developer/v1/")) {
      const username = m.keys.get(key);
      if (!username) return json(res, 401, { detail: "Invalid or revoked API key." });
      const rest = u.pathname.slice("/developer/v1".length);
      // ---- LIFE board, Focuses, documents (a minimal copy of MIND's developer API: per user, in memory)
      if (rest.startsWith("/life/items") || rest.startsWith("/focuses") || rest.startsWith("/documents")) {
        if (m.lifeStatus) return json(res, m.lifeStatus, { detail: "life is down" });
        const L = m.life.get(username) ?? m.life.set(username, { focuses: new Map(), items: new Map(), docs: new Map() }).get(username)!;
        const id = rest.split("/")[rest.startsWith("/life/items") ? 3 : 2];
        const now = new Date().toISOString();
        if (rest === "/focuses" && req.method === "GET") return json(res, 200, { focuses: [...L.focuses.values()], unfiled_project_count: 0 });
        if (rest === "/focuses" && req.method === "POST") { const f = { focus_id: randomBytes(8).toString("hex"), name: String(parsed?.name ?? ""), created_at: now }; L.focuses.set(f.focus_id, f); return json(res, 201, f); }
        if (rest === "/life/items" && req.method === "GET") {
          let items = [...L.items.values()];
          for (const k of ["item_type", "parent_id", "status"]) if (u.searchParams.get(k)) items = items.filter((i) => i[k] === u.searchParams.get(k));
          if (u.searchParams.get("include_completed") === "false") items = items.filter((i) => !i.is_completed);
          return json(res, 200, { items, total: items.length });
        }
        if (rest === "/life/items" && req.method === "POST") {
          const it = { item_id: randomBytes(8).toString("hex"), title: String(parsed?.title ?? ""), description: parsed?.description ?? "", status: parsed?.status ?? "thought", tags: parsed?.tags ?? [], item_type: parsed?.item_type ?? "outcome", parent_id: parsed?.parent_id ?? null, focus_id: parsed?.focus_id ?? null, is_completed: false, created_at: now, updated_at: now };
          L.items.set(it.item_id, it);
          return json(res, 201, it);
        }
        if (rest.startsWith("/life/items/") && req.method === "PATCH") {
          const it = L.items.get(id); if (!it) return json(res, 404, { detail: "Life item not found" });
          Object.assign(it, parsed, { item_id: id, updated_at: now, is_completed: (parsed?.status ?? it.status) === "completed" });
          return json(res, 200, it);
        }
        if (rest.startsWith("/life/items/") && req.method === "DELETE") { if (!L.items.delete(id)) return json(res, 404, { detail: "Life item not found" }); return json(res, 200, { status: "deleted" }); }
        if (rest === "/documents" && req.method === "POST") { const d = { id: randomBytes(8).toString("hex"), title: String(parsed?.title ?? ""), content: String(parsed?.content ?? ""), tags: parsed?.tags ?? [] }; L.docs.set(d.id, d); return json(res, 200, { id: d.id, title: d.title, status: "PROCESSING" }); }
        if (rest.startsWith("/documents/") && req.method === "GET") { const d = L.docs.get(id); if (!d) return json(res, 404, { detail: "Document not found" }); return json(res, 200, { id: d.id, title: d.title, tags: d.tags, ...(u.searchParams.get("include_content") === "true" ? { content: d.content } : {}) }); }
        if (rest.startsWith("/documents/") && req.method === "DELETE") { L.docs.delete(id); return json(res, 200, { status: "deleted" }); }
      }
      // ---- bots admin API (main key only)
      if (rest === "/bots" || rest.startsWith("/bots/")) {
        const mine = m.bots.get(username) ?? m.bots.set(username, new Map()).get(username)!;
        if (rest === "/bots" && req.method === "GET") return m.botsDown ? json(res, 503, { detail: "down" }) : json(res, 200, { bots: [...mine.values()] });
        if (rest === "/bots" && req.method === "POST") {
          const slug = String(parsed?.slug ?? "");
          if (mine.has(slug)) return json(res, 409, { detail: "duplicate" });
          if (m.botLimit !== undefined && mine.size >= m.botLimit) return json(res, 402, { error: "bot_limit", limit: m.botLimit, tier: "free", upgrade_url: "https://m-i-n-d.ai/#/billing" });
          const rec = { slug, label: String(parsed?.label ?? slug), workspace_id: `ws_${username}_${slug}`, created_at: new Date().toISOString() };
          mine.set(slug, rec);
          return json(res, 200, rec);
        }
        if (rest.startsWith("/bots/") && req.method === "DELETE") {
          const slug = decodeURIComponent(rest.slice(6));
          if (!mine.delete(slug)) return json(res, 404, { detail: "no such bot" });
          return json(res, 200, { ok: true });
        }
        return json(res, 405, { detail: "method" });
      }
      // ---- X-MIND-Bot: only these routes work on a bot's MIND
      if (botHdr) {
        const mine = m.bots.get(username);
        if (!mine?.has(botHdr)) return json(res, 404, { error: "bot_not_found" });
        if (!/^\/(query|context|documents|entries|graph|profile)(\/|$)/.test(rest)) return json(res, 400, { error: "bot_unsupported" });
        if (rest === "/context") return json(res, 200, { sections: [{ section: "soul", items: [{ text: `MIND of ${username} / bot ${botHdr}` }] }] });
        if (rest === "/query") return json(res, 200, { response: `bot ${botHdr} of ${username} says hello` });
        return json(res, 200, { ok: true, bot: botHdr });
      }
      if (rest === "/usage" || rest === "/usage/additional") {
        const u = m.usage.get(username) ?? m.usage.set(username, { plan: "free", percentUsed: 2, available: false, enabled: false }).get(username)!;
        if (rest === "/usage/additional") {
          if (req.method !== "PUT") return json(res, 405, { detail: "method" });
          if (u.putStatus) return json(res, u.putStatus, { detail: "x" });
          if (!u.available) return json(res, 403, { detail: "paid plans only" });
          u.enabled = parsed?.enabled === true;
        } else if (req.method !== "GET") return json(res, 405, { detail: "method" });
        return json(res, 200, {
          plan: u.plan, unlimited: !!u.unlimited, percent_used: u.percentUsed, percent_left: Math.max(0, 100 - u.percentUsed), reset_at: u.resetAt ?? "2026-11-01T00:00:00+00:00",
          credits_balance: 123, credits_limit: 400,
          additional_usage: { available: u.available, eligible: u.available, enabled: u.enabled, active: u.enabled && u.available, automatic: !!u.automatic, rate_note: u.available ? u.rateNote ?? null : null, overflow_usd: 0 },
        });
      }
      if (rest === "/llm/spend-caps") {
        const c = (m.spendCaps ??= new Map()).get(username) ?? { account: null, bots: {} as Record<string, unknown> };
        m.spendCaps.set(username, c);
        if (req.method === "PUT") {
          if (parsed && "account" in parsed) c.account = parsed.account as never;
          for (const [id, v] of Object.entries((parsed?.bots ?? {}) as Record<string, unknown>)) { if (v === null) delete c.bots[id]; else c.bots[id] = v; }
        }
        const view = (cap: any) => ({ cap, period: cap?.period ?? "monthly", spent_usd: 0.02, remaining_usd: cap ? Math.max(0, cap.usd - 0.02) : null, pct: cap ? 0.02 / cap.usd * 100 : null, reached: !!cap && 0.02 >= cap.usd, alert: !!cap && 0.02 >= cap.usd, period_start: "2026-11-11T05:00:00+00:00", resets_at: "2026-11-12T05:00:00+00:00" });
        const bots: Record<string, unknown> = {};
        for (const [id, v] of Object.entries(c.bots)) bots[id] = view(v);
        const q = new URL(req.url ?? "", "http://x").searchParams.get("bot");
        if (q && !bots[q]) bots[q] = view(null);
        return json(res, 200, { account: view(c.account), bots, alert: false, reached: false });
      }
      if (rest === "/referral") {
        if (m.referralStatus) return json(res, m.referralStatus, { detail: "x" });
        return json(res, 200, { code: "REF" + username.toUpperCase(), url: `https://m-i-n-d.ai/register?ref=REF${username.toUpperCase()}`, referrer_credits: 100, referee_credits: 50 });
      }
      if (rest === "/integrations" || rest.startsWith("/integrations/")) {
        if (m.integrationsStatus) return json(res, m.integrationsStatus, { detail: "x" });
        const mine = m.integrations.get(username) ?? m.integrations.set(username, new Map()).get(username)!;
        if (rest === "/integrations") {
          const P = [["google", "Google", "oauth", true], ["microsoft", "Microsoft 365", "oauth", true], ["apple", "Apple Calendar", "credentials", true], ["dropbox", "Dropbox", "oauth", true], ["github", "GitHub", "oauth", false]] as const;
          return json(res, 200, { integrations_enabled: true, providers: P.map(([provider, display_name, auth, configured]) => ({ provider, display_name, blurb: `Sync ${display_name}.`, auth, configured, connected: mine.has(provider), status: mine.has(provider) ? "connected" : null, account_label: mine.get(provider) ?? null, needs_reauth: false, reconnect_required: false, secret_field: "must-not-leak" })) });
        }
        const [, , prov, act] = rest.split("/");
        if (act === "connect") return prov === "apple" ? json(res, 200, { auth_type: "credentials" }) : json(res, 200, { auth_type: "oauth", auth_url: `https://accounts.example.test/${prov}?state=${username}.${encodeURIComponent(String(parsed?.return_to ?? ""))}` });
        if (act === "disconnect") { mine.delete(prov); return json(res, 200, { status: "disconnected" }); }
      }
      if (rest === "/audio/transcriptions" || rest === "/audio/speech") {
        if (m.audioStatus) return json(res, m.audioStatus, m.audioStatus === 402 ? { error: "insufficient_credits", message: "Not enough MIND credits for voice.", upgrade_url: "https://m-i-n-d.ai/#/billing" } : { detail: "x" });
        if (rest === "/audio/transcriptions") return json(res, 200, { text: `hello from ${username}`, duration: 2.5, credits_used: 0.01 }, { "x-mind-credits-used": "0.01" });
        res.writeHead(200, { "content-type": "audio/mpeg", "x-mind-credits-used": "0.25" });
        return void res.end(Buffer.from("ID3fakemp3"));
      }
      if (rest === "/accounts" || rest === "/accounts/switch") {
        if (!m.grants) return json(res, 404, { detail: "Not Found" });
        const mine = [{ username, role: "owner" as const, label: username }, ...(m.grants.get(username) ?? [])];
        if (rest === "/accounts") return json(res, 200, { enabled: true, actor: username, accounts: mine.map((g, i) => ({ username: g.username, label: g.label ?? g.username, role: g.role, is_self: i === 0, is_active: i === 0 })) });
        const want = String(parsed?.username ?? "");
        if (!mine.some((g) => g.username === want)) return json(res, 403, { detail: "You do not have access to that MIND." });
        return json(res, 200, { access_token: `fakejwt|${want}|${username}`, token_type: "bearer", account: { username: want, role: mine.find((g) => g.username === want)!.role, is_self: want === username } });
      }
      if (rest === "/profile") return json(res, 200, { username, bio: "" });
      if (rest === "/profile/models" && m.models) return json(res, 200, { models: m.models, current: m.models[0]?.id });
      if (rest === "/context" && m.contextText) {
        const want: string[] = Array.isArray(parsed?.sections) && parsed.sections.length ? parsed.sections : ["soul", "user", "rules", "priorities", "recent"];
        return json(res, 200, { sections: want.filter((w) => m.contextText![w]).map((w) => ({ section: w, items: [{ text: m.contextText![w] }] })) });
      }
      if (rest === "/query" && m.queryAnswer) return json(res, 200, { response: m.queryAnswer(String(parsed?.query ?? "")) });
      if (rest === "/context") return json(res, 200, { sections: [{ section: "soul", items: [{ text: `MIND of ${username}` }] }] });
      if (rest.startsWith("/agent-sessions/") && m.chatScopeless.has(key)) return json(res, 403, { detail: "API key lacks required scope: chat:write" });
      if (rest === "/agent-sessions/open") {
        const k = `${username}|${parsed?.source_key}|${parsed?.external_session_id}`;
        const had = m.agentSessions.get(k);
        const row = had ?? { id: `as_${m.agentSessions.size + 1}_${username}`, user: username, source_key: String(parsed?.source_key), external_session_id: String(parsed?.external_session_id), title: String(parsed?.title ?? ""), status: "active", messages: [] };
        m.agentSessions.set(k, row);
        return json(res, 200, { session_id: row.id, resumed: !!had, message_count: row.messages.length, pending_replies: [] });
      }
      if ((rest === "/agent-sessions" || rest === "/agent-sessions/") && req.method === "GET") {
        const shared = new Set(m.sessionShares.filter((x) => x.grantee === username).map((x) => x.session_id));
        const rows = [...m.agentSessions.values()].filter((r) => (r.user === username && !u.searchParams.get("shared_only")) || shared.has(r.id)).map((r) => {
          const g = m.sessionShares.find((x) => x.session_id === r.id && x.grantee === username);
          return { session_id: r.id, user_id: r.user, source_key: r.source_key.startsWith("daebot") ? "mindclaw@unknown" : r.source_key, runtime: r.source_key.startsWith("daebot") ? "mindclaw" : "other", agent_key: r.source_key.startsWith("daebot") ? "mindclaw" : "other", external_session_id: r.external_session_id, title: r.title, status: r.status, last_activity_at: "2026-11-12T00:00:00Z",
            shared: g ? { shared_with_me: true, shared_by: r.user, owner: r.user, owner_label: r.user, role: g.role, unread: 0, muted: false, shared_at: "2026-11-12T00:00:00Z" } : { shared_with_me: false } };
        });
        return json(res, 200, { sessions: rows.slice(0, Number(u.searchParams.get("limit") ?? 30)), sources: [] });
      }
      if (rest === "/agent-sessions/share-targets" && req.method === "GET") {
        const q = (u.searchParams.get("q") ?? "").toLowerCase();
        return json(res, 200, { users: [...new Set(m.keys.values())].filter((n) => n !== username && n.toLowerCase().startsWith(q)).map((n) => ({ username: n, label: n.toUpperCase(), avatar_url: null })) });
      }
      const ash = /^\/agent-sessions\/([^/]+)\/shares(?:\/([^/]+))?$/.exec(rest);
      if (ash) {
        const row = [...m.agentSessions.values()].find((r) => r.id === ash[1] && r.user === username);
        if (!row) return json(res, 404, { detail: "Agent session not found" });
        if (req.method === "GET") return json(res, 200, { session_id: row.id, shares: m.sessionShares.filter((x) => x.session_id === row.id).map((x) => ({ id: x.id, session_id: x.session_id, grantee_username: x.grantee, grantee_label: x.grantee.toUpperCase(), role: x.role, shared_at: "2026-11-12T00:00:00Z" })) });
        if (req.method === "POST") {
          const who = String(parsed?.grantee_username ?? "");
          if (![...m.keys.values()].includes(who)) return json(res, 404, { detail: `No MIND account named '${who}'.` });
          if (who === username) return json(res, 400, { detail: "You can't share a session with yourself." });
          const had = m.sessionShares.find((x) => x.session_id === row.id && x.grantee === who);
          if (had) had.role = String(parsed?.role ?? "viewer"); else m.sessionShares.push({ id: `sh_${m.sessionShares.length + 1}`, session_id: row.id, owner: username, grantee: who, role: String(parsed?.role ?? "viewer") });
          return json(res, 201, { ok: true });
        }
        if (req.method === "DELETE") {
          const i = m.sessionShares.findIndex((x) => x.id === ash[2] && x.session_id === row.id);
          if (i < 0) return json(res, 404, { detail: "Share grant not found." });
          m.sessionShares.splice(i, 1);
          return json(res, 200, { revoked: ash[2] });
        }
      }
      const asg = /^\/agent-sessions\/([^/]+)$/.exec(rest);
      if (asg && req.method === "GET") {
        const row = [...m.agentSessions.values()].find((r) => r.id === asg[1] && r.user === username);
        if (!row) return json(res, 404, { detail: "Agent session not found" });
        const limit = Math.max(1, Math.min(1000, Number(u.searchParams.get("limit") ?? 200)));
        const before = u.searchParams.get("before_seq") ? Number(u.searchParams.get("before_seq")) : undefined;
        const all = row.messages.map((x, i) => ({ ...x, seq: i + 1 })).filter((x) => before === undefined || x.seq < before);
        const win = all.slice(-limit);
        return json(res, 200, { session_id: row.id, status: row.status, message_count: row.messages.length, messages: win, has_more_before: all.length > win.length });
      }
      const asm = /^\/agent-sessions\/([^/]+)\/(append|close)$/.exec(rest);
      if (asm) {
        const row = [...m.agentSessions.values()].find((r) => r.id === asm[1] && r.user === username);
        if (!row) return json(res, 404, { detail: "no such session" });
        if (asm[2] === "append") { for (const x of (Array.isArray(parsed?.messages) ? parsed.messages : [])) { if (x.client_message_id && row.messages.some((y) => y.client_message_id === x.client_message_id)) continue; row.messages.push(x); } if (parsed?.title) row.title = String(parsed.title); row.status = "active"; }
        else { row.status = String(parsed?.status ?? "ended"); row.summary = String(parsed?.summary ?? ""); }
        return json(res, 200, { ok: true, pending_replies: [] });
      }
      return json(res, 200, { ok: true });
    }
    // Caelum (MINDapp backend/routes/agentbuilder_routes.py): brief -> AgentSpec.
    if (u.pathname === "/api/agentbuilder/intake" && req.method === "POST") {
      if (!m.keys.has(key)) return json(res, 401, { detail: "Not authenticated" });
      const brief = String((parsed as any)?.brief ?? "");
      return json(res, 200, { spec: { name: "claim_review_bot", role: "Claim email reviewer", primary_responsibility: `Handles: ${brief}`, purposes: ["Summarize each claim"], rules: ["Never email a client"], success_criteria: ["Every claim summarized by 9am"], traits: ["careful"] }, preview: {} });
    }
    json(res, 404, { detail: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  m.url = `http://127.0.0.1:${port}`;
  m.base = `${m.url}/developer/v1`;
  return m;
}
