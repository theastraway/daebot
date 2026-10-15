import type { CallRecord, Tool, ToolClass, TurnState } from "../../src/types.ts";

export function state(over: Partial<TurnState> = {}): TurnState {
  return {
    sessionId: "s1", booted: true, turnIndex: 1, userMessage: "hello", userMessageIndex: 1,
    calls: [], allCalls: [], confirmations: [], shadow: false, ...over,
  };
}

export function tool(name: string, cls: ToolClass = "read", receipt?: "mind" | "surface"): Tool {
  return {
    spec: { name, description: name, parameters: { type: "object" } },
    class: cls, receipt,
    async run() { return { ok: true, output: "" }; },
  };
}

export function rec(id: string, name: string, args: Record<string, unknown> = {}, o: { receipt?: "mind" | "surface"; ok?: boolean; cls?: ToolClass } = {}): CallRecord {
  return {
    receiptId: id, call: { id: "x" + id, name, args }, tool: name, class: o.cls ?? "read",
    receipt: o.receipt, result: { ok: o.ok ?? true, output: "out" }, at: 0,
  };
}

export function call(name: string, args: Record<string, unknown> = {}) {
  return { id: "t1", name, args };
}
