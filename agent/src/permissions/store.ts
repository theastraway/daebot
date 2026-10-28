// Per-user permission rules, mode and learned patterns: DATA_DIR/permissions/<ownerId>.json (hosted: the Render disk).
// Plain JSON, mode 0600, atomic writes. Read back whenever the file changed, so two runtime instances for one user never
// overwrite each other with a stale copy.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isKind, validateRule } from "./rules.ts";
import type { Effect, Matcher, PermissionRule } from "./rules.ts";
import type { ToolClass } from "../types.ts";

/** risky: ask before outward / irreversible / public actions (today's behaviour). writes: also before anything that changes something. everything: also before web, connectors and shell reads. */
export type PermissionMode = "risky" | "writes" | "everything";
export const MODES: PermissionMode[] = ["risky", "writes", "everything"];
export const isMode = (m: unknown): m is PermissionMode => typeof m === "string" && (MODES as string[]).includes(m);

/** After this many refusals of the same kind of request, the next prompt offers "Always deny this?". */
export const LEARN_DENY_AFTER = 2;
export const LEARN_ALLOW_AFTER = 3;
const MAX_RULES = 500;
const MAX_PATTERNS = 400;

export interface PatternStat { label: string; tool: string; matcher: Matcher; allow: number; deny: number; lastAt: number }
/** The Bypass waiver: recorded per account, server side. Without one the server refuses to honor bypass anywhere. */
export interface Waiver { at: number; version: number }
/** Bump when the waiver text changes: an older acceptance no longer counts. */
export const WAIVER_VERSION = 1;
export const WAIVER_TEXT = "I understand this gives the AI permission to take any action without asking, including sending messages, deleting data and spending money, and that every action it takes is my responsibility.";
/** Per-chat mode: the three account modes plus bypass (chat level only, never an account default). */
export type SessionPermMode = PermissionMode | "bypass";
export const isSessionMode = (m: unknown): m is SessionPermMode => m === "bypass" || isMode(m);
interface FileShape { v: 1; mode: PermissionMode; rules: PermissionRule[]; patterns: Record<string, PatternStat>; waiver?: Waiver }

function seg(s: string): string {
  const v = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return v === "" || v === "." || v === ".." ? "_" : v;
}

function clean(raw: unknown): FileShape {
  const out: FileShape = { v: 1, mode: "risky", rules: [], patterns: {} };
  if (!raw || typeof raw !== "object") return out;
  const j = raw as Partial<FileShape>;
  if (isMode(j.mode)) out.mode = j.mode;
  if (j.waiver && typeof j.waiver === "object" && Number.isFinite(Number(j.waiver.at)) && Number.isInteger(Number(j.waiver.version))) out.waiver = { at: Number(j.waiver.at), version: Number(j.waiver.version) };
  for (const r of Array.isArray(j.rules) ? j.rules : []) {
    try {
      const v = validateRule({ effect: r.effect, tool: r.tool, matcher: r.matcher });
      if (typeof r.id !== "string") continue;
      out.rules.push({ id: r.id, ...v, scope: String(r.scope ?? "").slice(0, 300), createdAt: Number(r.createdAt) || 0, uses: Math.max(0, Number(r.uses) || 0), ...(r.lastUsedAt ? { lastUsedAt: Number(r.lastUsedAt) } : {}) });
    } catch { /* a malformed rule in a hand-edited file is dropped, never trusted */ }
  }
  if (j.patterns && typeof j.patterns === "object") {
    for (const [k, p] of Object.entries(j.patterns).slice(0, MAX_PATTERNS)) {
      const s = p as Partial<PatternStat>;
      if (!s || typeof s.label !== "string" || typeof s.tool !== "string" || !s.matcher || !isKind(s.matcher.kind)) continue;
      out.patterns[k] = { label: s.label.slice(0, 300), tool: s.tool, matcher: s.matcher, allow: Math.max(0, Number(s.allow) || 0), deny: Math.max(0, Number(s.deny) || 0), lastAt: Number(s.lastAt) || 0 };
    }
  }
  return out;
}

export class PermissionStore {
  private file: string;
  private root: string;
  private cache: FileShape | undefined;
  private stamp = "";

  constructor(dir: string, owner: string) {
    this.root = join(dir, "permissions");
    this.file = join(this.root, `${seg(owner)}.json`);
  }

  private load(): FileShape {
    let stamp = "none";
    try { const st = statSync(this.file); stamp = `${st.mtimeMs}:${st.size}`; } catch { /* no file yet */ }
    if (this.cache && stamp === this.stamp) return this.cache;
    let data: FileShape;
    try { data = clean(JSON.parse(readFileSync(this.file, "utf8"))); } catch { data = clean(undefined); }
    this.cache = data;
    this.stamp = stamp;
    return data;
  }

  private save(d: FileShape): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.cache = d;
    try { const st = statSync(this.file); this.stamp = `${st.mtimeMs}:${st.size}`; } catch { this.stamp = ""; }
  }

  mode(): PermissionMode { return this.load().mode; }
  setMode(m: PermissionMode): void {
    if (!isMode(m)) throw new Error("bad mode");
    const d = this.load();
    this.save({ ...d, mode: m });
  }

  /** The recorded waiver, only when it is for the current text. */
  waiver(): Waiver | undefined { const w = this.load().waiver; return w && w.version === WAIVER_VERSION ? { ...w } : undefined; }
  acceptWaiver(now = Date.now()): Waiver {
    const d = this.load();
    const w: Waiver = { at: now, version: WAIVER_VERSION };
    this.save({ ...d, waiver: w });
    return { ...w };
  }
  revokeWaiver(): void { const d = this.load(); if (!d.waiver) return; const { waiver: _w, ...rest } = d; this.save(rest); }

  rules(): PermissionRule[] { return this.load().rules.map((r) => ({ ...r, matcher: { ...r.matcher } })); }

  /** Adds (or refreshes) a rule. Only the broker calls this, from a user's click; `cls` enforces the class limits on allow rules. */
  addRule(input: { effect: Effect; tool: string; matcher: Matcher; scope: string }, cls?: ToolClass, now = Date.now()): PermissionRule {
    const v = validateRule(input, cls);
    const d = this.load();
    const same = d.rules.find((r) => r.effect === v.effect && r.tool === v.tool && r.matcher.kind === v.matcher.kind && (r.matcher.value ?? "") === (v.matcher.value ?? ""));
    if (same) return { ...same };
    if (d.rules.length >= MAX_RULES) throw new Error("too many rules; delete some in Settings > Permissions");
    // A new rule replaces any opposite rule with the identical scope (the latest click is the user's current wish).
    const kept = d.rules.filter((r) => !(r.effect !== v.effect && r.tool === v.tool && r.matcher.kind === v.matcher.kind && (r.matcher.value ?? "") === (v.matcher.value ?? "")));
    const rule: PermissionRule = { id: randomUUID(), ...v, scope: String(input.scope).replace(/\s+/g, " ").trim().slice(0, 300), createdAt: now, uses: 0 };
    this.save({ ...d, rules: [...kept, rule] });
    return { ...rule };
  }

  removeRule(id: string): boolean {
    const d = this.load();
    const rules = d.rules.filter((r) => r.id !== id);
    if (rules.length === d.rules.length) return false;
    this.save({ ...d, rules });
    return true;
  }

  /** Edit from Settings: flip allow/deny and/or change the matcher value. Revalidated like a new rule; whether an allow may fire for a call's class is checked again at match time. */
  updateRule(id: string, patch: { effect?: Effect; value?: string }): PermissionRule | undefined {
    const d = this.load();
    const cur = d.rules.find((r) => r.id === id);
    if (!cur) return undefined;
    const hasValue = cur.matcher.kind !== "any" && cur.matcher.kind !== "readonly";
    const matcher: Matcher = patch.value !== undefined && hasValue ? { kind: cur.matcher.kind, value: patch.value } : cur.matcher;
    const v = validateRule({ effect: patch.effect ?? cur.effect, tool: cur.tool, matcher });
    const changed = v.effect !== cur.effect || (v.matcher.value ?? "") !== (cur.matcher.value ?? "");
    const next: PermissionRule = { ...cur, ...v, scope: changed && !/\(edited\)$/.test(cur.scope) ? `${cur.scope} (edited)` : cur.scope };
    this.save({ ...d, rules: d.rules.map((r) => (r.id === id ? next : r)) });
    return { ...next };
  }

  touch(id: string, now = Date.now()): void {
    const d = this.load();
    const r = d.rules.find((x) => x.id === id);
    if (!r) return;
    r.uses += 1;
    r.lastUsedAt = now;
    this.save(d);
  }

  recordDecision(p: { key: string; label: string; tool: string; matcher: Matcher }, effect: Effect, now = Date.now()): PatternStat {
    const d = this.load();
    const cur = d.patterns[p.key] ?? { label: p.label, tool: p.tool, matcher: p.matcher, allow: 0, deny: 0, lastAt: 0 };
    cur[effect] += 1;
    cur.lastAt = now;
    d.patterns[p.key] = cur;
    const keys = Object.keys(d.patterns);
    if (keys.length > MAX_PATTERNS) for (const k of keys.sort((a, b) => d.patterns[a].lastAt - d.patterns[b].lastAt).slice(0, keys.length - MAX_PATTERNS)) delete d.patterns[k];
    this.save(d);
    return { ...cur };
  }

  pattern(key: string): PatternStat | undefined { const p = this.load().patterns[key]; return p ? { ...p } : undefined; }

  /** Kinds of request the user keeps refusing but has not made a rule for. */
  learnedDenies(): (PatternStat & { key: string })[] {
    const d = this.load();
    const ruled = (p: PatternStat) => d.rules.some((r) => r.effect === "deny" && r.tool === p.tool && r.matcher.kind === p.matcher.kind && (r.matcher.value ?? "") === (p.matcher.value ?? ""));
    return Object.entries(d.patterns).filter(([, p]) => p.deny >= LEARN_DENY_AFTER && p.deny > p.allow && !ruled(p)).map(([key, p]) => ({ key, ...p })).sort((a, b) => b.deny - a.deny).slice(0, 20);
  }
}
