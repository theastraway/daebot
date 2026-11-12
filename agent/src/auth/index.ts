// Wires hosted multi-user sign-in from the environment.
//   DAEBOT_SECRET_KEY            AES-256-GCM data key for stored user credentials (32+ chars). Without it only the owner code works.
//   DATA_DIR                     the one data dir (/data on Render); the encrypted user store is DATA_DIR/users/daebot-users.json
//   DAEBOT_ADMINS                comma list of MIND usernames that get the unrestricted tier (e.g. owner_test)
//   DAEBOT_ALLOWED_USERS         optional comma list; empty = any MIND account may sign in
//   DAEBOT_PROVISION_TOKEN       optional service token (24+ chars) for POST /auth/provision (Astra AI client portal); unset = off
//   MINDCLAW_USER_DAILY_USD_CAP  per-user daily spend cap, default 1 (admins and the owner login are exempt from this and the global cap).
//                                Ignored when DAEBOT_BILLING=mind: the user's MIND plan and credits are the cap.
//   MIND_OAUTH_CLIENT_ID/SECRET  optional; Daebot registers itself with MIND (RFC 7591) when no client id is given
//   MIND_OAUTH_BASE_URL          optional MIND origin for /oauth/mcp/* (default: origin of MIND_BASE_URL)
//   DAEBOT_OWNED_CACHE_MS        optional; how long the owned-MIND list behind Switch account is cached (default 20000)
//   DAEBOT_PUBLIC_URL            optional public origin for the OAuth redirect (default https://<first allowed host>)
import { DailyCostCap } from "../hosted.ts";
import type { HostedOptions } from "../hosted.ts";
import type { Config, Provider, Runtime } from "../types.ts";
import { MindOAuth, oauthSettingsFromEnv } from "./mind-auth.ts";
import { createRuntimeHub } from "./tenancy.ts";
import { parseCoders } from "../kernel/coder.ts";
import type { AuthContext } from "./tenancy.ts";
import { join } from "node:path";
import { dataDir } from "../persist.ts";
import type { SessionStore } from "../persist.ts";
import type { BootCache } from "../mind/boot-cache.ts";
import type { MindCredits } from "../provider/mind.ts";
import { UserStore, parseList } from "./users.ts";
import { EntryCodes, RuntimeAllowList } from "./provision.ts";
import { TenantDirectory } from "./tenants.ts";

export const DEFAULT_USER_DAILY_USD_CAP = 1;

export function parseUserCap(v: string | undefined): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : DEFAULT_USER_DAILY_USD_CAP;
}

/** Throws HostedConfigError when stored users exist but DAEBOT_SECRET_KEY is missing/short. */
export function createAuthContext(o: {
  env?: NodeJS.ProcessEnv;
  cfg: Config;
  hosted: HostedOptions;
  ownerRuntime: Runtime;
  globalCap: DailyCostCap;
  fetchImpl?: typeof fetch;
  provider?: Provider;
  now?: () => Date;
  sessionStore?: SessionStore;
  bootCache?: BootCache;
  /** DAEBOT_BILLING=mind: shared tier + credits cache. */
  credits?: MindCredits;
  bots?: import("../bots/types.ts").BotsContext;
  mcpConnect?: import("../mcpconnect/service.ts").McpConnectService;
}): AuthContext {
  const env = o.env ?? process.env;
  // ONE data dir: DATA_DIR (shared with saved sessions); the encrypted user store lives under DATA_DIR/users.
  const dir = join(dataDir(env), "users");
  const store = new UserStore({ dir, secretKey: env.DAEBOT_SECRET_KEY, admins: parseList(env.DAEBOT_ADMINS) });
  const oauth = store.enabled
    ? new MindOAuth(oauthSettingsFromEnv(env, { mindBaseUrl: o.cfg.mindBaseUrl, allowedHosts: o.hosted.allowedHosts, dataDir: dir }), o.fetchImpl)
    : undefined;
  // DAEBOT_CODERS: per-user GitHub write grants. A bad value is reported (plain lines, no values) and grants nothing.
  const coderGrants = parseCoders(env.DAEBOT_CODERS);
  for (const line of coderGrants.problems) process.stderr.write(`${line}\n`);
  const hub = createRuntimeHub({
    baseCfg: o.cfg, ownerRuntime: o.ownerRuntime, store, oauth, globalCap: o.globalCap,
    userCapUsd: parseUserCap(env.MINDCLAW_USER_DAILY_USD_CAP), fetchImpl: o.fetchImpl, provider: o.provider, now: o.now, sessionStore: o.sessionStore, bootCache: o.bootCache, credits: o.credits, bots: o.bots, mcpConnect: o.mcpConnect, coders: coderGrants.coders,
  });
  return {
    store, oauth, allowedUsers: parseList(env.DAEBOT_ALLOWED_USERS),
    runtimeAllow: new RuntimeAllowList(dir), entryCodes: new EntryCodes(), provisionToken: (env.DAEBOT_PROVISION_TOKEN ?? "").trim() || undefined,
    credits: o.credits,
    tenants: new TenantDirectory(o.cfg.mindBaseUrl, o.fetchImpl, undefined, Number(env.DAEBOT_OWNED_CACHE_MS) >= 0 && env.DAEBOT_OWNED_CACHE_MS ? Number(env.DAEBOT_OWNED_CACHE_MS) : undefined),
    // A user's calls are billed to their own MIND key; the owner access-code login to the server MIND_API_KEY.
    billingKey: (p) => {
      if (p.owner) return o.cfg.mindApiKey || undefined;
      const c = store.creds(p.id);
      return c ? (c.kind === "key" ? c.mindKey : c.accessToken) : undefined;
    },
    runtimeFor: hub.runtimeFor, evict: hub.evict, mindBaseUrl: o.cfg.mindBaseUrl, fetchImpl: o.fetchImpl,
  };
}
