// MIND is reachable at two public addresses that sit behind different web edges: the API service itself
// (mindapp.onrender.com, Render's CDN) and the public site (m-i-n-d.ai, which proxies /developer/v1 to the same
// service). Either edge can answer a desktop with an HTML block page (HTTP 403 challenge) for one network while the
// other lets it through: 0.3.24 moved off m-i-n-d.ai for that reason, and on 2026-11-05 a Windows desktop got
// "MIND could not be reached (HTTP 403 from the web edge)" from mindapp.onrender.com while every other client passed.
// This wrapper retries such a request once on the other address and remembers the one that worked for the session.

const PAIRS: Record<string, string> = {
  "mindapp.onrender.com": "m-i-n-d.ai",
  "m-i-n-d.ai": "mindapp.onrender.com",
  "www.m-i-n-d.ai": "mindapp.onrender.com",
};

/** A response from a web edge rather than MIND: a 403/429/503 whose body is an HTML page. */
export function isEdgeBlock(res: Response): boolean {
  if (![403, 429, 503].includes(res.status)) return false;
  return /text\/html/i.test(res.headers.get("content-type") ?? "");
}

/** The same URL on the other MIND address, or undefined when the host is not a MIND address. */
export function alternateMindUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const alt = PAIRS[u.hostname.toLowerCase()];
    if (!alt) return undefined;
    u.hostname = alt;
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * Wrap fetch so a MIND call blocked by a web edge is retried once on the other MIND address. After a retry
 * succeeds, later calls go to the working address first (per wrapper instance). Non-MIND URLs pass through.
 * Bodies must be replayable (strings, as every MIND JSON call sends); a stream body is not retried.
 */
export function edgeFallbackFetch(base: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  const preferred = new Map<string, string>(); // blocked host -> host that worked
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) return base(input, init);
    const url = String(input);
    let host: string;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return base(input, init); }
    if (!PAIRS[host]) return base(input, init);
    const pref = preferred.get(host);
    const first = pref ? url.replace(new URL(url).host, pref) : url;
    const res = await base(first, init);
    if (!isEdgeBlock(res)) return res;
    const replayable = init?.body === undefined || init?.body === null || typeof init.body === "string";
    const alt = alternateMindUrl(first);
    if (!alt || !replayable) return res;
    let second: Response;
    try { second = await base(alt, init); } catch { return res; }
    if (isEdgeBlock(second)) return res;
    preferred.set(host, new URL(alt).host);
    return second;
  };
  return wrapped as typeof fetch;
}
