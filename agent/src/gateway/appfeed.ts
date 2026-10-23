// Update feeds for the native apps and the web client, served from daebot.live so the page's CSP (connect-src 'self') never has to
// allow another origin. The Android feed lives on download.m-i-n-d.ai next to the APK; this module relays it with a short cache.
import type { ServerResponse } from "node:http";

const FEED_HOST = "https://download.m-i-n-d.ai/";
const ANDROID_FEED = `${FEED_HOST}download/daebot/android-latest.json`;
const ANDROID_STABLE = `${FEED_HOST}download/daebot/Daebot.apk`;
const TTL_MS = 5 * 60_000;

/** Short id of the running deploy; the web client compares it to the one it loaded with and offers a refresh when it changes. */
export function buildId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DAEBOT_BUILD || env.RENDER_GIT_COMMIT || env.SOURCE_VERSION || "dev";
  return raw.slice(0, 12);
}

export interface AndroidFeed { version: string; versionCode: number; url: string; sha256: string; size: number; releasedAt?: string; notes?: string }

/** Returns the feed only when it is well formed and every link stays on the download host. Anything else is rejected. */
export function validateAndroidFeed(x: unknown): AndroidFeed | null {
  if (!x || typeof x !== "object") return null;
  const f = x as Record<string, unknown>;
  if (typeof f.version !== "string" || !/^\d+(\.\d+){1,3}$/.test(f.version)) return null;
  if (typeof f.versionCode !== "number" || !Number.isInteger(f.versionCode) || f.versionCode < 1) return null;
  if (typeof f.url !== "string" || !f.url.startsWith(FEED_HOST)) return null;
  if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(f.sha256)) return null;
  if (typeof f.size !== "number" || !(f.size > 0)) return null;
  return {
    version: f.version, versionCode: f.versionCode, url: f.url, sha256: f.sha256.toLowerCase(), size: f.size,
    releasedAt: typeof f.releasedAt === "string" ? f.releasedAt : undefined,
    notes: typeof f.notes === "string" ? f.notes.slice(0, 400) : undefined,
  };
}

let cache: { at: number; feed: AndroidFeed } | null = null;

async function androidFeed(fetchImpl: typeof fetch, now: number): Promise<AndroidFeed | null> {
  if (cache && now - cache.at < TTL_MS) return cache.feed;
  try {
    const r = await fetchImpl(ANDROID_FEED, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
    if (!r.ok) return cache?.feed ?? null;
    const feed = validateAndroidFeed(await r.json());
    if (!feed) return cache?.feed ?? null;
    cache = { at: now, feed };
    return feed;
  } catch {
    return cache?.feed ?? null;
  }
}

/** Handles /download/android-latest.json and /download/Daebot.apk. Returns true when it answered. */
export async function handleAppFeed(path: string, method: string, res: ServerResponse, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<boolean> {
  if (path !== "/download/android-latest.json" && path !== "/download/Daebot.apk") return false;
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json", allow: "GET, HEAD" });
    res.end('{"error":"method not allowed"}');
    return true;
  }
  if (path === "/download/Daebot.apk") {
    res.writeHead(302, { location: ANDROID_STABLE, "cache-control": "no-store" });
    res.end();
    return true;
  }
  const feed = await androidFeed(fetchImpl, now);
  if (!feed) {
    res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    res.end('{"error":"android feed unavailable"}');
    return true;
  }
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60", "access-control-allow-origin": "*" });
  res.end(method === "HEAD" ? undefined : JSON.stringify(feed));
  return true;
}

export function resetAppFeedCache(): void { cache = null; }
