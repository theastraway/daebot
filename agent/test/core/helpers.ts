import { grantIfAffirmed } from "../../src/kernel/danger.ts";
import type {
  AgentEvent, AgentSession, Config, GateVerdict, Kernel, Message, Provider, SessionSync, StreamEvent, Tool, ToolCall, ToolSpec, Usage, Violation,
} from "../../src/types.ts";

export const baseCfg = (over: Partial<Config> = {}): Config => ({
  mindBaseUrl: "https://example.invalid/developer/v1",
  mindApiKey: "k",
  openrouterKey: "or-test",
  models: { default: "m/default", cheap: "m/cheap", fallback: ["m/fallback"] },
  shadow: false,
  kernel: true,
  ...over,
});

export const usage = (cost = 0.001): Usage => ({ promptTokens: 10, completionTokens: 5, costUsd: cost });

export type Round = { text?: string; calls?: ToolCall[] } | (() => never);

// Scripted provider: each stream() call consumes the next round. Records requests.
export class FakeProvider implements Provider {
  name = "fake";
  requests: { model: string; messages: Message[]; tools: ToolSpec[] }[] = [];
  private i = 0;
  private rounds: Round[];
  constructor(rounds: Round[]) { this.rounds = rounds; }
  async *stream(req: { model: string; messages: Message[]; tools: ToolSpec[]; signal?: AbortSignal }): AsyncIterable<StreamEvent> {
    this.requests.push({ model: req.model, messages: req.messages.map((m) => ({ ...m })), tools: req.tools });
    const r = this.rounds[Math.min(this.i++, this.rounds.length - 1)];
    if (typeof r === "function") r();
    const round = r as { text?: string; calls?: ToolCall[] };
    if (round.text) yield { type: "text", delta: round.text };
    for (const c of round.calls ?? []) yield { type: "toolCall", call: c };
    yield { type: "done", usage: usage(), finishReason: round.calls?.length ? "tool_calls" : "stop" };
  }
}

export class FakeKernel implements Kernel {
  log: Violation[] = [];
  hooks: {
    preTurn?: (s: any) => GateVerdict[];
    preTool?: (s: any, c: ToolCall, t: Tool) => GateVerdict[];
    preAnswer?: (s: any, d: string) => GateVerdict[];
  } = {};
  postTurnCalls: string[] = [];
  allowedTools(_s: any, all: Tool[]) { return all; }
  preTurn(s: any) { return this.hooks.preTurn?.(s) ?? []; }
  preTool(s: any, c: ToolCall, t: Tool) { return this.hooks.preTool?.(s, c, t) ?? []; }
  preAnswer(s: any, d: string) { return this.hooks.preAnswer?.(s, d) ?? []; }
  postTurn(_s: any, f: string) { this.postTurnCalls.push(f); }
  onUserMessage(s: any, m: string) { grantIfAffirmed(s, m); }
  violations() { return this.log; }
}

export class FakeSync implements SessionSync {
  appended: [string, string][] = [];
  replies: string[] = [];
  closed: string | undefined | null = null;
  async open() {}
  async append(role: "user" | "assistant", content: string) { this.appended.push([role, content]); }
  async pendingReplies() { const r = this.replies; this.replies = []; return r; }
  async close(summary?: string) { this.closed = summary ?? ""; }
}

export function fakeTool(name: string, cls: Tool["class"], out = "ok", receipt?: "mind" | "surface"): Tool & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    class: cls,
    receipt,
    spec: { name, description: name, parameters: { type: "object", properties: {} } },
    async run(args) { calls.push(args); return { ok: true, output: out }; },
  };
}

export async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

export const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({ id, name, args });

export const sessionTypes = (s: AgentSession) => s;
