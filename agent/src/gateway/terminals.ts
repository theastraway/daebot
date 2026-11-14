// Local-only read API for the terminal pane. The user can watch a shell the agent already opened.
// Nothing here writes to the shell: there is no POST. Output is a peek, so the agent's own `read` still sees every byte.
// A shared-thread guest is refused (the scrollback can contain secrets). The hosted deployment never mounts these routes.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TerminalRegistry } from "../tools/terminal.ts";

export type SessionAccess = "ok" | "forbidden" | "missing";

export interface TerminalCtx {
  hosted: boolean;
  /** The caller is a guest in someone else's thread. */
  viewer: boolean;
  access(sessionId: string): SessionAccess;
  registry: TerminalRegistry;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  /** Tests. Production heartbeats every 15s. */
  heartbeatMs?: number;
}

const HEARTBEAT_MS = 15_000;
const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const LIST_RE = /^\/sessions\/([^/]+)\/terminals$/;
const ONE_RE = /^\/sessions\/([^/]+)\/terminals\/([^/]+)$/;
const STREAM_RE = /^\/sessions\/([^/]+)\/terminals\/([^/]+)\/stream$/;

export function isTerminalPath(path: string): boolean {
  return /^\/sessions\/[^/]+\/terminals(?:\/|$)/.test(path);
}

function decodeSeg(v: string): string | undefined {
  try { return decodeURIComponent(v); } catch { return undefined; }
}

function fromOffset(query: URLSearchParams): number | undefined | "bad" {
  const raw = query.get("from");
  if (raw === null || raw === "") return undefined;
  if (!/^\d{1,15}$/.test(raw)) return "bad";
  return Number(raw);
}

/** Returns true when the path is a terminal route (and the response has been sent, or an SSE stream is open). */
export function terminalsApi(_req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, method: string, ctx: TerminalCtx): boolean {
  const list = LIST_RE.exec(path);
  const stream = STREAM_RE.exec(path);
  const one = stream ? null : ONE_RE.exec(path);
  const hit = list ?? stream ?? one;
  if (!hit) return false;

  const sessionId = decodeSeg(hit[1]);
  const termId = stream ? decodeSeg(stream[2]) : one ? decodeSeg(one[2]) : undefined;
  if (!sessionId || ((stream || one) && !termId)) {
    ctx.sendJson(res, 400, { error: "bad id" });
    return true;
  }
  // A guest is refused before the hosted 404, so a viewer is 403 and the owner's hosted deployment is 404.
  if (ctx.viewer) {
    ctx.sendJson(res, 403, { error: "forbidden", message: "Terminal output is only visible to the owner of this chat." });
    return true;
  }
  const acc = ctx.access(sessionId);
  if (acc === "forbidden") {
    ctx.sendJson(res, 403, { error: "forbidden", message: "Terminal output is only visible to the owner of this chat." });
    return true;
  }
  if (ctx.hosted) {
    ctx.sendJson(res, 404, { error: "not found" });
    return true;
  }
  if (method !== "GET") {
    ctx.sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  if (acc === "missing") {
    ctx.sendJson(res, 404, { error: "no such session" });
    return true;
  }

  const from = fromOffset(query);
  if (from === "bad") {
    ctx.sendJson(res, 400, { error: "from must be a byte offset" });
    return true;
  }

  if (list) {
    ctx.sendJson(res, 200, { terminals: ctx.registry.list(sessionId) });
    return true;
  }

  const tid = termId as string;
  let snap: ReturnType<TerminalRegistry["peek"]>;
  try {
    snap = ctx.registry.peek(sessionId, tid, from);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    ctx.sendJson(res, /unknown session/.test(msg) ? 404 : 500, { error: msg.split("\n")[0].slice(0, 300) });
    return true;
  }

  if (one) {
    ctx.sendJson(res, 200, snap);
    return true;
  }

  streamOne(res, ctx, sessionId, tid, snap);
  return true;
}

function eventChunk(event: string, body: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
}

function streamOne(res: ServerResponse, ctx: TerminalCtx, sessionId: string, tid: string, snap: ReturnType<TerminalRegistry["peek"]>): void {
  let cursor = snap.total;
  let status = snap.info.status;
  let unsub = (): void => {};
  let ended = false;
  const hbMs = ctx.heartbeatMs ?? HEARTBEAT_MS;
  let hb: NodeJS.Timeout | undefined;

  const end = (closeResponse: boolean): void => {
    if (ended) return;
    ended = true;
    unsub();
    if (hb) clearInterval(hb);
    hb = undefined;
    if (closeResponse && !res.writableEnded && !res.destroyed) {
      try { res.end(); } catch { /* the client already went away */ }
    }
  };

  // A failed write must not throw into the shell's data handler: that wake is shared with the agent's read.
  const writeRaw = (chunk: string): boolean => {
    if (ended || res.writableEnded || res.destroyed) return false;
    if (!res.writable) { end(true); return false; }
    try { res.write(chunk); return true; } catch { end(true); return false; }
  };

  const sendData = (p: ReturnType<TerminalRegistry["peek"]>): boolean => {
    if (!p.text && !(p.dropped > 0)) return true;
    return writeRaw(eventChunk("data", { text: p.text, total: p.total, dropped: p.dropped }));
  };

  // Subscribe before the snapshot is committed so a byte that arrives in between is still delivered.
  try {
    unsub = ctx.registry.subscribe(sessionId, tid, () => {
      try {
        if (ended) return;
        let p: ReturnType<TerminalRegistry["peek"]>;
        try { p = ctx.registry.peek(sessionId, tid, cursor); } catch { end(true); return; }
        if (!sendData(p)) return;
        cursor = p.total;
        if (p.info.status !== status) {
          status = p.info.status;
          if (!writeRaw(eventChunk("status", { status: p.info.status, exitCode: p.info.exitCode, info: p.info }))) return;
        }
        if (status !== "running") end(true);
      } catch { end(true); }
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    ctx.sendJson(res, /unknown session/.test(msg) ? 404 : 500, { error: msg.split("\n")[0].slice(0, 300) });
    return;
  }

  // Detach as soon as the socket dies, including a client that is already gone before the headers go out.
  // "close" covers the client hanging up and our own res.end(). (The request's "close" is the wrong signal: a GET
  // with no body completes as soon as the headers are in, which would drop the subscription immediately.)
  res.on("close", () => end(false));
  res.on("error", () => end(true));

  try { res.writeHead(200, SSE_HEADERS); } catch { end(true); return; }
  if (!writeRaw(": open\n\n")) return;
  if (!writeRaw(eventChunk("snapshot", snap))) return;
  if (snap.info.status !== "running") {
    if (!writeRaw(eventChunk("status", { status: snap.info.status, exitCode: snap.info.exitCode, info: snap.info }))) return;
    end(true);
    return;
  }
  // Catch output that landed after the peek the caller took and before subscribe.
  try {
    const again = ctx.registry.peek(sessionId, tid, cursor);
    if (!sendData(again)) return;
    cursor = again.total;
    if (again.info.status !== status) {
      status = again.info.status;
      if (!writeRaw(eventChunk("status", { status: again.info.status, exitCode: again.info.exitCode, info: again.info }))) return;
      if (status !== "running") { end(true); return; }
    }
  } catch { /* the subscribe wake handles a session that vanished */ }
  if (ended) return;

  hb = setInterval(() => { writeRaw(": ping\n\n"); }, hbMs);
  hb.unref();
}
