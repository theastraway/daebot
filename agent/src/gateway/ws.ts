// Minimal RFC 6455 server-side WebSocket: handshake, text frames, fragmentation, ping/pong, close.
// Written from the RFC; no third-party code.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(clientKey: string): string {
  return createHash("sha1").update(clientKey + GUID).digest("base64");
}

/** Validates the upgrade request and writes the 101 response. Returns null (after answering) on failure. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, maxMessage = 1 << 20): WsConnection | null {
  const key = req.headers["sec-websocket-key"];
  const version = req.headers["sec-websocket-version"];
  const upgrade = String(req.headers["upgrade"] ?? "").toLowerCase();
  if (upgrade !== "websocket" || typeof key !== "string" || Buffer.from(key, "base64").length !== 16 || version !== "13") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nSec-WebSocket-Version: 13\r\n\r\n");
    socket.destroy();
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  const conn = new WsConnection(socket, maxMessage);
  if (head && head.length) conn.feed(head);
  return conn;
}

export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Events: "message" (text: string), "close" (code: number), "error" (Error)
export class WsConnection extends EventEmitter {
  readonly socket: Duplex;
  alive = true;
  private buf: Buffer = Buffer.alloc(0);
  private frags: Buffer[] = [];
  private fragSize = 0;
  private fragOpcode = 0;
  private closed = false;
  private maxMessage: number;

  constructor(socket: Duplex, maxMessage: number) {
    super();
    this.socket = socket;
    this.maxMessage = maxMessage;
    socket.on("data", (c: Buffer) => this.feed(c));
    socket.on("close", () => this.finish(1006));
    socket.on("error", () => this.finish(1006));
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  send(text: string): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
  }

  ping(): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(0x9, Buffer.alloc(0)));
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    const r = Buffer.from(reason, "utf8").subarray(0, 100);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    try {
      this.socket.write(encodeFrame(0x8, p));
      this.socket.end();
    } catch {
      /* socket already gone */
    }
    this.finish(code);
    const s = this.socket;
    setTimeout(() => s.destroy(), 1000).unref();
  }

  private finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code);
  }

  private fail(code: number): void {
    this.close(code);
    this.buf = Buffer.alloc(0);
  }

  feed(chunk: Buffer): void {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (rsv !== 0 || !masked) return this.fail(1002); // clients MUST mask (RFC 6455 5.1)
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessage)) return this.fail(1009);
        len = Number(big);
        off = 10;
      }
      if (opcode >= 0x8 && (!fin || len > 125)) return this.fail(1002);
      if (len > this.maxMessage) return this.fail(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this.onFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  private onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case 0x0: {
        if (this.fragOpcode === 0) return this.fail(1002);
        this.fragSize += payload.length;
        if (this.fragSize > this.maxMessage) return this.fail(1009);
        this.frags.push(payload);
        if (fin) this.deliver(this.fragOpcode, Buffer.concat(this.frags));
        if (fin) this.resetFrags();
        return;
      }
      case 0x1:
      case 0x2: {
        if (this.fragOpcode !== 0) return this.fail(1002);
        if (fin) return this.deliver(opcode, payload);
        this.fragOpcode = opcode;
        this.fragSize = payload.length;
        this.frags = [payload];
        return;
      }
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.close(code === 1005 ? 1000 : code);
        return;
      }
      case 0x9:
        if (!this.closed) this.socket.write(encodeFrame(0xa, payload));
        return;
      case 0xa:
        this.alive = true;
        return;
      default:
        return this.fail(1002);
    }
  }

  private resetFrags(): void {
    this.frags = [];
    this.fragSize = 0;
    this.fragOpcode = 0;
  }

  private deliver(opcode: number, data: Buffer): void {
    if (opcode === 0x2) return this.fail(1003); // text-only protocol
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      return this.fail(1007);
    }
    this.emit("message", text);
  }
}
