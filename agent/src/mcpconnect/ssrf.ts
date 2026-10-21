// SSRF guard + a fetch that cannot be talked into reaching the inside of our network. Zero deps.
//
// Every URL a user (or the model, or a remote server's metadata) hands us goes through here:
//   - https only, no credentials in the URL
//   - the host name is resolved by US, every answer must be a public address, and the connection is PINNED to the address we
//     checked (a second DNS lookup by the HTTP stack can never return a different, private one: DNS rebinding)
//   - redirects are followed by hand, up to 3 hops, and each hop is re-checked from scratch (https, host, resolved addresses)
//   - a timeout and a response-size cap, so a hostile server can neither hang a turn nor fill memory
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export class SsrfError extends Error {}

// ---------------------------------------------------------------- address classification

function v4ToInt(ip: string): number | undefined {
  const p = ip.split(".");
  if (p.length !== 4) return undefined;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const v = Number(part);
    if (v > 255) return undefined;
    n = n * 256 + v;
  }
  return n;
}

// [network, prefix length]
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4Blocked(n: number): boolean {
  for (const [net, bits] of V4_BLOCKED) {
    const base = v4ToInt(net)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n >>> 0) & mask) === (base & mask)) return true;
  }
  return false;
}

/** Expands an IPv6 literal into 8 16-bit words, or undefined when it is not valid. Handles "::" and a trailing dotted IPv4. */
function parseV6(ip: string): number[] | undefined {
  let s = ip.trim().toLowerCase();
  if (s.includes("%")) return undefined; // zone ids are never a public address
  let tail: number[] = [];
  const dot = s.lastIndexOf(".");
  if (dot !== -1) {
    const colon = s.lastIndexOf(":");
    const n = v4ToInt(s.slice(colon + 1));
    if (n === undefined) return undefined;
    tail = [(n >>> 16) & 0xffff, n & 0xffff];
    s = s.slice(0, colon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const rest = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
  const words = (a: string[]) => a.map((w) => (/^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : NaN));
  const h = words(head);
  const r = words(rest);
  if ([...h, ...r].some((x) => Number.isNaN(x))) return undefined;
  let out: number[];
  if (halves.length === 2) {
    const fill = 8 - h.length - r.length;
    if (fill < 1) return undefined;
    out = [...h, ...new Array(fill).fill(0), ...r];
  } else {
    out = h;
  }
  if (out.length !== 8) return undefined;
  if (tail.length) { out[6] = tail[0]; out[7] = tail[1]; }
  return out;
}

/** True when the address must never be reached: private, loopback, link-local, metadata, multicast, reserved, or not a valid IP. */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) { const n = v4ToInt(ip); return n === undefined || v4Blocked(n); }
  if (kind !== 6) return true;
  const w = parseV6(ip);
  if (!w) return true;
  const embedded = (hi: number, lo: number) => v4Blocked(((hi << 16) | lo) >>> 0);
  if (w.every((x) => x === 0)) return true;                                  // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true;       // ::1
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return embedded(w[6], w[7]); // ::ffff:a.b.c.d (mapped)
  if (w.slice(0, 6).every((x) => x === 0)) return true;                      // ::a.b.c.d (compatible, deprecated) and other low space
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return embedded(w[6], w[7]); // 64:ff9b::/96 NAT64
  if (w[0] === 0x64 && w[1] === 0xff9b) return true;                         // 64:ff9b:1::/48 local-use NAT64
  if (w[0] === 0x2002) return embedded(w[1], w[2]);                          // 6to4 carries an IPv4 address
  if (w[0] === 0x2001 && w[1] < 0x0200) return true;                         // 2001::/23: teredo, benchmarking, ORCHID, documentation
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true;
  if ((w[0] & 0xe000) !== 0x2000) return true;                               // only 2000::/3 (global unicast) is allowed
  return false;
}

const BAD_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet", ".corp", ".private"];

/** Checks the URL's host NAME before any lookup. Returns the lowercased host without brackets. Throws SsrfError. */
export function checkHostName(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h) throw new SsrfError("the URL has no host");
  if (isIP(h)) {
    if (isBlockedIp(h)) throw new SsrfError("that address is private or internal, so it is not allowed");
    return h;
  }
  if (h === "localhost" || BAD_SUFFIXES.some((s) => h.endsWith(s))) throw new SsrfError("that host name is internal, so it is not allowed");
  if (!h.includes(".")) throw new SsrfError("that host name has no domain, so it is not allowed");
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) || h.includes("..")) throw new SsrfError("that host name has unexpected characters"); // WHATWG URL already punycodes non-ASCII names
  return h;
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export const systemResolver: Resolver = async (hostname) => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family }));
};

/** Validates a URL and returns the one address the connection must use. Every answer from DNS must be public. */
export async function resolvePublic(url: URL, resolve: Resolver): Promise<{ address: string; family: 4 | 6 }> {
  if (url.protocol !== "https:") throw new SsrfError("only https URLs are allowed");
  if (url.username || url.password) throw new SsrfError("a URL with a user name or password in it is not allowed");
  const host = checkHostName(url.hostname);
  if (isIP(host)) return { address: host, family: isIP(host) as 4 | 6 };
  let rows: { address: string; family: number }[];
  try { rows = await resolve(host); } catch { throw new SsrfError(`could not look up ${host}`); }
  if (!rows.length) throw new SsrfError(`${host} did not resolve to any address`);
  // Strict: if even ONE answer is private the host is refused (a rebinding trick mixes public and private records).
  for (const r of rows) if (isBlockedIp(r.address)) throw new SsrfError(`${host} resolves to a private or internal address, so it is not allowed`);
  const pick = rows.find((r) => r.family === 4) ?? rows[0];
  return { address: pick.address, family: pick.family === 6 ? 6 : 4 };
}

// ---------------------------------------------------------------- transport

export interface RawRequest {
  url: URL;
  ip: string;
  family: 4 | 6;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}
export interface RawResponse { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
export type Transport = (req: RawRequest) => Promise<RawResponse>;

/** The `lookup` hook that makes Node connect to the address we validated instead of resolving the name again. */
export function pinnedLookup(ip: string, family: 4 | 6) {
  return (_host: string, opts: { all?: boolean } | undefined, cb: (err: Error | null, a: any, f?: number) => void): void => {
    if (opts?.all) cb(null, [{ address: ip, family }]);
    else cb(null, ip, family);
  };
}

/** Default transport. scheme "http" exists only so tests can exercise the timeout and the size cap against a local server. */
export function createNodeTransport(o: { scheme?: "https" | "http" } = {}): Transport {
  const mod = o.scheme === "http" ? httpRequest : httpsRequest;
  return (r) => new Promise<RawResponse>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); r.signal?.removeEventListener("abort", onAbort); fn(); };
    const host = r.url.hostname.startsWith("[") ? r.url.hostname.slice(1, -1) : r.url.hostname;
    const headers: Record<string, string> = { "accept-encoding": "identity", ...r.headers };
    if (r.body !== undefined) headers["content-length"] = String(Buffer.byteLength(r.body));
    const req = mod({
      hostname: host, port: r.url.port || (o.scheme === "http" ? 80 : 443), path: r.url.pathname + r.url.search, method: r.method, headers,
      lookup: pinnedLookup(r.ip, r.family) as never,
      servername: isIP(host) ? undefined : host,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > r.maxBytes) { finish(() => reject(new SsrfError("the response was too large and was cut off"))); req.destroy(); return; }
        chunks.push(c);
      });
      res.on("end", () => finish(() => resolve({ status: res.statusCode ?? 0, headers: res.headers as RawResponse["headers"], body: Buffer.concat(chunks) })));
      res.on("error", (e) => finish(() => reject(e)));
      res.on("aborted", () => finish(() => reject(new SsrfError("the connection closed early"))));
    });
    const onAbort = () => { finish(() => reject(new SsrfError("aborted"))); req.destroy(); };
    const timer = setTimeout(() => { finish(() => reject(new SsrfError("timed out"))); req.destroy(); }, r.timeoutMs);
    if (r.signal) { if (r.signal.aborted) return onAbort(); r.signal.addEventListener("abort", onAbort, { once: true }); }
    req.on("error", (e) => finish(() => reject(new SsrfError(`connection failed (${String((e as NodeJS.ErrnoException).code ?? e.message).slice(0, 60)})`))));
    if (r.body !== undefined) req.write(r.body);
    req.end();
  });
}

// ---------------------------------------------------------------- safe fetch

export type RedirectPolicy = "none" | "same-host" | "public";
export interface SafeInit {
  method?: string;
  headers?: Record<string, string> | Headers;
  body?: string;
  signal?: AbortSignal | null;
  /** none: a 3xx comes back as is. same-host: follow only inside the same host. public: follow to any host that passes the guard. Default same-host. */
  redirects?: RedirectPolicy;
}
export type SafeFetch = (input: string | URL, init?: SafeInit) => Promise<Response>;

export interface SafeFetchOptions {
  resolve?: Resolver;
  transport?: Transport;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

function headerRecord(h: SafeInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof (h as Headers).forEach === "function" && !(h instanceof Array)) { (h as Headers).forEach((v, k) => { out[k.toLowerCase()] = v; }); return out; }
  for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = String(v);
  return out;
}

export function createSafeFetch(o: SafeFetchOptions = {}): SafeFetch {
  const resolve = o.resolve ?? systemResolver;
  const transport = o.transport ?? createNodeTransport();
  const timeoutMs = o.timeoutMs ?? 15_000;
  const maxBytes = o.maxBytes ?? 1_000_000;
  const maxRedirects = o.maxRedirects ?? 3;
  return async (input, init = {}) => {
    let url = new URL(String(input));
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    let headers = headerRecord(init.headers);
    const policy = init.redirects ?? "same-host";
    const startHost = url.host;
    const deadline = Date.now() + timeoutMs;
    for (let hop = 0; ; hop++) {
      const pin = await resolvePublic(url, resolve); // https, no creds, public host, every DNS answer public
      const left = deadline - Date.now();
      if (left <= 0) throw new SsrfError("timed out");
      const raw = await transport({ url, ip: pin.address, family: pin.family, method, headers, body, timeoutMs: left, maxBytes, signal: init.signal ?? undefined });
      const loc = raw.headers["location"];
      const locStr = Array.isArray(loc) ? loc[0] : loc;
      if (raw.status >= 300 && raw.status < 400 && locStr && policy !== "none") {
        if (hop >= maxRedirects) throw new SsrfError("too many redirects");
        let next: URL;
        try { next = new URL(locStr, url); } catch { throw new SsrfError("the server sent a bad redirect"); }
        if (next.protocol !== "https:") throw new SsrfError("a redirect to a non-https URL was refused");
        if (policy === "same-host" && next.host !== startHost) throw new SsrfError(`a redirect to a different host (${next.hostname}) was refused`);
        if (next.host !== url.host) { delete headers["authorization"]; delete headers["cookie"]; }
        if (raw.status === 303 || ((raw.status === 301 || raw.status === 302) && method === "POST")) { method = "GET"; body = undefined; delete headers["content-type"]; }
        url = next;
        continue; // the next loop re-runs resolvePublic on the new URL
      }
      const h = new Headers();
      for (const [k, v] of Object.entries(raw.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      const nullBody = raw.status === 204 || raw.status === 205 || raw.status === 304;
      return new Response(nullBody ? null : new Uint8Array(raw.body), { status: raw.status >= 200 && raw.status <= 599 ? raw.status : 502, headers: h });
    }
  };
}
