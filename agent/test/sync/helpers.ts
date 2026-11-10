import type { StoredSession } from "../../src/persist.ts";
import type { HistoryEvent } from "../../src/types.ts";

export function rec(id: string, o: Partial<StoredSession> & { texts?: [string, string][] } = {}): StoredSession {
  const history: HistoryEvent[] = (o.texts ?? []).flatMap(([mid, text]): HistoryEvent[] => mid.startsWith("u") ? [{ type: "user", text, id: mid }] : [{ type: "text", delta: text, id: mid }]);
  const { texts: _t, ...rest } = o;
  return {
    v: 1, id, surface: "desktop", title: "t", tier: "admin", owner: "owner", createdAt: 1000, updatedAt: 1000,
    state: { messages: history.map((h) => ({ role: h.type === "user" ? "user" as const : "assistant" as const, content: h.type === "user" ? h.text : h.type === "text" ? h.delta : "" })), receiptCounter: 0, totalCostUsd: 0, userMessageIndex: 0 },
    violations: [], history, ...rest,
  };
}
