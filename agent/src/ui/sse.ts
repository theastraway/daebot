// Server-Sent Events parser that tolerates arbitrary chunk boundaries. Pure.
import type { AgentEvent } from "../types.ts";

export interface SseMessage { event?: string; data: string; id?: string }

export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event: string | undefined;
  private id: string | undefined;

  /** Feed a decoded text chunk; returns every message completed by it. */
  push(chunk: string): SseMessage[] {
    this.buf += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf);
      if (!m) break;
      // a lone "\r" at the very end may be the first half of "\r\n": wait for more input
      if (m[0] === "\r" && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      if (line === "") {
        if (this.data.length) out.push({ event: this.event, data: this.data.join("\n"), id: this.id });
        this.data = []; this.event = undefined;
        continue;
      }
      if (line.startsWith(":")) continue; // comment / keep-alive
      const c = line.indexOf(":");
      const field = c === -1 ? line : line.slice(0, c);
      let value = c === -1 ? "" : line.slice(c + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.data.push(value);
      else if (field === "event") this.event = value;
      else if (field === "id") this.id = value;
    }
    return out;
  }

  /** End of stream: a final message without the blank-line terminator is still delivered. */
  end(): SseMessage[] {
    const out = this.push("\n\n");
    this.buf = "";
    return out;
  }
}

const TYPES = new Set(["text", "toolStart", "toolEnd", "gate", "confirm", "permission", "permissionResolved", "notice", "exchange", "usage", "retract", "done"]);

export function parseAgentEvent(data: string): AgentEvent | undefined {
  try {
    const v = JSON.parse(data) as { type?: unknown };
    if (v && typeof v === "object" && typeof v.type === "string" && TYPES.has(v.type)) return v as AgentEvent;
  } catch { /* ignore malformed frame */ }
  return undefined;
}

/** Decode a byte stream (fetch response body) into AgentEvents. */
export async function* agentEventsFromStream(body: AsyncIterable<Uint8Array>): AsyncGenerator<AgentEvent> {
  const dec = new TextDecoder();
  const p = new SseParser();
  for await (const chunk of body) {
    for (const msg of p.push(dec.decode(chunk, { stream: true }))) {
      const ev = parseAgentEvent(msg.data);
      if (ev) yield ev;
    }
  }
  for (const msg of p.push(dec.decode())) { const ev = parseAgentEvent(msg.data); if (ev) yield ev; }
  for (const msg of p.end()) { const ev = parseAgentEvent(msg.data); if (ev) yield ev; }
}
