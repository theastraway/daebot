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
  async json<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
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

  /** POST that answers with a server-sent-event stream (one JSON object per `data:` line). Resolves when the stream ends; no overall timeout (a turn can run long), only `signal`. */
  async sse(path: string, body: unknown, onData: (obj: unknown) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.f(this.base + path, { method: "POST", headers: { "x-mind-key": this.key, accept: "text/event-stream", "content-type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text.slice(0, 200);
      try { const j = JSON.parse(text); if (typeof j?.error === "string") msg = j.error; } catch { /* not JSON */ }
      throw new SyncHttpError(res.status, msg || `HTTP ${res.status}`);
    }
    const reader = res.body?.getReader();
    if (!reader) return;
    const dec = new TextDecoder();
    let buf = "";
    const flushBlock = (block: string): void => {
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (!data) return;
      try { onData(JSON.parse(data)); } catch { /* a malformed frame is skipped */ }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) { flushBlock(buf.slice(0, i)); buf = buf.slice(i + 2); }
      if (done) break;
    }
    if (buf.trim()) flushBlock(buf);
  }
}
