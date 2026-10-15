import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "node:http";

export function defaultTokenPath(): string {
  return join(homedir(), ".mindclaw", "gateway-token");
}

/** Reads the gateway token, creating it (32 random bytes hex, mode 0600) when missing or malformed. */
export function loadOrCreateToken(path: string = defaultTokenPath()): string {
  if (existsSync(path)) {
    const t = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(t)) {
      if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
      return t;
    }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const i = h.lastIndexOf(":");
  return i === -1 ? h : h.slice(0, i);
}

/** DNS-rebinding defense: only loopback names are acceptable Host values. */
export function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  return LOCAL_HOSTS.has(hostnameOf(hostHeader));
}

/** If a browser sent Origin, it must itself be a loopback origin (blocks cross-site WebSocket / POST). */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return LOCAL_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export const COOKIE_NAME = "mc_token";

/** Extracts a presented token: Authorization bearer, then cookie, then (if allowed) ?token=. */
export function presentedToken(req: IncomingMessage, query: URLSearchParams, allowQuery: boolean): string | undefined {
  const h = req.headers["authorization"];
  if (typeof h === "string") {
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (m) return m[1];
  }
  const c = parseCookies(req.headers["cookie"])[COOKIE_NAME];
  if (c) return c;
  if (allowQuery) return query.get("token") ?? undefined;
  return undefined;
}
