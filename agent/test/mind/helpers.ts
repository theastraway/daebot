import type { Config } from "../../src/types.ts";

export const KEY = "mind_TESTKEY0123456789abcdef";

export function cfg(over: Partial<Config> = {}): Config {
  return {
    mindBaseUrl: "https://m-i-n-d.ai/developer/v1", mindApiKey: KEY, openrouterKey: "x",
    models: { default: "d", cheap: "c", fallback: [] }, shadow: false, kernel: true, maxToolRoundsPerTurn: 8, ...over,
  };
}

export interface Seen { url: string; method: string; headers: Record<string, string>; body: any }
type Handler = (req: Seen, n: number) => Response | Promise<Response> | { status: number; json?: unknown; text?: string } | "hang";

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function fakeFetch(handler: Handler): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (url: any, init: any = {}) => {
    const req: Seen = {
      url: String(url), method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    seen.push(req);
    const r = await handler(req, seen.length);
    if (r === "hang") {
      return new Promise((_res, rej) => init.signal?.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); }));
    }
    if (r instanceof Response) return r;
    const o = r as { status: number; json?: unknown; text?: string };
    return o.text !== undefined ? new Response(o.text, { status: o.status }) : json(o.status, o.json ?? {});
  }) as unknown as typeof fetch;
  return { fetch: f, seen };
}
