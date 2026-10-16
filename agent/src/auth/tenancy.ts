// Hosted multi-tenancy: one Runtime (MindClient + kernel + tools) per signed-in MIND user, built from THAT
// user's own credentials. The server-wide MIND_API_KEY never reaches a user runtime.
import { DailyCostCap } from "../hosted.ts";
import { createRuntime } from "../runtime.ts";
import type { Provider, Config, Runtime } from "../types.ts";
import type { SessionStore } from "../persist.ts";
import type { BootCache } from "../mind/boot-cache.ts";
import type { MindCredits } from "../provider/mind.ts";
import { MindOAuth } from "./mind-auth.ts";
import { OWNER } from "./users.ts";
import type { Principal, UserStore } from "./users.ts";

export interface AuthContext {
  store: UserStore;
  /** Absent when OAuth is not configured; API-key sign-in works regardless. */
  oauth?: MindOAuth;
  /** DAEBOT_ALLOWED_USERS (lowercased); empty = any MIND account may sign in. */
  allowedUsers: string[];
  /** The runtime a principal acts through. Owner -> the shared server-key runtime; user -> their own. */
  runtimeFor(p: Principal): Runtime;
  /** Drops a user's cached runtime (call after they sign in again with fresh credentials). */
  evict(uid: string): void;
  /** DAEBOT_BILLING=mind only: tier + credits cache shared with every provider, and the MIND key a principal's calls are billed to. */
  credits?: MindCredits;
  billingKey(p: Principal): string | undefined;
  /** Live MIND API base the sign-in checks against. */
  mindBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface HubOptions {
  baseCfg: Config;
  ownerRuntime: Runtime;
  store: UserStore;
  oauth?: MindOAuth;
  globalCap: DailyCostCap;
  userCapUsd: number;
  provider?: Provider;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Shared session store + boot cache: records carry the owning user id; the boot cache is keyed by the user's MIND key hash. */
  sessionStore?: SessionStore;
  bootCache?: BootCache;
  /** Set in mind billing mode. */
  credits?: MindCredits;
}

interface UserSlot { runtime: Runtime; key: string; refreshing?: Promise<boolean> }

export function createRuntimeHub(o: HubOptions): { runtimeFor(p: Principal): Runtime; userCap(uid: string): DailyCostCap; evict(uid: string): void } {
  const runtimes = new Map<string, Runtime>(); // keyed by `${userId}:${tier}` so a tier change rebuilds
  const caps = new Map<string, DailyCostCap>();

  function userCap(uid: string): DailyCostCap {
    let c = caps.get(uid);
    if (!c) { c = new DailyCostCap(o.userCapUsd, o.now); c.label = "Your daily cost cap"; caps.set(uid, c); }
    return c;
  }

  // Rotate an OAuth key pair after MIND answered 401 (key revoked or rotated). One refresh in flight per user.
  function refresher(uid: string, slot: UserSlot): () => Promise<boolean> {
    return () => {
      if (slot.refreshing) return slot.refreshing;
      const run = (async () => {
        const c = o.store.creds(uid);
        if (!c || c.kind !== "oauth" || !c.refreshToken || !o.oauth) return false;
        try {
          const t = await o.oauth.refresh(c.refreshToken, c.clientId);
          o.store.setCreds(uid, { kind: "oauth", accessToken: t.accessToken, refreshToken: t.refreshToken ?? c.refreshToken, clientId: c.clientId });
          slot.key = t.accessToken;
          return true;
        } catch {
          return false;
        }
      })().finally(() => { slot.refreshing = undefined; });
      slot.refreshing = run;
      return run;
    };
  }

  function build(p: Principal): Runtime {
    const creds = o.store.creds(p.id);
    // No readable credentials: a runtime that fails closed (every session open is refused; the client signs in again).
    if (!creds) return { openSession: async () => { throw new Error("Your MIND sign-in expired. Sign in again."); }, listSessions: () => [] };
    const key = creds.kind === "key" ? creds.mindKey : creds.accessToken;
    const slot: UserSlot = { runtime: undefined as unknown as Runtime, key };
    // The user's own tenant: their key for everything (tools, boot, Agent Session sync). Never the server's key.
    const cfg: Config = { ...o.baseCfg, mindApiKey: key, mindSessionApiKey: "" };
    const inner = createRuntime(cfg, {
      provider: o.provider,
      fetchImpl: o.fetchImpl,
      credits: o.credits,
      store: o.sessionStore,
      bootCache: o.bootCache,
      owner: p.id,
      hosted: {
        dailyUsdCap: o.globalCap.capUsd,
        sharedCap: o.globalCap,
        // Admins are exempt from BOTH caps (so strangers can never lock them out); non-admin spend counts toward the global cap.
        exempt: p.tier === "admin",
        // Learning (admin tier only, see runtime.ts) uses THIS user's client above and files their model under their MIND username.
        username: p.username,
        userCap: p.tier === "admin" ? undefined : userCap(p.id),
        now: o.now,
        persona: `You are Daebot (Dae), a personal agent for the MIND user "${p.username}". Their MIND is your memory and the only source of truth about their world; never assume it holds anything about anyone else.`,
        sourceKey: (surface) => `daebot-${surface}`,
        mindClient: { getKey: () => slot.key, onUnauthorized: creds.kind === "oauth" ? refresher(p.id, slot) : undefined },
      },
    });
    // The tier is forced here: a caller can never open a session above the signed-in user's tier.
    slot.runtime = {
      openSession: (opts) => inner.openSession({ ...opts, identity: p.tier }),
      listSessions: () => inner.listSessions(),
      history: (id) => inner.history?.(id),
    };
    return slot.runtime;
  }

  return {
    runtimeFor(p) {
      if (p.owner) return o.ownerRuntime;
      const ck = `${p.id}:${p.tier}`;
      const live = runtimes.get(ck);
      if (live) return live;
      const rt = build(p);
      // Only cache a runtime that has credentials (otherwise the next sign-in must build a fresh one).
      if (o.store.creds(p.id)) runtimes.set(ck, rt);
      return rt;
    },
    userCap,
    evict(uid) { for (const k of [...runtimes.keys()]) if (k.startsWith(`${uid}:`)) runtimes.delete(k); },
  };
}

export { OWNER };
