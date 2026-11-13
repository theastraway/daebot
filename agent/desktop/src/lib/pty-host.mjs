// PTY sessions for the desktop app. This module loads only in Electron's main process.
// The gateway (bun-compiled) never imports it. node-pty is required lazily so unit tests
// can inject spawnPty and never touch the native module.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const SHELLS = new Set(["bash", "pwsh", "powershell.exe", "cmd.exe"]);
const MAX_BODY = 64 * 1024;
const MAX_BUFFER = 256 * 1024;

export function isLoopbackPeer(addr) {
  if (!addr) return false;
  const a = String(addr).toLowerCase().replace(/^::ffff:/, "");
  return a === "127.0.0.1" || a === "::1";
}

/** Options passed to node-pty. Windows asks for ConPTY. Unix leaves useConpty unset so forkpty is used. */
export function ptySpawnOptions(platform, cols = 80, rows = 24) {
  const opt = { name: "xterm-256color", cols, rows };
  if (platform === "win32") opt.useConpty = true;
  return opt;
}

function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function authed(req, token) {
  const h = req.headers?.authorization;
  if (typeof h !== "string") return false;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) return false;
  return safeEqual(m[1], token);
}

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isInteger(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (d) => {
      n += d.length;
      if (n > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(d);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

/**
 * @param {{ token: string, spawnPty?: Function, platform?: string }} opts
 * spawnPty(file, args, options) -> { pid, write, resize, onData, onExit, kill }
 */
export function createPtyHost(opts) {
  if (!opts || typeof opts.token !== "string" || opts.token.length < 8) throw new Error("pty host needs a token");
  const platform = opts.platform ?? process.platform;
  const spawnPty = opts.spawnPty;
  const sessions = new Map();

  function killSession(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try { s.pty.kill(); } catch { /* already gone */ }
    for (const res of s.streams) {
      try { res.end(); } catch { /* client left */ }
    }
    s.streams.clear();
  }

  async function handle(req, res) {
    const remote = req.socket?.remoteAddress;
    if (!isLoopbackPeer(remote)) { send(res, 403, { error: "forbidden" }); return; }
    if (!authed(req, opts.token)) { send(res, 401, { error: "unauthorized" }); return; }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method || "GET";
    if (path === "/health" && method === "GET") {
      send(res, 200, { ok: true, backend: "pty", typeable: true, platform, conpty: platform === "win32" });
      return;
    }
    if (path === "/sessions" && method === "POST") {
      let body;
      try { body = await readBody(req); } catch (e) { send(res, 400, { error: String(e?.message ?? e) }); return; }
      const id = typeof body.id === "string" && /^t\d{1,9}$/.test(body.id) ? body.id : "";
      const file = typeof body.file === "string" ? body.file : "";
      if (!id || sessions.has(id)) { send(res, 400, { error: "bad session id" }); return; }
      if (!SHELLS.has(file)) { send(res, 400, { error: "shell is not allowed" }); return; }
      if (!Array.isArray(body.args) || body.args.some((a) => typeof a !== "string" || a.length > 200)) { send(res, 400, { error: "bad args" }); return; }
      if (typeof body.cwd !== "string" || !body.cwd || body.cwd.length > 1000) { send(res, 400, { error: "bad cwd" }); return; }
      const cols = clamp(body.cols, 2, 500, 80);
      const rows = clamp(body.rows, 1, 200, 24);
      const env = {};
      if (body.env && typeof body.env === "object") {
        for (const [k, v] of Object.entries(body.env)) {
          if (typeof v !== "string" || v.length > 4000) continue;
          if (/(_KEY|_SECRET|TOKEN|PASSWORD|OPENROUTER|^MIND_|CREDENTIAL)/i.test(k)) continue;
          env[k] = v;
        }
      }
      if (!env.TERM) env.TERM = "xterm-256color";
      let pty;
      try {
        pty = spawnPty(file, body.args, { ...ptySpawnOptions(platform, cols, rows), cwd: body.cwd, env });
      } catch (e) {
        send(res, 500, { error: String(e?.message ?? e).slice(0, 180) });
        return;
      }
      const session = { pty, buffer: "", streams: new Set(), cols, rows };
      const push = (chunk) => {
        const text = String(chunk);
        if (!text) return;
        session.buffer += text;
        if (session.buffer.length > MAX_BUFFER) session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER);
        const frame = `event: data\ndata: ${JSON.stringify({ data: text })}\n\n`;
        for (const client of session.streams) {
          try { client.write(frame); } catch { /* drop a dead client */ }
        }
      };
      pty.onData(push);
      pty.onExit((ev) => {
        const code = typeof ev === "number" ? ev : (ev && typeof ev.exitCode === "number" ? ev.exitCode : null);
        const frame = `event: exit\ndata: ${JSON.stringify({ code })}\n\n`;
        for (const client of session.streams) {
          try { client.write(frame); client.end(); } catch { /* client left */ }
        }
        session.streams.clear();
        sessions.delete(id);
      });
      sessions.set(id, session);
      send(res, 200, { pid: pty.pid });
      return;
    }
    const one = /^\/sessions\/(t\d{1,9})(?:\/(write|resize|kill|stream))?$/.exec(path);
    if (!one) { send(res, 404, { error: "not found" }); return; }
    const id = one[1];
    const action = one[2] || "";
    const session = sessions.get(id);
    if (!session) { send(res, 404, { error: "no such session" }); return; }
    if (action === "stream" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      // Add the client before the snapshot write. onData cannot run mid-stack, so a chunk is either
      // already in the buffer (replayed here) or arrives later and is written live. Never both.
      session.streams.add(res);
      res.on("close", () => session.streams.delete(res));
      if (session.buffer) res.write(`event: data\ndata: ${JSON.stringify({ data: session.buffer })}\n\n`);
      return;
    }
    if (method !== "POST") { send(res, 405, { error: "method not allowed" }); return; }
    let body = {};
    if (action !== "kill") {
      try { body = await readBody(req); } catch (e) { send(res, 400, { error: String(e?.message ?? e) }); return; }
    }
    if (action === "write") {
      if (typeof body.data !== "string") { send(res, 400, { error: "data must be a string" }); return; }
      if (body.data.length > 8000) { send(res, 400, { error: "data is too long" }); return; }
      try { session.pty.write(body.data); } catch { send(res, 409, { error: "session is closed" }); return; }
      send(res, 200, { ok: true, bytes: body.data.length });
      return;
    }
    if (action === "resize") {
      const cols = clamp(body.cols, 2, 500, 0);
      const rows = clamp(body.rows, 1, 200, 0);
      if (!cols || !rows) { send(res, 400, { error: "cols and rows are required" }); return; }
      try { session.pty.resize(cols, rows); } catch { send(res, 409, { error: "session is closed" }); return; }
      session.cols = cols;
      session.rows = rows;
      send(res, 200, { ok: true, cols, rows });
      return;
    }
    if (action === "kill") {
      killSession(id);
      send(res, 200, { ok: true });
      return;
    }
    send(res, 404, { error: "not found" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) { try { res.end(); } catch { /* already writing */ } return; }
      send(res, 500, { error: String(e?.message ?? e).slice(0, 180) });
    });
  });

  return {
    handle,
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : 0;
    },
    closeAll() {
      for (const id of [...sessions.keys()]) killSession(id);
    },
    close() {
      this.closeAll();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Load node-pty from the desktop app's node_modules. Call only from Electron main. */
export function loadNodePty() {
  const require = createRequire(import.meta.url);
  return require("node-pty");
}

/**
 * Start the loopback host. Tests pass spawnPty. Production omits it and loads node-pty.
 * @returns {Promise<{ port: number, close: () => Promise<void>, closeAll: () => void }>}
 */
export async function startPtyHost(opts) {
  const spawnPty = opts.spawnPty ?? loadNodePty().spawn;
  const host = createPtyHost({ ...opts, spawnPty });
  const port = await host.listen();
  return { port, close: () => host.close(), closeAll: () => host.closeAll(), handle: host.handle };
}
