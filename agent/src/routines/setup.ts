// "Set up" for a trigger: what it needs before it can work, checked LIVE, with the one action that fixes each missing piece. Pure: the
// gateway gathers the facts (is Gmail connected, is the screen allowed, does the routine exist yet) into a SetupEnv and this decides.
// A routine can be turned on only when no check is "missing". "unknown" (MIND could not be asked) and "info" never block.
import { existsSync, statSync } from "node:fs";
import { DEFS, POLL_MINUTES, isGithub, isPoll } from "./triggers.ts";
import type { Trigger, TriggerType } from "./triggers.ts";

export interface SetupApp { provider: string; name: string; connected: boolean; needsReconnect: boolean; configured: boolean; account: string | null; caps: string[] }

export interface SetupEnv {
  /** The signed-in user has a MIND key (the owner access-code login has none). */
  hasKey: boolean;
  /** The user's MIND apps; undefined = MIND could not be asked just now. */
  apps?: SetupApp[];
  /** The screen feed, when this gateway runs on the user's computer. */
  screen?: { watching: boolean; permission: string };
  /** The routine already exists (so its web address and secret do too). */
  saved?: boolean;
  /** When GitHub last reached this routine (any delivery, including GitHub's own ping). */
  lastDeliveryAt?: number;
  isDir?: (p: string) => boolean;
}

export type SetupAction =
  | { type: "connect"; provider: string; label: string }
  | { type: "grant"; label: string }
  | { type: "choose"; label: string }
  | { type: "copy"; label: string }
  | { type: "test"; label: string };

export interface SetupCheck {
  id: string;
  label: string;
  /** ok: met. missing: blocks turning the routine on. unknown: could not check (does not block). info: nothing to do, just something to know. */
  state: "ok" | "missing" | "unknown" | "info";
  detail: string;
  actions?: SetupAction[];
}

export interface SetupReport { ready: boolean; missing: string[]; checks: SetupCheck[] }

const dirOk = (p: string): boolean => { try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; } };
const MAIL_PROVIDERS: { provider: string; label: string }[] = [{ provider: "google", label: "Connect Gmail" }, { provider: "microsoft", label: "Connect Outlook" }];

export function checkSetup(raw: unknown, env: SetupEnv): SetupReport {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const type = typeof o.type === "string" && DEFS.has(o.type as TriggerType) ? (o.type as TriggerType) : undefined;
  const def = type ? DEFS.get(type) : undefined;
  const checks: SetupCheck[] = [];
  if (!def || !type) return { ready: false, missing: ["Pick what starts this routine."], checks };
  const t = o as unknown as Partial<Trigger>;

  // Required inputs (the words to look for, the folder). A folder also has to exist on this computer.
  for (const f of def.fields) {
    if (!f.required) continue;
    const v = typeof o[f.key] === "string" ? String(o[f.key]).trim() : "";
    if (f.kind === "path") continue;   // the folder need below covers it
    checks.push(v ? { id: `input:${f.key}`, label: f.label, state: "ok", detail: v.slice(0, 80) } : { id: `input:${f.key}`, label: f.label, state: "missing", detail: "Fill this in." });
  }

  for (const need of def.needs ?? []) {
    switch (need) {
      case "mind":
        checks.push(env.hasKey
          ? { id: "mind", label: "Your MIND", state: "ok", detail: "Daebot reads your MIND with your own key." }
          : { id: "mind", label: "Your MIND", state: "missing", detail: "Sign in with MIND (not the access code) so Daebot can read your MIND." });
        break;
      case "mail": {
        if (!env.hasKey) { checks.push({ id: "mail", label: "A connected mailbox", state: "missing", detail: "Sign in with MIND (not the access code) to connect a mailbox." }); break; }
        if (!env.apps) { checks.push({ id: "mail", label: "A connected mailbox", state: "unknown", detail: "MIND did not answer, so Daebot could not check your mailbox. Try again in a moment." }); break; }
        const mail = env.apps.filter((a) => a.connected && a.caps.includes("mail"));
        const good = mail.find((a) => !a.needsReconnect);
        if (good) { checks.push({ id: "mail", label: "A connected mailbox", state: "ok", detail: `Reading ${good.name}${good.account ? ` (${good.account})` : ""}.` }); break; }
        const stale = mail.find((a) => a.needsReconnect);
        const offered = MAIL_PROVIDERS.filter((m) => { const a = env.apps!.find((x) => x.provider === m.provider); return !a || a.configured !== false; });
        checks.push({
          id: "mail", label: "A connected mailbox", state: "missing",
          detail: stale ? `${stale.name} needs you to sign in again before Daebot can read it.` : "No mailbox is connected. Connect Gmail or Outlook; Daebot reads it through MIND.",
          actions: (stale ? [{ type: "connect" as const, provider: stale.provider, label: `Reconnect ${stale.name}` }] : (offered.length ? offered : MAIL_PROVIDERS).map((m) => ({ type: "connect" as const, provider: m.provider, label: m.label }))),
        });
        break;
      }
      case "webhook":
        checks.push(env.saved
          ? { id: "webhook", label: "The web address", state: "ok", detail: "Anything that can send a web request can run this routine. Keep the address private.", actions: [{ type: "copy", label: "Copy address" }, { type: "test", label: "Send test event" }] }
          : { id: "webhook", label: "The web address", state: "info", detail: "Daebot makes the secret address when you save. It appears here, with a Send test event button." });
        break;
      case "github": {
        const gh = env.apps?.find((a) => a.provider === "github");
        if (!env.saved) checks.push({ id: "github", label: "GitHub webhook", state: "info", detail: "Save the routine first: Daebot then shows the address and the secret to paste into the repository's Settings, Webhooks." });
        else if (env.lastDeliveryAt) checks.push({ id: "github", label: "GitHub webhook", state: "ok", detail: "GitHub has reached Daebot. Real events run the routine the moment they happen.", actions: [{ type: "test", label: "Send test event" }] });
        else checks.push({ id: "github", label: "GitHub webhook", state: "info", detail: "Waiting for GitHub's first delivery. Paste the address and secret below into the repository's Settings, Webhooks (content type application/json), or press Send test event to try the path now.", actions: [{ type: "test", label: "Send test event" }] });
        if (gh?.connected) checks.push({ id: "github-app", label: "Your GitHub connection", state: "info", detail: "Connected, but Daebot cannot add the webhook for you yet: paste it once, by hand, as above." });
        break;
      }
      case "screen": {
        const s = env.screen;
        if (s && s.watching && s.permission === "granted") checks.push({ id: "screen", label: "Screen permission", state: "ok", detail: "Daebot may watch your screen." });
        else checks.push({
          id: "screen", label: "Screen permission", state: "missing",
          detail: !s ? "Open the Daebot desktop app: it asks your computer for permission." : !s.watching ? "\"Let Daebot watch my screen\" is off." : s.permission === "needs-permission" ? "Your computer has not allowed Screen Recording for Daebot yet." : "Your computer does not allow Daebot to capture the screen.",
          actions: s && s.permission !== "restricted" && s.permission !== "unsupported" ? [{ type: "grant", label: s.watching ? "Open System Settings" : "Turn on screen watching" }] : [],
        });
        break;
      }
      case "folder": {
        const p = typeof o.path === "string" ? o.path.trim() : "";
        const ok = p && (env.isDir ?? dirOk)(p);
        checks.push(ok
          ? { id: "folder", label: "Folder to watch", state: "ok", detail: p.slice(0, 120), actions: [{ type: "choose", label: "Choose another folder" }] }
          : { id: "folder", label: "Folder to watch", state: "missing", detail: p ? `"${p.slice(0, 80)}" is not a folder on this computer.` : "Choose the folder Daebot should watch.", actions: [{ type: "choose", label: "Choose folder" }] });
        break;
      }
    }
  }

  if (isPoll(type)) {
    const every = Number(t.every) || 15;
    const n = (POLL_MINUTES as readonly number[]).includes(every) ? every : 15;
    checks.push({ id: "interval", label: "How Daebot finds out", state: "info", detail: `${type === "mail_new" ? "Mail" : "MIND"} cannot call Daebot, so Daebot looks ${n === 60 ? "every hour" : `every ${n} minutes`}. What is new at that moment runs once; anything that arrived while Daebot was restarting is caught on the next look.` });
  } else if (isGithub(type) || type === "webhook") {
    checks.push({ id: "interval", label: "How Daebot finds out", state: "info", detail: "Pushed to Daebot the moment it happens. No waiting, no polling." });
  }

  const missing = checks.filter((c) => c.state === "missing").map((c) => `${c.label}: ${c.detail}`);
  return { ready: missing.length === 0, missing, checks };
}
