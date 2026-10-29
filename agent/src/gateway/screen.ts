// Local-only routes the desktop shell uses to feed the screen ring buffer (see screen/feed.ts):
//   GET  /screen/state   what the feed is doing
//   PUT  /screen/state   {watching, permission, fps, error?}  the shell reports the user's switch and the OS permission
//   POST /screen/frame   one JPEG (the body), meta in the query: w h sw sh cx cy sig (base64url of SIG_LEN luma bytes)
// All need the gateway token like every other API route. The hosted deployment never mounts them (404), so a public server cannot be fed
// frames, and a frame is dropped unless the user's switch is on AND the OS permission is granted.
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_FRAME_BYTES, SIG_LEN } from "../screen/feed.ts";
import type { FeedState, ScreenFeed, ScreenPermission } from "../screen/feed.ts";

export interface ScreenDeps {
  readBody(req: IncomingMessage, limit?: number): Promise<Buffer>;
  readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
}

const int = (v: string | null, max = 20000): number | undefined => {
  if (v === null || !/^-?\d{1,6}$/.test(v)) return undefined;
  const n = Number(v);
  return Math.abs(n) <= max ? n : undefined;
};

/** Returns true when it handled the request. */
export async function screenApi(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, method: string, feed: ScreenFeed, d: ScreenDeps): Promise<void> {
  if (path === "/screen/state") {
    if (method === "GET") return d.sendJson(res, 200, feed.state());
    if (method !== "PUT") return d.sendJson(res, 405, { error: "method not allowed" });
    const b = await d.readJson(req);
    const patch: Partial<FeedState> = {};
    if (typeof b.watching === "boolean") patch.watching = b.watching;
    if (typeof b.permission === "string") patch.permission = b.permission as ScreenPermission;
    if (typeof b.fps === "number") patch.fps = b.fps;
    if (typeof b.bufferSeconds === "number") patch.bufferSeconds = b.bufferSeconds;
    if ("error" in b) patch.error = typeof b.error === "string" ? b.error : undefined;
    return d.sendJson(res, 200, feed.setState(patch));
  }
  if (path === "/screen/frame") {
    if (method !== "POST") return d.sendJson(res, 405, { error: "method not allowed" });
    const body = await d.readBody(req, MAX_FRAME_BYTES);
    if (!feed.active()) return d.sendJson(res, 409, { error: "screen watching is off", ...feed.state() });
    if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) return d.sendJson(res, 400, { error: "body must be a JPEG" });
    const width = int(query.get("w")), height = int(query.get("h"));
    const screenWidth = int(query.get("sw")), screenHeight = int(query.get("sh"));
    const cursorX = int(query.get("cx")) ?? 0, cursorY = int(query.get("cy")) ?? 0;
    if (!width || !height || width < 1 || height < 1 || !screenWidth || !screenHeight) return d.sendJson(res, 400, { error: "w, h, sw and sh are required" });
    const sig = Buffer.from(query.get("sig") ?? "", "base64url");
    if (sig.length !== SIG_LEN) return d.sendJson(res, 400, { error: `sig must be ${SIG_LEN} bytes (base64url)` });
    const ok = feed.ingest({ jpeg: body, width, height, screenWidth, screenHeight, cursorX, cursorY, sig: new Uint8Array(sig) });
    return ok ? void (res.writeHead(204, { "cache-control": "no-store" }), res.end()) : d.sendJson(res, 400, { error: "frame rejected" });
  }
  return d.sendJson(res, 404, { error: "not found" });
}
