// MIND Voice for Daebot: POST /voice/stt (speech to text) and POST /voice/tts (text to speech).
// Both forward to MIND's metered audio endpoints with the SIGNED-IN USER'S OWN MIND key, so voice is billed to that user's MIND
// credits exactly like their model calls. The owner access-code login uses the server MIND_API_KEY. A user's key never leaves
// this process except as the X-API-Key of the call to MIND; it is never logged or echoed.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../auth/users.ts";

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // one push-to-talk utterance; MIND itself allows 25 MB
export const MAX_TTS_CHARS = 3000;               // MIND allows 4000
export const STT_PER_MIN = 20;
export const TTS_PER_MIN = 30;
export const MAX_INFLIGHT = 2;                   // concurrent voice calls per principal
const WINDOW_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 60_000;

export interface VoiceOptions {
  /** MIND API base, e.g. https://m-i-n-d.ai/developer/v1 */
  baseUrl: string;
  /** The MIND key a principal's calls are billed to; undefined = voice unavailable for them. */
  keyFor(p: Principal): string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Called with the key after a successful call so the credits chip can refresh. */
  onUsed?(key: string): void;
}

class Limiter {
  private hits = new Map<string, number[]>();
  private inflight = new Map<string, number>();
  private now: () => number;
  constructor(now: () => number) { this.now = now; }
  /** Seconds to wait, or 0 when the call may proceed (and is counted). */
  take(id: string, kind: string, max: number): number {
    const k = `${kind}:${id}`;
    const t = this.now();
    const live = (this.hits.get(k) ?? []).filter((x) => t - x < WINDOW_MS);
    if (live.length >= max) { this.hits.set(k, live); return Math.max(1, Math.ceil((WINDOW_MS - (t - live[0])) / 1000)); }
    live.push(t);
    this.hits.set(k, live);
    return 0;
  }
  enter(id: string): boolean {
    const n = this.inflight.get(id) ?? 0;
    if (n >= MAX_INFLIGHT) return false;
    this.inflight.set(id, n + 1);
    return true;
  }
  leave(id: string): void {
    const n = (this.inflight.get(id) ?? 1) - 1;
    if (n <= 0) this.inflight.delete(id); else this.inflight.set(id, n);
  }
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(data)), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...extra });
  res.end(data);
}

async function readCapped(req: IncomingMessage, max: number): Promise<Buffer | "too_large"> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max) { req.resume(); return "too_large"; }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) { resolve("too_large"); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** audio/webm;codecs=opus -> webm. Only formats MediaRecorder produces (and wav) are accepted. */
export function audioExt(contentType: string | undefined): string | undefined {
  const t = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return ({ "audio/webm": "webm", "video/webm": "webm", "audio/mp4": "mp4", "video/mp4": "mp4", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3" } as Record<string, string>)[t];
}

/** Maps a MIND refusal/failure to what the browser sees. Never forwards MIND's raw body. */
function mapError(status: number, body: string): { status: number; body: Record<string, unknown> } {
  let j: any;
  try { j = JSON.parse(body); } catch { /* not json */ }
  if (status === 402) return { status: 402, body: { error: "insufficient_credits", message: typeof j?.message === "string" ? j.message.slice(0, 300) : "Not enough MIND credits for voice.", upgradeUrl: typeof j?.upgrade_url === "string" ? j.upgrade_url : undefined } };
  if (status === 401 || status === 403) return { status: 401, body: { error: "mind_key_rejected", message: "Your MIND key was not accepted for voice. Sign in again." } };
  if (status === 404) return { status: 503, body: { error: "voice_unavailable", message: "MIND voice is not switched on yet." } };
  if (status === 413) return { status: 413, body: { error: "too_large" } };
  if (status === 503) return { status: 503, body: { error: "voice_unavailable", message: "MIND voice is temporarily unavailable." } };
  return { status: 502, body: { error: "voice_failed", message: "The voice service could not finish that request." } };
}

export function createVoiceHandler(o: VoiceOptions): (req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, p: Principal) => Promise<void> {
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.baseUrl.replace(/\/+$/, "");
  const limiter = new Limiter(o.now ?? Date.now);

  return async (req, res, path, query, p) => {
    const isStt = path === "/voice/stt";
    const isTts = path === "/voice/tts";
    if (!isStt && !isTts) return json(res, 404, { error: "not found" });
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const key = o.keyFor(p);
    if (!key) { req.resume(); return json(res, 503, { error: "voice_unavailable", message: "Voice needs a MIND key. Sign in with your MIND account." }); }
    const wait = limiter.take(p.id, isStt ? "stt" : "tts", isStt ? STT_PER_MIN : TTS_PER_MIN);
    if (wait > 0) { req.resume(); return json(res, 429, { error: "slow_down", message: "Too many voice requests. Try again shortly." }, { "retry-after": String(wait) }); }
    if (!limiter.enter(p.id)) { req.resume(); return json(res, 429, { error: "slow_down", message: "Another voice request is still running." }, { "retry-after": "2" }); }
    try {
      let upstream: Response;
      if (isStt) {
        const ext = audioExt(req.headers["content-type"] as string | undefined);
        if (!ext) { req.resume(); return json(res, 415, { error: "unsupported_audio", message: "Send the recording as audio/webm, mp4, ogg or wav." }); }
        const buf = await readCapped(req, MAX_AUDIO_BYTES);
        if (buf === "too_large") return json(res, 413, { error: "too_large", message: "That recording is too long. Keep it under about a minute." });
        if (buf.length < 200) return json(res, 400, { error: "empty_audio", message: "No audio was captured." });
        const fd = new FormData();
        fd.append("file", new Blob([new Uint8Array(buf)], { type: (req.headers["content-type"] as string).split(";")[0] }), `speech.${ext}`);
        const lang = query.get("lang");
        if (lang && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang)) fd.append("language", lang);
        upstream = await f(`${base}/audio/transcriptions`, { method: "POST", headers: { "X-API-Key": key }, body: fd, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      } else {
        const raw = await readCapped(req, 64 * 1024);
        if (raw === "too_large") return json(res, 413, { error: "too_large" });
        let b: any;
        try { b = JSON.parse(raw.toString("utf8") || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
        const text = typeof b?.text === "string" ? b.text.trim() : "";
        if (!text) return json(res, 400, { error: "text required" });
        if (text.length > MAX_TTS_CHARS) return json(res, 413, { error: "too_large", message: `Speak at most ${MAX_TTS_CHARS} characters at a time.` });
        upstream = await f(`${base}/audio/speech`, { method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ input: text }), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      }
      if (!upstream.ok) {
        const m = mapError(upstream.status, await upstream.text().catch(() => ""));
        return json(res, m.status, m.body);
      }
      const used = upstream.headers.get("x-mind-credits-used") ?? "";
      const extra: Record<string, string> = /^[0-9.]{1,12}$/.test(used) ? { "x-mind-credits-used": used } : {};
      o.onUsed?.(key);
      if (isStt) {
        const j = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
        return json(res, 200, { text: typeof j.text === "string" ? j.text : "", duration: typeof j.duration === "number" ? j.duration : null }, extra);
      }
      const audio = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(audio.length), "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...extra });
      return void res.end(audio);
    } catch (e) {
      if (!res.headersSent) return json(res, 502, { error: "voice_failed", message: e instanceof Error && e.name === "TimeoutError" ? "The voice service timed out." : "The voice service could not be reached." });
      res.end();
    } finally {
      limiter.leave(p.id);
    }
  };
}
