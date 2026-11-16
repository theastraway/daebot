// The tool result contract. A ToolResult is still { ok, output, meta }; this layer fixes what the first line of `output` and
// `meta.contract` say, so the model (and the proof card) can read every result the same way:
//   ok:    "<summary>"            then the payload; meta.contract = { status: "ok" | "partial", summary, next?, artifacts? }
//   fail:  "failed: <cause>"      then "| retry: safe|unsafe|pointless" "| next: <what to do>" "| stop: <when to give up>"
// A tool that does not use these helpers is unchanged; contractOf() still reads it (status from ok, summary from the first line).
import type { ToolResult } from "../types.ts";

export type ResultStatus = "ok" | "partial" | "failed" | "blocked";
/** safe: the same call can be retried as is. unsafe: retrying may act twice (a send, a write). pointless: the same call will fail again; change something first. */
export type Retry = "safe" | "unsafe" | "pointless";

export interface ResultContract {
  status: ResultStatus;
  summary: string;
  /** What the model should do next, one line. */
  next?: string;
  /** Paths, ids or URLs the call produced. */
  artifacts?: string[];
  cause?: string;
  retry?: Retry;
  /** When to stop trying (e.g. "after one retry" or "ask the user for the path"). */
  stop?: string;
}

const line = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();

/** A successful result: the summary line first, the payload under it. `partial` says the call did some of the work. */
export function done(summary: string, o: { output?: string; next?: string; artifacts?: string[]; partial?: boolean; meta?: Record<string, unknown>; images?: string[] } = {}): ToolResult {
  const c: ResultContract = { status: o.partial ? "partial" : "ok", summary: line(summary) };
  if (o.next) c.next = line(o.next);
  if (o.artifacts?.length) c.artifacts = o.artifacts.slice(0, 20);
  const head = c.next ? `${c.summary} | next: ${c.next}` : c.summary;
  const output = o.output ? `${head}\n${o.output}` : head;
  return { ok: true, output, meta: { ...(o.meta ?? {}), contract: c }, ...(o.images ? { images: o.images } : {}) };
}

/** A failed result. The cause is the first line; retry/next/stop tell the model what a sensible person would do. */
export function failed(cause: string, o: { retry?: Retry; next?: string; stop?: string; output?: string; meta?: Record<string, unknown>; blocked?: boolean } = {}): ToolResult {
  const c: ResultContract = { status: o.blocked ? "blocked" : "failed", summary: line(cause), cause: line(cause) };
  if (o.retry) c.retry = o.retry;
  if (o.next) c.next = line(o.next);
  if (o.stop) c.stop = line(o.stop);
  const parts = [`${c.status}: ${c.cause}`];
  if (c.retry) parts.push(`retry: ${c.retry}`);
  if (c.next) parts.push(`next: ${c.next}`);
  if (c.stop) parts.push(`stop: ${c.stop}`);
  const head = parts.join(" | ");
  return { ok: false, output: o.output ? `${head}\n${o.output}` : head, meta: { ...(o.meta ?? {}), contract: c } };
}

/** Reads the contract of any result: the one the helpers wrote, or one inferred from ok and the first line. */
export function contractOf(r: ToolResult): ResultContract {
  const c = r.meta?.contract as ResultContract | undefined;
  if (c && typeof c === "object" && typeof c.summary === "string" && typeof c.status === "string") return c;
  const first = line((r.output ?? "").split("\n")[0]).slice(0, 200);
  if (r.ok) return { status: "ok", summary: first };
  const m = /^(?:failed|blocked|error)\s*:\s*(.*)$/i.exec(first);
  const blocked = /^(?:blocked by|not executed)\b/i.test(first);
  return { status: blocked ? "blocked" : "failed", summary: first, cause: m ? m[1] : first };
}
