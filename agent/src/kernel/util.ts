import { createHash } from "node:crypto";

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

// tool name + stable hash of sorted args: identifies one exact proposed action.
export function callSignature(name: string, args: Record<string, unknown>): string {
  return name + ":" + createHash("sha256").update(stableStringify(args)).digest("hex").slice(0, 16);
}

export function normalizeEntity(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
