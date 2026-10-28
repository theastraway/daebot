// Input history persisted at ~/.daebot/history (one JSON string per line, so multi-line entries survive).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { daebotHome } from "../home.ts";

export const MAX_HISTORY = 1000;

export function defaultHistoryPath(env: Record<string, string | undefined> = process.env): string {
  return env.MINDCLAW_HISTORY || join(daebotHome(env), "history");
}

export function loadHistory(path: string): string[] {
  try {
    const out: string[] = [];
    for (const l of readFileSync(path, "utf8").split("\n")) {
      if (!l) continue;
      try { const v = JSON.parse(l); if (typeof v === "string" && v.trim()) out.push(v); } catch { out.push(l); }
    }
    return out.slice(-MAX_HISTORY);
  } catch { return []; }
}

export function appendHistory(path: string, entry: string): void {
  if (!entry.trim()) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
    // occasional trim
    const all = loadHistory(path);
    if (all.length > MAX_HISTORY * 1.5) writeFileSync(path, all.slice(-MAX_HISTORY).map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  } catch { /* history is best-effort */ }
}
