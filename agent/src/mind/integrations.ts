// The user's MIND integrations (Google, GitHub, Dropbox, Apple Calendar, ...) as Daebot reads them: the Apps card, the system prompt's
// "Connected apps" section and the mind_apps tool all go through this one module. Every call is made with the SIGNED-IN USER'S OWN
// MIND key (MIND: GET /developer/v1/integrations). Nothing here is ever logged or echoed with the key.

const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** What an app brings into MIND. Each one has a Daebot tool that reaches it (see connected.ts). */
export type AppCapability = "mail" | "calendar" | "contacts" | "files";
export const CAPABILITIES: readonly AppCapability[] = ["mail", "calendar", "contacts", "files"];

export interface AppRow {
  provider: string;
  name: string;
  blurb: string;
  auth: "oauth" | "credentials";
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
  account: string | null;
  /** True for an app that lets one user connect several accounts (GitHub); `accounts` then lists every connected one. */
  multi?: boolean;
  accounts?: { id: string; label: string; needsReconnect: boolean }[];
  /** What this connection syncs into MIND right now (a capability MIND offers AND the user has not switched off). Empty when not connected. */
  caps: AppCapability[];
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** MIND's provider list reduced to what the card and the model need. Unknown shapes are dropped, never forwarded. */
export function normalizeProviders(payload: any): { enabled: boolean; providers: AppRow[] } {
  const raw = Array.isArray(payload?.providers) ? payload.providers : [];
  const providers: AppRow[] = [];
  for (const p of raw) {
    const id = str(p?.provider, 40);
    if (!PROVIDER_RE.test(id)) continue;
    const connected = p.connected === true;
    const toggles = p.capability_toggles && typeof p.capability_toggles === "object" ? (p.capability_toggles as Record<string, unknown>) : {};
    // MIND lists a capability per provider (calendar, mail, contacts, files) and lets the user switch mail, calendar and contacts off per connection.
    const caps = connected ? CAPABILITIES.filter((c) => p[c] === true && (c === "files" || toggles[c] !== false)) : [];
    const accounts: AppRow["accounts"] = [];
    if (p.multi_account === true && Array.isArray(p.accounts)) {
      for (const a of p.accounts.slice(0, 20)) {
        const aid = str(a?.id, 40);
        if (!PROVIDER_RE.test(aid)) continue;
        accounts.push({ id: aid, label: str(a?.account_label, 120) || aid, needsReconnect: a?.needs_reauth === true || a?.status === "error" || a?.status === "reauth_required" });
      }
    }
    providers.push({
      provider: id,
      name: str(p.display_name, 60) || id,
      blurb: str(p.blurb, 200),
      auth: p.auth === "credentials" ? "credentials" : "oauth",
      configured: p.configured !== false,
      connected,
      needsReconnect: connected && (p.needs_reauth === true || p.reconnect_required === true || p.status === "error" || p.status === "reauth_required"),
      account: str(p.account_label, 120) || null,
      multi: p.multi_account === true,
      accounts,
      caps,
    });
  }
  return { enabled: payload?.integrations_enabled !== false, providers };
}

/** An app this user can see in the Apps card: connected, or one MIND has set up. */
export const connectable = (p: Pick<AppRow, "connected" | "configured">): boolean => p.connected || p.configured !== false;

export type IntegrationsResult =
  | { ok: true; enabled: boolean; providers: AppRow[] }
  | { ok: false; status: number; reason: string };

/** GET <base>/integrations with this user's key. Never throws. `reason` is plain words and carries no key. */
export async function fetchIntegrations(o: { baseUrl: string; key: string; fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }): Promise<IntegrationsResult> {
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  try {
    const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs ?? 8000)]) : AbortSignal.timeout(o.timeoutMs ?? 8000);
    const r = await f(`${o.baseUrl.replace(/\/+$/, "")}/integrations`, { headers: { "X-API-Key": o.key, Accept: "application/json" }, signal });
    if (!r.ok) {
      const reason = r.status === 401 || r.status === 403 ? "MIND did not accept your key for apps" : r.status === 404 ? "apps are not switched on at MIND yet" : `MIND answered ${r.status}`;
      return { ok: false, status: r.status, reason };
    }
    const j = await r.json().catch(() => undefined);
    if (!j || typeof j !== "object") return { ok: false, status: 502, reason: "MIND sent back something unreadable" };
    return { ok: true, ...normalizeProviders(j) };
  } catch (e) {
    const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
    return { ok: false, status: 0, reason: timedOut ? "MIND took too long to answer" : "MIND could not be reached" };
  }
}

// ---------------------------------------------------------------- one app, two lists

// A MIND integration (it syncs data INTO MIND) and a MIND App Store connector (an MCP server that lets Daebot ACT in the app) can be the
// same product: GitHub is both. The Apps card shows ONE row for it, with the connector inside, so the rule for "same product" lives here
// and the gateway marks each connector with it. The aliases are products MIND may list under another name.
const ALIASES: Record<string, string[]> = {
  google: ["google", "google-workspace", "gmail", "google-mail", "google-calendar", "google-drive", "google-contacts", "gdrive"],
  microsoft: ["microsoft", "microsoft-365", "microsoft365", "office-365", "office365", "m365", "outlook", "onedrive", "sharepoint"],
  apple: ["apple", "apple-calendar", "icloud", "icloud-calendar"],
};

export const slugOf = (s: string): string =>
  String(s ?? "").toLowerCase().replace(/^mcp:/, "").replace(/\b(mcp|server)\b/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export interface Foldable { id: string; name: string }

/** The MIND integration this connector is the same product as, or undefined. Only providers the user can see count: a connector is never hidden behind a row that is not shown. */
export function providerFor(item: Foldable, providers: Pick<AppRow, "provider" | "name" | "connected" | "configured">[]): string | undefined {
  const keys = new Set([slugOf(item.id), slugOf(item.name)].filter(Boolean));
  for (const p of providers) {
    if (!connectable(p)) continue;
    const own = new Set([slugOf(p.provider), slugOf(p.name), ...(ALIASES[p.provider] ?? [])]);
    for (const k of keys) if (own.has(k)) return p.provider;
  }
  return undefined;
}

/** The words the Apps card puts on a connector folded into its app. */
export function addonWords(providerName: string, provider: string): { label: string; why: string } {
  if (provider === "github") {
    return {
      label: "GitHub actions (issues, pull requests, code)",
      why: "Optional. Lets Daebot open issues and pull requests and work with your code on GitHub. The connection above only syncs your repositories' files into MIND.",
    };
  }
  return {
    label: `${providerName} actions`,
    why: `Optional. Lets Daebot work in ${providerName} directly. The connection above only syncs data into MIND.`,
  };
}
