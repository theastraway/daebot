// Tiny JSON client for the device-to-daebot.live channel (session sync + remote bots). Header-authenticated with the user's own MIND key.
export class SyncHttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface SyncHttpOptions { baseUrl: string; key: string; fetchImpl?: typeof fetch; timeoutMs?: number }

export class SyncHttp {
  private base: string;
  private key: string;
  private f: typeof fetch;
  private timeoutMs: number;
  constructor(o: SyncHttpOptions) {
    this.base = o.baseUrl.replace(/\/+$/, "");
    this.key = o.key;
    this.f = o.fetchImpl ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 20_000;
  }
  get url(): string { return this.base; }
  async json<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    const res = await this.f(this.base + path, {
      method,
      headers: { "x-mind-key": this.key, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs ?? this.timeoutMs), signal]) : AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 200);
      try { const j = JSON.parse(text); if (typeof j?.error === "string") msg = j.error; } catch { /* not JSON */ }
      throw new SyncHttpError(res.status, msg || `HTTP ${res.status}`);
    }
    try { return JSON.parse(text) as T; } catch { throw new SyncHttpError(502, "bad JSON from the server"); }
  }
}
