import { request } from "node:http";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentSession, Runtime, Violation } from "../../src/types.ts";

export interface FakeOpts {
  script?: (msg: string, signal?: AbortSignal) => AsyncGenerator<AgentEvent>;
}

export function fakeRuntime(opts: FakeOpts = {}): Runtime & { closed: string[]; opened: number } {
  const closed: string[] = [];
  let n = 0;
  const rt = {
    closed,
    opened: 0,
    async openSession(o: { surface: string; title?: string; resumeId?: string }): Promise<AgentSession> {
      const id = o.resumeId ?? `sess-${++n}`;
      rt.opened++;
      const v: Violation[] = [{ at: 1, sessionId: id, gate: "receipt", action: "block", reason: "no receipt", enforced: true }];
      return {
        id,
        surface: o.surface,
        violations: () => v,
        close: async () => { closed.push(id); },
        send(msg: string, so?: { signal?: AbortSignal }) {
          return (opts.script ?? defaultScript)(msg, so?.signal);
        },
      };
    },
    listSessions: () => [],
  };
  return rt;
}

export async function* defaultScript(msg: string): AsyncGenerator<AgentEvent> {
  yield { type: "text", delta: "hello " };
  yield { type: "toolStart", receiptId: "c1", tool: "mind_query", args: { q: msg } };
  yield { type: "toolEnd", receiptId: "c1", tool: "mind_query", ok: true, preview: "ok" };
  yield { type: "gate", verdict: { gate: "receipt", action: "block", reason: "r" }, enforced: false };
  yield { type: "usage", usage: { promptTokens: 1, completionTokens: 2, costUsd: 0.01 }, totalCostUsd: 0.01 };
  yield { type: "done", finalText: "hello" };
}

export function waitAbort(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function tmpStatic(): { dir: string; outsideSecret: string } {
  const root = mkdtempSync(join(tmpdir(), "mc-static-"));
  const dir = join(root, "web");
  mkdirSync(dir);
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(dir, "app.js"), "export {}");
  writeFileSync(join(dir, "style.css"), "body{}");
  writeFileSync(join(dir, ".secret"), "nope");
  writeFileSync(join(dir, ".git", "config"), "nope");
  writeFileSync(join(root, "package.json"), '{"secret":true}');
  return { dir, outsideSecret: join(root, "package.json") };
}

export interface Resp { status: number; headers: Record<string, string | string[] | undefined>; body: string }

export function http(base: string, method: string, path: string, o: { headers?: Record<string, string>; body?: unknown; onChunk?: (s: string) => void } = {}): Promise<Resp> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
    const req = request(
      { host: u.hostname, port: u.port, method, path, headers: { ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}), ...(o.headers ?? {}) } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => { body += c; o.onChunk?.(c); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

export function parseSse(body: string): AgentEvent[] {
  return body.split("\n\n").map((c) => c.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")).filter(Boolean).map((d) => JSON.parse(d) as AgentEvent);
}

// ---- raw WebSocket test client ----
export function maskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = randomBytes(4);
  let head: Buffer;
  const len = payload.length;
  if (len < 126) head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = (fin ? 0x80 : 0) | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

export interface WsClient {
  socket: Socket;
  status: number;
  frames: { opcode: number; payload: Buffer }[];
  waitFor(pred: (f: { opcode: number; payload: Buffer }) => boolean, ms?: number): Promise<{ opcode: number; payload: Buffer }>;
  sendText(s: string): void;
  close(): void;
}

export function wsConnect(base: string, path: string, headers: Record<string, string> = {}): Promise<WsClient> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: u.hostname, port: Number(u.port) });
    const key = randomBytes(16).toString("base64");
    const hdrs = { Host: `${u.hostname}:${u.port}`, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13", ...headers };
    socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    let handshook = false;
    const frames: WsClient["frames"] = [];
    const waiters: { pred: (f: { opcode: number; payload: Buffer }) => boolean; res: (f: { opcode: number; payload: Buffer }) => void }[] = [];
    const client: WsClient = {
      socket, status: 0, frames,
      waitFor(pred, ms = 3000) {
        const hit = frames.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error("ws waitFor timeout")), ms);
          waiters.push({ pred, res: (f) => { clearTimeout(t); res(f); } });
        });
      },
      sendText: (s) => void socket.write(maskedFrame(0x1, Buffer.from(s))),
      close: () => void socket.destroy(),
    };
    socket.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (!handshook) {
        const i = buf.indexOf("\r\n\r\n");
        if (i === -1) return;
        const head = buf.subarray(0, i).toString();
        client.status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]);
        buf = buf.subarray(i + 4);
        handshook = true;
        if (client.status === 101) {
          const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
          const expect = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          if (accept !== expect) return reject(new Error("bad accept key"));
        }
        resolve(client);
      }
      for (;;) {
        if (buf.length < 2) break;
        const opcode = buf[0] & 0x0f; let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const f = { opcode, payload: Buffer.from(buf.subarray(off, off + len)) };
        buf = buf.subarray(off + len);
        frames.push(f);
        for (let k = waiters.length - 1; k >= 0; k--) if (waiters[k].pred(f)) waiters.splice(k, 1)[0].res(f);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => { if (!handshook) reject(new Error("closed before handshake")); });
  });
}
