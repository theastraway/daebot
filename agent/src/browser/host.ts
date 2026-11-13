// The desktop, as the browser tool sees it. Tests pass a fake. The real one is the long-poll bridge.

import type { BrowserNotice, BrowserSnapshot } from "./bridge.ts";

export interface BrowserHost {
  connected(): boolean;
  snapshot(): BrowserSnapshot;
  call(op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notice?(n: BrowserNotice | null): void;
}

export function controlOf(host: BrowserHost, tabId: string | undefined): "agent" | "user" {
  const tabs = host.snapshot().tabs;
  const tab = (tabId && tabs.find((t) => t.id === tabId)) || tabs.find((t) => t.active) || tabs[0];
  return tab?.control === "user" ? "user" : "agent";
}

export function activeTabId(host: BrowserHost, requested?: string): string | undefined {
  const tabs = host.snapshot().tabs;
  if (requested && tabs.some((t) => t.id === requested)) return requested;
  return tabs.find((t) => t.active)?.id ?? tabs[0]?.id;
}
