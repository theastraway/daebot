// Local pane for the iOS Simulator: device picker actions, a screenshot stream, a clip.
// A shared-thread guest is refused. The hosted deployment never mounts these routes.
// When this machine cannot run a simulator, a boot/shutdown/record is handed to the paired Mac.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SimulatorService, SimulatorStatus } from "../devices/simulator-service.ts";

export type SessionAccess = "ok" | "forbidden" | "missing";

export interface SimulatorForward {
  (sessionId: string, action: string, args: Record<string, unknown>): Promise<{ ok: true; deviceName: string } | { ok: false; status: number; error: string }>;
}

export interface SimulatorCtx {
  hosted: boolean;
  viewer: boolean;
  access(sessionId: string): SessionAccess;
  service: SimulatorService;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
  /** Milliseconds between screenshots. Default 1000 (about 1 fps). */
  frameMs?: number;
  forward?: SimulatorForward;
}

const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const STATE_RE = /^\/sessions\/([^/]+)\/simulator$/;
const STREAM_RE = /^\/sessions\/([^/]+)\/simulator\/stream$/;
const FRAME_RE = /^\/sessions\/([^/]+)\/simulator\/frame$/;

export function isSimulatorPath(path: string): boolean {
  return /^\/sessions\/[^/]+\/simulator(?:\/|$)/.test(path);
}

function decodeSeg(v: string): string | undefined {
  try { return decodeURIComponent(v); } catch { return undefined; }
}

function writeEvent(res: ServerResponse, event: string, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
}

const PANE_ACTIONS = new Set(["boot", "shutdown", "record"]);

function selOf(body: Record<string, unknown>): { udid?: string; name?: string } {
  return {
    udid: typeof body.udid === "string" ? body.udid : undefined,
    name: typeof body.name === "string" ? body.name : undefined,
  };
}

/** Returns true when the path is a simulator route and the response has been sent or an SSE stream is open. */
export async function simulatorApi(req: IncomingMessage, res: ServerResponse, path: string, method: string, ctx: SimulatorCtx): Promise<boolean> {
  const stream = STREAM_RE.exec(path);
  const frame = FRAME_RE.exec(path);
  const state = STATE_RE.exec(path);
  const hit = stream ?? frame ?? state;
  if (!hit) return false;

  const sessionId = decodeSeg(hit[1]);
  if (!sessionId) {
    ctx.sendJson(res, 400, { error: "bad id" });
    return true;
  }
  if (ctx.viewer) {
    ctx.sendJson(res, 403, { error: "forbidden", message: "The iOS Simulator is only visible to the owner of this chat." });
    return true;
  }
  const acc = ctx.access(sessionId);
  if (acc === "forbidden") {
    ctx.sendJson(res, 403, { error: "forbidden", message: "The iOS Simulator is only visible to the owner of this chat." });
    return true;
  }
  if (ctx.hosted) {
    ctx.sendJson(res, 404, { error: "not found" });
    return true;
  }
  if (acc === "missing") {
    ctx.sendJson(res, 404, { error: "no such session" });
    return true;
  }

  if (stream || frame) {
    if (method !== "GET") {
      ctx.sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    if (frame) {
      await sendFrame(res, ctx);
      return true;
    }
    await streamShots(res, ctx);
    return true;
  }

  if (method === "GET") {
    ctx.sendJson(res, 200, await ctx.service.status());
    return true;
  }
  if (method !== "POST") {
    ctx.sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  const body = await ctx.readJson(req);
  const action = typeof body.action === "string" ? body.action : "";
  if (!PANE_ACTIONS.has(action)) {
    ctx.sendJson(res, 400, { error: "action must be boot, shutdown or record" });
    return true;
  }
  const st = await ctx.service.status();
  if (!st.available) {
    if (!ctx.forward) {
      ctx.sendJson(res, 409, { error: st.note });
      return true;
    }
    const args: Record<string, unknown> = { ...selOf(body) };
    if (action === "record") args.op = body.op === "stop" ? "stop" : "start";
    const routed = await ctx.forward(sessionId, action, args);
    if (!routed.ok) {
      ctx.sendJson(res, routed.status, { error: routed.error });
      return true;
    }
    ctx.sendJson(res, 200, {
      ok: true,
      routed: true,
      deviceName: routed.deviceName,
      note: `Sent to ${routed.deviceName}. The live picture stays on that Mac.`,
    });
    return true;
  }
  const sel = selOf(body);
  if (action === "boot") {
    const r = await ctx.service.boot(sel);
    if (!r.ok) { ctx.sendJson(res, 409, { error: r.error }); return true; }
  } else if (action === "shutdown") {
    const r = await ctx.service.shutdown(sel);
    if (!r.ok) { ctx.sendJson(res, 409, { error: r.error }); return true; }
  } else {
    const op = body.op === "stop" ? "stop" : "start";
    const r = await ctx.service.record(op, sel);
    if (!r.ok) { ctx.sendJson(res, 409, { error: r.error }); return true; }
  }
  const next = await ctx.service.status();
  ctx.sendJson(res, 200, { ok: true, ...next });
  return true;
}

async function sendFrame(res: ServerResponse, ctx: SimulatorCtx): Promise<void> {
  const shot = await ctx.service.screenshot();
  if (!shot.ok) {
    ctx.sendJson(res, 409, { error: shot.error });
    return;
  }
  res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(shot.jpeg);
}

async function streamShots(res: ServerResponse, ctx: SimulatorCtx): Promise<void> {
  const frameMs = Math.min(5000, Math.max(200, ctx.frameMs ?? 1000));
  res.writeHead(200, SSE_HEADERS);
  let closed = false;
  res.on("close", () => { closed = true; });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let first = true;
  while (!closed) {
    let st: SimulatorStatus;
    try { st = await ctx.service.status(); } catch (e) {
      writeEvent(res, "status", { available: false, note: String((e as Error)?.message ?? e).slice(0, 300) });
      break;
    }
    if (first) writeEvent(res, "snapshot", st);
    else writeEvent(res, "status", { available: st.available, note: st.note, recording: st.recording, selected: st.selected, fixture: st.fixture === true });
    first = false;
    if (st.available) {
      const shot = await ctx.service.screenshot();
      if (shot.ok && !closed) writeEvent(res, "frame", { udid: shot.udid, image: shot.jpeg.toString("base64") });
    }
    if (res.writableEnded || res.destroyed) break;
    await sleep(frameMs);
  }
  if (!res.writableEnded) res.end();
}
