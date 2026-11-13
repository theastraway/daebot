// Local browser channel and the chat pane's read API.
//
// Desktop → gateway (Authorization: Bearer, the same token as POST /screen/frame):
//   GET  /browser/poll?waitMs=20000     long-poll; { commands: [{ id, op, args }] } or { commands: [] }
//   POST /browser/result                { id, ok, result?, error? }
//   POST /browser/state                 { tabs, pane, gatewayOrigin, notice? }
// The gateway queues work; it does not open a debugging port. See src/browser/bridge.ts.
//
// Owner's web UI (same session auth as the terminal pane; a shared-thread guest is 403):
//   GET  /sessions/:id/browser
//   GET  /sessions/:id/browser/stream   SSE
//   POST /sessions/:id/browser/control  { action: "take" | "give", tab? }
//   POST /sessions/:id/browser/pane     { open?, width? }
//
// POST /browser/shots exists only when DAEBOT_BROWSER_SHOTS=1 (the dev Xvfb harness). It runs the
// browser tool, and it stops before a click the danger gate would hold for the user's go.
// Hosted never mounts any of these: 404.

import type { IncomingMessage, ServerResponse } from "node:http";
import { dangerGate } from "../kernel/danger.ts";
import { effectiveClass } from "../tool-class.ts";
import type { TurnState } from "../types.ts";
import type { BrowserBridge } from "../browser/bridge.ts";
import { elementForCall } from "../browser/live.ts";
import { bridgeHost, createBrowserTool } from "../tools/browser.ts";

export type SessionAccess = "ok" | "forbidden" | "missing";

export interface BrowserCtx {
  hosted: boolean;
  viewer: boolean;
  bridge: BrowserBridge;
  access(sessionId: string): SessionAccess;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
  heartbeatMs?: number;
  /** Dev-only. The Xvfb harness sets DAEBOT_BROWSER_SHOTS=1. */
  shots?: boolean;
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

const SESSION_RE = /^\/sessions\/([^/]+)\/browser$/;
const STREAM_RE = /^\/sessions\/([^/]+)\/browser\/stream$/;
const CONTROL_RE = /^\/sessions\/([^/]+)\/browser\/control$/;
const PANE_RE = /^\/sessions\/([^/]+)\/browser\/pane$/;

export function isBrowserPath(path: string): boolean {
  return path === "/browser/poll" || path === "/browser/result" || path === "/browser/state" || path === "/browser/shots" || /^\/sessions\/[^/]+\/browser(?:\/|$)/.test(path);
}

function decodeSeg(v: string): string | undefined {
  try { return decodeURIComponent(v); } catch { return undefined; }
}

/** Returns true when the path belongs to the browser and a response has been sent (or an SSE stream is open). */
export async function browserApi(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, method: string, ctx: BrowserCtx): Promise<boolean> {
  if (!isBrowserPath(path)) return false;

  if (path === "/browser/poll" || path === "/browser/result" || path === "/browser/state" || path === "/browser/shots") {
    if (ctx.hosted) { ctx.sendJson(res, 404, { error: "not found" }); return true; }
    if (path === "/browser/shots") return shots(req, res, method, ctx);
    if (path === "/browser/poll") return poll(res, query, method, ctx);
    if (path === "/browser/result") return commandResult(req, res, method, ctx);
    return pushState(req, res, method, ctx);
  }

  const stream = STREAM_RE.exec(path);
  const control = CONTROL_RE.exec(path);
  const pane = PANE_RE.exec(path);
  const one = stream || control || pane ? null : SESSION_RE.exec(path);
  const hit = stream ?? control ?? pane ?? one;
  if (!hit) { ctx.sendJson(res, 404, { error: "not found" }); return true; }
  const sessionId = decodeSeg(hit[1]);
  if (!sessionId) { ctx.sendJson(res, 400, { error: "bad id" }); return true; }

  // A guest is refused before the hosted 404, matching the terminal pane: a viewer is 403, hosted is 404.
  if (ctx.viewer) {
    ctx.sendJson(res, 403, { error: "forbidden", message: "The browser pane is only visible to the owner of this chat." });
    return true;
  }
  const acc = ctx.access(sessionId);
  if (acc === "forbidden") {
    ctx.sendJson(res, 403, { error: "forbidden", message: "The browser pane is only visible to the owner of this chat." });
    return true;
  }
  if (ctx.hosted) { ctx.sendJson(res, 404, { error: "not found" }); return true; }
  if (acc === "missing") { ctx.sendJson(res, 404, { error: "no such session" }); return true; }

  if (stream) return streamState(res, method, ctx);
  if (control) return setControl(req, res, method, ctx);
  if (pane) return setPane(req, res, method, ctx);
  if (method !== "GET") { ctx.sendJson(res, 405, { error: "method not allowed" }); return true; }
  ctx.sendJson(res, 200, publicState(ctx));
  return true;
}

function publicState(ctx: BrowserCtx): Record<string, unknown> {
  return { ...ctx.bridge.snapshot(), connected: ctx.bridge.connected() };
}

function poll(res: ServerResponse, query: URLSearchParams, method: string, ctx: BrowserCtx): boolean {
  if (method !== "GET") { ctx.sendJson(res, 405, { error: "method not allowed" }); return true; }
  const raw = query.get("waitMs");
  const waitMs = raw === null || raw === "" ? 0 : (/^\d{1,5}$/.test(raw) ? Number(raw) : NaN);
  if (!Number.isFinite(waitMs)) { ctx.sendJson(res, 400, { error: "waitMs must be a number of milliseconds" }); return true; }
  void ctx.bridge.poll(waitMs).then((body) => {
    if (!res.writableEnded) ctx.sendJson(res, 200, body);
  });
  return true;
}

async function commandResult(req: IncomingMessage, res: ServerResponse, method: string, ctx: BrowserCtx): Promise<boolean> {
  if (method !== "POST") { ctx.sendJson(res, 405, { error: "method not allowed" }); return true; }
  const b = await ctx.readJson(req);
  const id = typeof b.id === "string" ? b.id : "";
  if (!id) { ctx.sendJson(res, 400, { error: "id is required" }); return true; }
  const ok = b.ok !== false;
  const accepted = ctx.bridge.result(id, { ok, result: b.result, error: typeof b.error === "string" ? b.error.slice(0, 300) : undefined });
  ctx.sendJson(res, accepted ? 200 : 404, accepted ? { ok: true } : { error: "unknown command" });
  return true;
}

async function pushState(req: IncomingMessage, res: ServerResponse, method: string, ctx: BrowserCtx): Promise<boolean> {
  if (method !== "POST") { ctx.sendJson(res, 405, { error: "method not allowed" }); return true; }
  const b = await ctx.readJson(req);
  const snap = ctx.bridge.pushState(b as Parameters<BrowserBridge["pushState"]>[0]);
  ctx.sendJson(res, 200, snap);
  return true;
}

function streamState(res: ServerResponse, method: string, ctx: BrowserCtx): boolean {
  if (method !== "GET") { ctx.sendJson(res, 405, { error: "method not allowed" }); return true; }
  res.writeHead(200, SSE_HEADERS);
  res.write(": open\n\n");
  const write = () => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: state\ndata: ${JSON.stringify(publicState(ctx))}\n\n`);
  };
  write();
  const unsub = ctx.bridge.subscribe(write);
  const hb = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n"); }, ctx.heartbeatMs ?? HEARTBEAT_MS);
  hb.unref?.();
  res.on("close", () => { clearInterval(hb); unsub(); });
  return true;
}

async function setControl(req: IncomingMessage, res: ServerResponse, method: string, ctx: BrowserCtx): Promise<boolean> {
  if (method !== "POST") { ctx.sendJson(res, 405, { error: "method not allowed" }); return true; }
  const b = await ctx.readJson(req);
  const action = b.action === "take" ? "user" : b.action === "give" ? "agent" : "";
  if (!action) { ctx.sendJson(res, 400, { error: "action must be take or give" }); return true; }
  const tab = typeof b.tab === "string" ? b.tab : undefined;
  const cur = ctx.bridge.snapshot();
  const tabs = cur.tabs.map((t) => (!tab || t.id === tab ? { ...t, control: action as "user" | "agent" } : t));
  ctx.bridge.pushState({ tabs });
  if (ctx.bridge.connected()) {
    // Short wait: the snapshot above is already what the tool reads. A full call timeout would freeze the pane button
    // whenever the desktop is merely recently seen and not sitting in poll.
    try { await ctx.bridge.call("setControl", { tabId: tab ?? "", control: action }, 2000); } catch { /* the snapshot already shows who has control */ }
  }
  ctx.sendJson(res, 200, publicState(ctx));
  return true;
}

async function setPane(req: IncomingMessage, res: ServerResponse, method: string, ctx: BrowserCtx): Promise<boolean> {
  if (method !== "POST") { ctx.sendJson(res, 405, { error: "method not allowed" }); return true; }
  const b = await ctx.readJson(req);
  const pane: { open?: boolean; width?: number } = {};
  if (typeof b.open === "boolean") pane.open = b.open;
  if (typeof b.width === "number") pane.width = b.width;
  const snap = ctx.bridge.pushState({ pane: { open: pane.open ?? ctx.bridge.snapshot().pane.open, width: pane.width ?? ctx.bridge.snapshot().pane.width } });
  if (ctx.bridge.connected()) {
    try { await ctx.bridge.call("pane", { open: snap.pane.open, width: snap.pane.width }, 2000); } catch { /* the web UI still has the size */ }
  }
  ctx.sendJson(res, 200, publicState(ctx));
  return true;
}

async function shots(req: IncomingMessage, res: ServerResponse, method: string, ctx: BrowserCtx): Promise<boolean> {
  if (!ctx.shots && process.env.DAEBOT_BROWSER_SHOTS !== "1") { ctx.sendJson(res, 404, { error: "not found" }); return true; }
  if (method !== "POST") { ctx.sendJson(res, 405, { error: "method not allowed" }); return true; }
  const args = await ctx.readJson(req);
  const tool = createBrowserTool(bridgeHost(ctx.bridge));
  const cls = effectiveClass(tool, args);
  if (cls === "outward" || cls === "irreversible" || cls === "public") {
    const state: TurnState = {
      sessionId: "shots", booted: true, turnIndex: 1, userMessage: "shots", userMessageIndex: 1,
      calls: [], allCalls: [], confirmations: [], shadow: false,
    };
    const verdict = dangerGate.preTool!(state, { id: "shots", name: "browser", args }, tool);
    if (verdict && verdict.action === "needs-confirmation") {
      const el = elementForCall(args);
      const name = `${el?.name || el?.text || ""}`.replace(/\s+/g, " ").trim();
      ctx.bridge.notice({ kind: "approval", text: name ? `${name} needs your go` : verdict.reason });
      ctx.sendJson(res, 200, { ok: false, blocked: true, class: cls, reason: verdict.reason });
      return true;
    }
  }
  const result = await tool.run(args, { cwd: "/", sessionId: "shots" });
  ctx.sendJson(res, 200, { ...result, class: cls });
  return true;
}
