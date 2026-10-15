// Deterministic scripted provider. No network, no randomness.
import type { Message, Provider, StreamEvent, ToolSpec } from "../types.ts";
import type { Step } from "./types.ts";

const ID_TOKEN = /\{\{id:([A-Za-z0-9_]+)\}\}/g;

// Receipt id of the latest executed call of `tool` since the last user message, from the loop's tool messages.
export function latestReceiptId(messages: Message[], tool: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") break;
    if (m.role === "tool" && m.name === tool) {
      const hit = /^\[#(c\d+)\b/.exec(m.content);
      if (hit) return hit[1];
    }
  }
  return "c?";
}

export function fillTemplate(s: string, messages: Message[]): string {
  return s.replace(ID_TOKEN, (_all, tool: string) => latestReceiptId(messages, tool));
}

function fillValue(v: unknown, messages: Message[]): unknown {
  if (typeof v === "string") return fillTemplate(v, messages);
  if (Array.isArray(v)) return v.map((x) => fillValue(x, messages));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fillValue(x, messages)]));
  return v;
}

// True when, since the last assistant message, the kernel refused something: a blocked / not-executed tool
// result, or a "[kernel:" system nudge (withheld draft or pre-turn notice).
export function blockedSignal(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") return false;
    if (m.role === "tool" && (m.content.startsWith("blocked by ") || m.content.startsWith("not executed"))) return true;
    if (m.role === "system" && m.content.startsWith("[kernel:")) return true;
  }
  return false;
}

export class ScriptedProvider implements Provider {
  readonly name = "scripted-bad-model";
  requests = 0;
  branches = 0;
  private queue: Step[] = [];
  private last: Step | undefined;
  private seq = 0;

  setTurn(steps: Step[]): void {
    this.queue = steps.slice();
    this.last = undefined;
  }

  private next(blocked: boolean): Step {
    if (blocked && this.last?.onBlocked) {
      this.queue = this.last.onBlocked.slice();
      this.branches++;
    }
    const step = this.queue.shift();
    if (step) { this.last = step; return step; }
    // exhausted: a stubborn model repeats its last words (never its tool calls)
    return { text: this.last?.text ?? "" };
  }

  async *stream(req: { model: string; messages: Message[]; tools: ToolSpec[]; signal?: AbortSignal }): AsyncIterable<StreamEvent> {
    this.requests++;
    const step = this.next(blockedSignal(req.messages));
    const text = step.text ? fillTemplate(step.text, req.messages) : "";
    if (text) yield { type: "text", delta: text };
    for (const c of step.calls ?? []) {
      yield { type: "toolCall", call: { id: `call_${++this.seq}`, name: c.name, args: fillValue(c.args, req.messages) as Record<string, unknown> } };
    }
    yield { type: "done", usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 }, finishReason: step.calls?.length ? "tool_calls" : "stop" };
  }
}
