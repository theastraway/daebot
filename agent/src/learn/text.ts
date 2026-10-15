// Small text utilities: tokenizing, similarity, titles, keys, sanitizing.
import { createHash } from "node:crypto";
import type { LessonKind } from "./types.ts";

const STOP = new Set(("a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that these those " +
  "i you he she we they me my your our their do does did done not no yes so than too very can could should would will just also into over about " +
  "have has had please ok okay").split(/\s+/));

// Light suffix stripping so "decide", "decided", "deciding" and "decides" compare equal. Not a real stemmer.
function stem(w: string): string {
  let doubled = false;
  if (w.length > 5 && w.endsWith("ing")) { w = w.slice(0, -3); doubled = true; }
  else if (w.length > 4 && w.endsWith("ed")) { w = w.slice(0, -2); doubled = true; }
  else if (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (doubled && w.length > 3 && w[w.length - 1] === w[w.length - 2] && !/(?:ss|ll|ee)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

export function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9_\s-]/g, " ").split(/[\s_-]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

export function tokenSet(s: string): Set<string> { return new Set(tokens(s)); }

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Share of the query's tokens found in the doc: "does this item talk about my message".
export function coverage(query: Set<string>, doc: Set<string>): number {
  if (!query.size) return 0;
  let hit = 0;
  for (const x of query) if (doc.has(x)) hit++;
  return hit / query.size;
}

export function oneLine(s: string, max = 400): string {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function today(now: Date = new Date()): string { return now.toISOString().slice(0, 10); }

export function keyFor(seed: string): string {
  return createHash("sha256").update(tokens(seed).sort().join(" ")).digest("hex").slice(0, 6);
}

const KIND_WORD: Record<LessonKind, string> = { failure: "Failure", win: "Win", behavior: "Behavior" };

// Title grammar (Anthony, 2026-09-10): `Lesson - <Failure|Win|Behavior> - <two-to-three-word behavior>`.
// No slash, parentheses or em/en dashes anywhere in the title.
export function cleanBehavior(raw: string): string {
  const words = String(raw ?? "").replace(/[\/\\()\[\]{}—–:;,.!?"'`]/g, " ").replace(/-/g, " ").split(/\s+/).filter(Boolean);
  const kept = words.slice(0, 3);
  if (!kept.length) return "";
  const s = kept.join(" ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function lessonTitle(kind: LessonKind, behavior: string): string {
  const b = cleanBehavior(behavior);
  return b ? `Lesson - ${KIND_WORD[kind]} - ${b}` : "";
}

export function skillTitle(name: string): string {
  const n = slug(name);
  return n ? `Skill - ${n}` : "";
}

export function slug(name: string): string {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

export function validLessonTitle(t: string): boolean {
  const m = /^Lesson - (Failure|Win|Behavior) - (\S+(?: \S+){0,2})$/.exec(t);
  return !!m && !/[\/()—–]/.test(t);
}

export function clip(s: string, max: number): string { return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…"; }
