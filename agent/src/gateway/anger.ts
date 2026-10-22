// Anthony-message KPI: of the messages Anthony sends to Dae, how many were productive (instruction / answer) versus spent correcting
// or chasing (chaser / anger / mixed). The classifier runs on his Mac (~/.claude/scripts/daebot-anger-kpi.py) because the transcripts live there;
// this file only stores the labeled messages (upsert by id, so re-uploading is safe) and derives every number from them.
//   POST /api/admin/anger   { batch: [message...], sessions: { <sid>: { title } } }   (log key only)
//   GET  /api/admin/anger   headline windows, daily trend, per-session table, 20 labeled examples
// Counts are derived from the stored messages, never stored, so a number can not drift from the evidence behind it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { etDay } from "./mistakes.ts";

export const ANGER_LABELS = ["instruction", "answer", "chaser", "anger", "mixed"] as const;
export type AngerLabel = (typeof ANGER_LABELS)[number];
const PRODUCTIVE = new Set<string>(["instruction", "answer"]);
const DAY = 86_400_000;

export interface AngerMsg { id: string; ts: string; session: string; label: AngerLabel; reasons: string[]; repeat: boolean; caps: number; len: number; text: string }
interface Shape { v: 1; messages: Record<string, AngerMsg>; sessions: Record<string, { title: string }>; updated_at: string }

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

export class AngerLedger {
  private path: string;
  private d: Shape = { v: 1, messages: {}, sessions: {}, updated_at: "" };
  private now: () => number;
  constructor(dir: string, now: () => number = Date.now) {
    this.now = now;
    this.path = join(dir, "admin", "anger-kpi.json");
    if (existsSync(this.path)) {
      try { const p = JSON.parse(readFileSync(this.path, "utf8")); if (p?.v === 1) this.d = { v: 1, messages: p.messages ?? {}, sessions: p.sessions ?? {}, updated_at: p.updated_at ?? "" }; }
      catch { throw new Error("admin/anger-kpi.json is unreadable; refusing to start (move it aside to reset)."); }
    }
  }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.d), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Upserts labeled messages. Anything malformed is skipped and counted, never guessed at. */
  ingest(b: any): { added: number; updated: number; skipped: number; total: number } {
    let added = 0, updated = 0, skipped = 0;
    const items: unknown[] = Array.isArray(b?.batch) ? b.batch : [];
    for (const raw of items) {
      const m: any = raw;
      const id = str(m?.id, 80), ts = Date.parse(str(m?.ts, 40)), label = m?.label;
      if (!id || !Number.isFinite(ts) || !(ANGER_LABELS as readonly string[]).includes(label)) { skipped++; continue; }
      const rec: AngerMsg = {
        id, ts: new Date(ts).toISOString(), session: str(m.session, 80) || "unknown", label,
        reasons: Array.isArray(m.reasons) ? m.reasons.map((x: unknown) => str(x, 40)).filter(Boolean).slice(0, 8) : [],
        repeat: m.repeat === true, caps: Math.max(0, Math.min(1, Number(m.caps) || 0)), len: Math.max(0, Math.min(1e6, Math.round(Number(m.len) || 0))), text: str(m.text, 240),
      };
      if (this.d.messages[id]) updated++; else added++;
      this.d.messages[id] = rec;
    }
    if (b?.sessions && typeof b.sessions === "object") for (const [sid, v] of Object.entries<any>(b.sessions)) if (sid.length <= 80) this.d.sessions[sid] = { title: str(v?.title, 120) };
    if (added || updated || b?.sessions) { this.d.updated_at = new Date(this.now()).toISOString(); this.save(); }
    return { added, updated, skipped, total: Object.keys(this.d.messages).length };
  }

  private static tally(ms: AngerMsg[]) {
    const c: Record<AngerLabel, number> = { instruction: 0, answer: 0, chaser: 0, anger: 0, mixed: 0 };
    let repeats = 0;
    for (const m of ms) { c[m.label]++; if (m.repeat) repeats++; }
    const total = ms.length, productive = c.instruction + c.answer;
    return { total, productive, wasted: total - productive, pct: total ? productive / total : null, chasers: c.chaser, repeats, counts: c };
  }

  view() {
    const now = this.now();
    const all = Object.values(this.d.messages);
    const today = etDay(now);
    const win = (days: number) => AngerLedger.tally(all.filter((m) => Date.parse(m.ts) >= now - days * DAY));
    const todayMs = all.filter((m) => etDay(Date.parse(m.ts)) === today);
    // daily trend for the last 30 ET days (days with no messages are kept, with pct null, so the chart has no silent gaps)
    const trend: { day: string; total: number; productive: number; pct: number | null; chasers: number; angry: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const dd = etDay(now - i * DAY);
      const ms = all.filter((m) => etDay(Date.parse(m.ts)) === dd);
      const t = AngerLedger.tally(ms);
      trend.push({ day: dd, total: t.total, productive: t.productive, pct: t.pct, chasers: t.chasers, angry: t.counts.anger + t.counts.mixed });
    }
    const w30 = all.filter((m) => Date.parse(m.ts) >= now - 30 * DAY);
    const bySession = new Map<string, AngerMsg[]>();
    for (const m of w30) { const a = bySession.get(m.session); a ? a.push(m) : bySession.set(m.session, [m]); }
    const sessions = [...bySession.entries()].map(([sid, ms]) => {
      const t = AngerLedger.tally(ms);
      const times = ms.map((m) => Date.parse(m.ts));
      return { id: sid, title: this.d.sessions[sid]?.title || sid.slice(0, 8), first: new Date(Math.min(...times)).toISOString(), last: new Date(Math.max(...times)).toISOString(), total: t.total, productive: t.productive, pct: t.pct, chasers: t.chasers, repeats: t.repeats, anger: t.counts.anger, mixed: t.counts.mixed };
    }).sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
    // 20 labeled examples, newest first inside each label, so the reader can audit the classifier
    const quota: [AngerLabel, number][] = [["anger", 5], ["chaser", 5], ["mixed", 4], ["instruction", 3], ["answer", 3]];
    const examples: AngerMsg[] = [];
    for (const [label, n] of quota) examples.push(...all.filter((m) => m.label === label).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, n));
    for (const m of [...all].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))) { if (examples.length >= 20) break; if (!examples.includes(m)) examples.push(m); }
    const ex = examples.slice(0, 20).map((m) => ({ ts: m.ts, session: this.d.sessions[m.session]?.title || m.session.slice(0, 8), label: m.label, reasons: m.reasons, repeat: m.repeat, text: m.text }));
    return {
      headline: { today: AngerLedger.tally(todayMs), d7: win(7), d30: win(30), all: AngerLedger.tally(all) },
      trend, sessions, examples: ex, updated_at: this.d.updated_at || null, stored: all.length,
      method: "Rule-based classifier on the Mac (caps ratio, profanity, repeat phrases, chaser phrases, near-duplicate of an earlier message in the same session). Productive = instruction + answer. Chaser, anger and mixed all count against the number; nothing is softened.",
    };
  }
}
