// Helpers over the AgentEvent stream that need to understand `retract`. Pure, no I/O.
import { randomBytes } from "node:crypto";
import type { AgentEvent, HistoryEvent, MessageQuote, PhotoRef } from "./types.ts";

/**
 * The assistant text a user actually ended up seeing: text deltas minus every block a later `retract` withdrew.
 * A block is the run of text since the last tool/gate/confirm/done boundary (usage and notices do not end it).
 * The eval harness uses this so a draft the receipt gate withheld counts as NOT shown.
 */
export function visibleText(events: Iterable<AgentEvent>): string {
  const blocks: string[] = [];
  let cur = "";
  const flush = () => { if (cur) blocks.push(cur); cur = ""; };
  for (const ev of events) {
    switch (ev.type) {
      case "text": cur += ev.delta; break;
      case "retract": cur = ""; break;
      case "toolStart": case "toolEnd": case "gate": case "confirm": case "permission": case "permissionResolved": case "done": flush(); break;
      default: break;
    }
  }
  flush();
  return blocks.join("\n");
}

/** Records the visible transcript of a session with text deltas coalesced into one event per block. */
export class HistoryRecorder {
  private items: HistoryEvent[];
  private cap: number;
  private runId?: string;
  constructor(initial: HistoryEvent[] = [], cap = 1500) {
    this.items = withMessageIds(initial);
    this.cap = cap;
  }
  /** The run (request) the next items belong to; stamped on user and text items as `rid`. */
  setRun(id: string | undefined): void { this.runId = id; }
  user(text: string, photos?: PhotoRef[], quote?: MessageQuote): void {
    this.items.push({ type: "user", text, id: newMessageId(), ...(this.runId ? { rid: this.runId } : {}), ...(photos?.length ? { photos } : {}), ...(quote ? { quote } : {}) });
    this.trim();
  }
  push(ev: AgentEvent): void {
    if (ev.type === "text") {
      const last = this.items[this.items.length - 1];
      if (last && last.type === "text") last.delta += ev.delta;
      else this.items.push({ type: "text", delta: ev.delta, id: newMessageId(), ...(this.runId ? { rid: this.runId } : {}) });
      return;
    }
    this.items.push(ev);
    this.trim();
  }
  events(): HistoryEvent[] { return this.items.slice(); }
  private trim(): void {
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }
}

export const newMessageId = (): string => "m" + randomBytes(5).toString("hex");

/** Saved transcripts from before message ids existed get a stable positional id (l<index>) the first time they are read; new items already carry one. */
export function withMessageIds(items: HistoryEvent[]): HistoryEvent[] {
  return items.map((it, i) => ((it.type === "text" || it.type === "user") && !it.id ? { ...it, id: `l${i}` } : it));
}

/** The model-facing form of a reply: the quoted message first, then what the user wrote. */
export function messageWithQuote(text: string, quote: MessageQuote | undefined): string {
  const q = quote?.text?.trim();
  if (!q) return text;
  return `Replying to: "${q.length > 600 ? q.slice(0, 600) + "..." : q}"\n\n${text}`;
}
