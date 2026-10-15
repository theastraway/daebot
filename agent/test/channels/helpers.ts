import type { AgentEvent, AgentSession } from "../../src/types.ts";
import type { ChannelGateway } from "../../src/channels/common.ts";

export type Script = (text: string, turn: number, sessionNo: number) => AgentEvent[];

export function textTurn(...deltas: string[]): AgentEvent[] {
  return [...deltas.map((d) => ({ type: "text" as const, delta: d })), { type: "done", finalText: deltas.join("") }];
}

export interface FakeGw extends ChannelGateway {
  opened: { surface: string; title?: string; opts?: { identity?: string } }[];
  sessions: FakeSession[];
  closed: string[];
}
export interface FakeSession extends AgentSession { sent: string[]; maxConcurrent: number }

export function fakeGateway(script: Script = (t) => textTurn(`echo: ${t}`), delayMs = 0): FakeGw {
  const gw: FakeGw = {
    opened: [], sessions: [], closed: [],
    async open(surface, title, opts) {
      gw.opened.push({ surface, title, opts });
      const no = gw.sessions.length;
      let turn = 0, active = 0;
      const s: FakeSession = {
        id: `s${no}`, surface, sent: [], maxConcurrent: 0,
        send(text: string) {
          const events = script(text, turn++, no);
          s.sent.push(text);
          return (async function* () {
            active++; s.maxConcurrent = Math.max(s.maxConcurrent, active);
            try {
              for (const e of events) { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); yield e; }
            } finally { active--; }
          })();
        },
        violations: () => [],
        async close() { gw.closed.push(s.id); },
      };
      gw.sessions.push(s);
      return s;
    },
  };
  return gw;
}

export async function until(cond: () => boolean, ms = 2000, label = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

export const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
