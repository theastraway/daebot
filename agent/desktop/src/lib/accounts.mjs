// Remembered MIND accounts for the desktop app: sign in once, switch any time. Same secure storage as the single key
// (a 0600 file in a 0700 directory under ~/.mindclaw, never argv, never a log line, never the web UI): accounts.json holds every
// signed-in account's key, and the active account's key is mirrored into the legacy `mind-key` file so everything that already reads
// that file keeps working. The web UI only ever sees { id, name, active } (publicList), never a key.
//
// Isolation: each account gets its own data directory (sessions, bots, permissions). The account that was already signed in before
// accounts existed ("legacy") keeps the default directory so nothing it owns moves or disappears.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { desktopHome } from "./config.mjs";
import { looksLikeMindKey } from "./credentials.mjs";

export const MAX_ACCOUNTS = 8;
export const accountsPath = (env = process.env) => join(desktopHome(env), "accounts.json");

const idForKey = (key) => "a_" + createHash("sha256").update("daebot-desktop-account:" + key.trim()).digest("hex").slice(0, 16);
const cleanName = (n) => (typeof n === "string" ? n.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80) : "");

function clean(raw) {
  const out = { v: 1, active: null, accounts: [], legacyName: "" };
  if (!raw || typeof raw !== "object") return out;
  for (const a of Array.isArray(raw.accounts) ? raw.accounts : []) {
    if (!a || !looksLikeMindKey(a.key) || out.accounts.length >= MAX_ACCOUNTS) continue;
    const key = a.key.trim();
    const id = idForKey(key);
    if (out.accounts.some((x) => x.id === id)) continue;
    out.accounts.push({ id, key, name: cleanName(a.name), legacy: a.legacy === true, addedAt: Number(a.addedAt) || 0 });
  }
  out.legacyName = cleanName(raw.legacyName);
  out.active = out.accounts.some((a) => a.id === raw.active) ? raw.active : out.accounts[0]?.id ?? null;
  return out;
}

export class AccountStore {
  /** @param {string} [path] */
  constructor(path = accountsPath()) { this.path = path; }

  load() {
    try { return clean(JSON.parse(readFileSync(this.path, "utf8"))); } catch { return clean(undefined); }
  }

  save(d) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* not supported on this filesystem */ }
    renameSync(tmp, this.path);
  }

  active() {
    const d = this.load();
    const a = d.accounts.find((x) => x.id === d.active);
    return a ? { ...a } : undefined;
  }

  /** What the web UI may see: no keys. */
  publicList() {
    const d = this.load();
    return d.accounts.map((a) => ({ id: a.id, name: a.name || "MIND account", active: a.id === d.active }));
  }

  /**
   * Adds (or refreshes) an account and makes it active. The same key, or the same MIND username, is one account (a rotated key replaces the old one).
   * `legacy` marks the account that already had data before accounts existed (it keeps the default data directory).
   */
  add({ key, name, legacy = false }, now = Date.now()) {
    if (!looksLikeMindKey(key)) throw new Error("That does not look like a MIND API key (it starts with mind_).");
    const d = this.load();
    const k = key.trim();
    const nm = cleanName(name);
    const id = idForKey(k);
    let prev = d.accounts.find((a) => a.id === id) ?? (nm ? d.accounts.find((a) => a.name && a.name.toLowerCase() === nm.toLowerCase()) : undefined);
    const rest = d.accounts.filter((a) => a !== prev);
    if (!prev && rest.length >= MAX_ACCOUNTS) throw new Error(`You can keep up to ${MAX_ACCOUNTS} accounts on this computer. Sign out of one first.`);
    // A renamed key for the same username keeps the old account's data directory (legacy flag) so its chats stay.
    // Signing back in as the person whose chats live in the default directory reclaims it, so their chats come back.
    const reclaim = !!nm && !!d.legacyName && d.legacyName.toLowerCase() === nm.toLowerCase();
    const acct = { id, key: k, name: nm || prev?.name || "", legacy: legacy || reclaim || prev?.legacy === true, addedAt: prev?.addedAt || now };
    const next = { v: 1, active: id, accounts: [...rest, acct], legacyName: acct.legacy && acct.name ? acct.name : d.legacyName };
    this.save(next);
    return { id, name: acct.name, legacy: acct.legacy };
  }

  setName(id, name) {
    const d = this.load();
    const a = d.accounts.find((x) => x.id === id);
    const nm = cleanName(name);
    if (!a || !nm || a.name === nm) return;
    a.name = nm;
    if (a.legacy) d.legacyName = nm;
    this.save(d);
  }

  /** Makes a remembered account active and returns it (with its key, for the main process only). Unknown id = undefined. */
  switchTo(id) {
    const d = this.load();
    const a = d.accounts.find((x) => x.id === id);
    if (!a) return undefined;
    this.save({ ...d, active: a.id });
    return { ...a };
  }

  /** Forgets one account. If it was active, the next remembered one becomes active. Returns the new active account (or undefined when none remain). */
  remove(id) {
    const d = this.load();
    const accounts = d.accounts.filter((a) => a.id !== id);
    if (accounts.length === d.accounts.length) return this.active();
    const active = d.active === id ? accounts[0]?.id ?? null : d.active;
    this.save({ ...d, active, accounts });
    return this.active();
  }

  clear() { const d = this.load(); this.save({ v: 1, active: null, accounts: [], legacyName: d.legacyName }); }
}

/**
 * Data directory for an account: the legacy account keeps the default (undefined = do not set DATA_DIR); every other account has its own
 * directory under the desktop home, so one account never reads another's chats, bots or permission rules.
 */
export function dataDirFor(account, env = process.env) {
  if (!account || account.legacy) return undefined;
  return join(desktopHome(env), "accounts", account.id, "data");
}
