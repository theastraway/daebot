// Helpers over the AgentEvent stream that need to understand `retract`. Pure, no I/O.
import type { AgentEvent, HistoryEvent, PhotoRef } from "./types.ts";

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
  constructor(initial: HistoryEvent[] = [], cap = 1500) {
    this.items = initial.slice();
    this.cap = cap;
  }
  user(text: string, photos?: PhotoRef[]): void {
    this.items.push({ type: "user", text, ...(photos?.length ? { photos } : {}) });
    this.trim();
  }
  push(ev: AgentEvent): void {
    if (ev.type === "text") {
      const last = this.items[this.items.length - 1];
      if (last && last.type === "text") last.delta += ev.delta;
      else this.items.push({ type: "text", delta: ev.delta });
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
