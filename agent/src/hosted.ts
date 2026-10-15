// Hosted mode: the public deployment (Render, TLS terminated by the platform).
//
// Threat model: a public bot with shell and file tools lets a prompt injection read the server's env
// (MIND key, OpenRouter key). So hosted mode (1) removes every host-level tool, (2) requires a login,
// (3) pins the Host/Origin allowlist, (4) caps daily spend. Everything here is pure and env-driven so it
// can be unit tested without a network.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Tool } from "./types.ts";

export const MIN_TOKEN_LEN = 24;
export const DEFAULT_DAILY_USD_CAP = 5;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class HostedConfigError extends Error {}

export interface HostedOptions {
  /** The fixed login secret (GATEWAY_TOKEN). Never logged. */
  token: string;
  /** Lowercased hostnames (no port) the gateway answers to. */
  allowedHosts: string[];
  /** Max failed logins per IP per window. */
  loginMaxFails?: number;
  loginWindowMs?: number;
  /** Test hook: session lifetime. */
  sessionTtlMs?: number;
}

export function isHostedEnv(env: NodeJS.ProcessEnv = process.env, argv: string[] = []): boolean {
  return argv.includes("--hosted") || /^(1|true|yes|on)$/i.test((env.MINDCLAW_HOSTED ?? "").trim());
}

export function parseAllowedHosts(list: string | undefined, extra: (string | undefined)[] = []): string[] {
  const out = new Set<string>();
  for (const raw of [...(list ?? "").split(","), ...extra]) {
    const h = (raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
    if (h) out.add(h);
  }
  return [...out];
}

/** Reads and validates hosted settings. Throws HostedConfigError (message is safe to print; it never contains the token). */
export function loadHostedOptions(env: NodeJS.ProcessEnv = process.env): HostedOptions {
  const token = (env.GATEWAY_TOKEN ?? "").trim();
  if (!token) throw new HostedConfigError("hosted mode needs GATEWAY_TOKEN (the login secret, at least 24 characters). Refusing to start.");
  if (token.length < MIN_TOKEN_LEN) throw new HostedConfigError(`GATEWAY_TOKEN is too short (need at least ${MIN_TOKEN_LEN} characters). Refusing to start.`);
  // Render injects RENDER_EXTERNAL_HOSTNAME (the <service>.onrender.com name); it is always legitimate for this service.
  const allowedHosts = parseAllowedHosts(env.ALLOWED_HOSTS, [env.RENDER_EXTERNAL_HOSTNAME]);
  if (allowedHosts.length === 0) throw new HostedConfigError("hosted mode needs ALLOWED_HOSTS (comma list, e.g. daebot.live,www.daebot.live). Refusing to start.");
  return { token, allowedHosts };
}

export function hostedPort(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const n = Number(env.PORT);
  return Number.isInteger(n) && n >= 0 && n < 65536 && (env.PORT ?? "").trim() !== "" ? n : undefined;
}

// ---------- tools ----------
// The ONLY tools a hosted session may offer or run: web_fetch and the mind_* family.
export function hostedToolAllowed(name: string): boolean {
  return name === "web_fetch" || /^mind_[a-z0-9_]+$/.test(name);
}

export function filterHostedTools(tools: Tool[]): Tool[] {
  return tools.filter((t) => hostedToolAllowed(t.spec.name));
}

// ---------- daily cost cap ----------
export function parseDailyCap(v: string | undefined): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_USD_CAP;
}

export class DailyCostCap {
  readonly capUsd: number;
  private day = "";
  private spent = 0;
  private now: () => Date;
  constructor(capUsd: number, now: () => Date = () => new Date()) {
    this.capUsd = capUsd;
    this.now = now;
  }
  private roll(): void {
    const d = this.now().toISOString().slice(0, 10); // process day = UTC day
    if (d !== this.day) { this.day = d; this.spent = 0; }
  }
  add(usd: number): void {
    this.roll();
    if (Number.isFinite(usd) && usd > 0) this.spent += usd;
  }
  total(): number { this.roll(); return this.spent; }
  exceeded(): boolean { this.roll(); return this.spent >= this.capUsd; }
  notice(): string {
    return `Daily cost cap reached ($${this.spent.toFixed(2)} of $${this.capUsd.toFixed(2)}). New turns resume tomorrow (UTC) or when the cap is raised.`;
  }
}

// ---------- login rate limit ----------
export class LoginLimiter {
  private fails = new Map<string, number[]>();
  private all: number[] = [];
  private maxFails: number;
  private windowMs: number;
  private globalMax: number;
  constructor(o: { maxFails?: number; windowMs?: number; globalMax?: number } = {}) {
    this.maxFails = o.maxFails ?? 5;
    this.windowMs = o.windowMs ?? 10 * 60 * 1000;
    this.globalMax = o.globalMax ?? Math.max(this.maxFails * 8, 40);
  }
  private prune(now: number): void {
    const cut = now - this.windowMs;
    this.all = this.all.filter((t) => t > cut);
    for (const [k, v] of this.fails) {
      const kept = v.filter((t) => t > cut);
      if (kept.length) this.fails.set(k, kept); else this.fails.delete(k);
    }
  }
  /** Seconds until another attempt is allowed, or 0 when the caller may try. */
  retryAfter(ip: string, now = Date.now()): number {
    this.prune(now);
    const mine = this.fails.get(ip) ?? [];
    let until = 0;
    if (mine.length >= this.maxFails) until = mine[mine.length - this.maxFails] + this.windowMs;
    if (this.all.length >= this.globalMax) until = Math.max(until, this.all[this.all.length - this.globalMax] + this.windowMs);
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }
  fail(ip: string, now = Date.now()): void {
    this.prune(now);
    this.all.push(now);
    const v = this.fails.get(ip) ?? [];
    v.push(now);
    this.fails.set(ip, v);
  }
  success(ip: string): void { this.fails.delete(ip); }
}

// ---------- session cookie ----------
// Stateless: "<expiryMs>.<hmac>". The login secret never goes in the cookie; rotating GATEWAY_TOKEN signs everyone out.
function mac(token: string, expiry: string): string {
  return createHmac("sha256", token).update(`mindclaw-session:${expiry}`).digest("base64url");
}

export function issueSession(token: string, ttlMs = SESSION_TTL_MS, now = Date.now()): { value: string; maxAgeSec: number } {
  const expiry = String(now + ttlMs);
  return { value: `${expiry}.${mac(token, expiry)}`, maxAgeSec: Math.floor(ttlMs / 1000) };
}

export function verifySession(token: string, value: string | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const i = value.indexOf(".");
  if (i < 1) return false;
  const expiry = value.slice(0, i);
  if (!/^\d{10,16}$/.test(expiry) || Number(expiry) <= now) return false;
  const want = Buffer.from(mac(token, expiry));
  const got = Buffer.from(value.slice(i + 1));
  return want.length === got.length && timingSafeEqual(want, got);
}
