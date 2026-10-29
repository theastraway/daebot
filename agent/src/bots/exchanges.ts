// Agent exchanges: one persistent, server-side transcript per PAIR of agents ("main" = the user's own Daebot, else a bot id).
// The recipient's own turn still runs on its DM thread (that is its working memory); this store is what the USER reads:
// both sides of the conversation, in order, with the tool calls the recipient made collapsed under its reply.
//
//   DATA_DIR/exchanges/<sha(owner)>/<exchangeId>.json      one file per pair, written atomically (tmp + rename)
//
// Everything is owner-scoped: an exchange id of another owner is simply "not found". Read-only for the user (the UI shows a
// Read-only pill); the only writers are the bot bus (bot_talk) and the purge when a bot is deleted.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** "main" (the user's own Daebot) or a bot id. */
export type Party = string;
export const MAIN: Party = "main";

export interface ExTool { name: string; ok: boolean; preview: string }
export interface ExMessage {
  id: string;
  from: Party;
  text: string;
  at: number;
  /** "message" starts a turn of the other side; "reply" is that side's answer to it. */
  kind: "message" | "reply";
  /** Tool calls the author made while writing this (replies only), shown collapsed. */
  tools?: ExTool[];
  /** OOC/EMR decision receipts (MIND document ids) behind this message: the requester's on a request, the receiver's on its reply. */
  decisions?: ExDecision[];
}
export interface ExDecision { id: string; role: "requester" | "receiver" }
export interface ExchangeRecord {
  v: 1;
  id: string;
  owner: string;
  /** The two parties, ordered ("main" first, else by id) so a pair has exactly one exchange. */
  a: Party;
  b: Party;
  createdAt: number;
  updatedAt: number;
  messages: ExMessage[];
  /** Messages with `at` <= seenAt have been seen by the user. */
  seenAt: number;
  /** Messages delivered since the user last spoke (loop guard). */
  sinceUser: number;
}
export interface ExchangeSummary {
  id: string;
  a: Party;
  b: Party;
  updatedAt: number;
  count: number;
  unread: number;
  last?: { from: Party; text: string; at: number; kind: "message" | "reply" };
}

export const MAX_EXCHANGE_MESSAGES = 500;
export const MAX_MESSAGE_CHARS = 8000;
const MAX_TOOLS = 20;

export function pairOf(x: Party, y: Party): [Party, Party] {
  if (x === MAIN) return [MAIN, y];
  if (y === MAIN) return [MAIN, x];
  return x <= y ? [x, y] : [y, x];
}

export function exchangeId(owner: string, x: Party, y: Party): string {
  const [a, b] = pairOf(x, y);
  return "ex_" + createHash("sha256").update(`${owner}|${a}|${b}`).digest("hex").slice(0, 24);
}

const SAFE_ID = /^ex_[a-f0-9]{24}$/;

export class ExchangeHub {
  readonly dir: string;
  private cache = new Map<string, Map<string, ExchangeRecord>>(); // owner -> id -> record
  private now: () => number;
  private listeners = new Set<(owner: string, rec: ExchangeRecord) => void>();

  constructor(dir: string, o: { now?: () => number } = {}) {
    this.dir = join(dir, "exchanges");
    this.now = o.now ?? Date.now;
  }

  private ownerDir(owner: string): string { return join(this.dir, createHash("sha256").update(owner).digest("hex").slice(0, 32)); }

  private load(owner: string): Map<string, ExchangeRecord> {
    let m = this.cache.get(owner);
    if (m) return m;
    m = new Map();
    const d = this.ownerDir(owner);
    if (existsSync(d)) {
      for (const f of readdirSync(d)) {
        if (!f.endsWith(".json")) continue;
        try {
          const rec = JSON.parse(readFileSync(join(d, f), "utf8")) as ExchangeRecord;
          if (rec && rec.v === 1 && rec.owner === owner && SAFE_ID.test(rec.id) && Array.isArray(rec.messages)) m.set(rec.id, rec);
        } catch { /* a damaged file is skipped, never fatal */ }
      }
    }
    this.cache.set(owner, m);
    return m;
  }

  private save(rec: ExchangeRecord): void {
    const d = this.ownerDir(rec.owner);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    const file = join(d, `${rec.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    renameSync(tmp, file);
  }

  onChange(fn: (owner: string, rec: ExchangeRecord) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** The exchange of a pair, created empty on first use. */
  ensure(owner: string, x: Party, y: Party): ExchangeRecord {
    const [a, b] = pairOf(x, y);
    const id = exchangeId(owner, a, b);
    const m = this.load(owner);
    let rec = m.get(id);
    if (!rec) {
      const t = this.now();
      rec = { v: 1, id, owner, a, b, createdAt: t, updatedAt: t, messages: [], seenAt: t, sinceUser: 0 };
      m.set(id, rec);
      this.save(rec);
    }
    return rec;
  }

  get(owner: string, id: string): ExchangeRecord | undefined {
    if (!SAFE_ID.test(id)) return undefined;
    const rec = this.load(owner).get(id);
    return rec && rec.owner === owner ? rec : undefined;
  }

  /** Adds one message. `at` is strictly increasing inside an exchange so seenAt comparisons are exact. */
  append(owner: string, x: Party, y: Party, m: { from: Party; text: string; kind: "message" | "reply"; tools?: ExTool[]; decisions?: ExDecision[] }): ExchangeMessageResult {
    const rec = this.ensure(owner, x, y);
    const last = rec.messages[rec.messages.length - 1];
    const at = Math.max(this.now(), (last?.at ?? 0) + 1);
    const text = m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)}\n[truncated ${m.text.length - MAX_MESSAGE_CHARS} chars]` : m.text;
    const msg: ExMessage = {
      id: "m_" + createHash("sha256").update(`${rec.id}|${at}|${rec.messages.length}`).digest("hex").slice(0, 12),
      from: m.from, text, at, kind: m.kind,
      ...(m.decisions?.length ? { decisions: m.decisions.slice(0, 6).map((d) => ({ id: String(d.id).slice(0, 80), role: d.role === "receiver" ? "receiver" as const : "requester" as const })) } : {}),
      ...(m.tools?.length ? { tools: m.tools.slice(0, MAX_TOOLS).map((t) => ({ name: String(t.name).slice(0, 60), ok: !!t.ok, preview: String(t.preview ?? "").slice(0, 300) })) } : {}),
    };
    rec.messages.push(msg);
    if (rec.messages.length > MAX_EXCHANGE_MESSAGES) rec.messages.splice(0, rec.messages.length - MAX_EXCHANGE_MESSAGES);
    if (m.kind === "message") rec.sinceUser++;
    rec.updatedAt = at;
    this.save(rec);
    for (const l of this.listeners) { try { l(owner, rec); } catch { /* a listener never blocks a write */ } }
    return { exchange: rec, message: msg };
  }

  /** The user spoke (a user-driven turn started the call): the loop guard starts over. */
  resetUser(owner: string, x: Party, y: Party): void {
    const rec = this.ensure(owner, x, y);
    if (rec.sinceUser !== 0) { rec.sinceUser = 0; this.save(rec); }
  }

  /** Everything up to now has been seen by the user (they were there, or they opened it). */
  markSeen(owner: string, id: string): boolean {
    const rec = this.get(owner, id);
    if (!rec) return false;
    const t = rec.messages[rec.messages.length - 1]?.at ?? 0;
    if (rec.seenAt < t) { rec.seenAt = t; this.save(rec); }
    return true;
  }

  summary(rec: ExchangeRecord): ExchangeSummary {
    const last = rec.messages[rec.messages.length - 1];
    return {
      id: rec.id, a: rec.a, b: rec.b, updatedAt: rec.updatedAt, count: rec.messages.length,
      unread: rec.messages.filter((x) => x.at > rec.seenAt).length,
      ...(last ? { last: { from: last.from, text: last.text.slice(0, 200), at: last.at, kind: last.kind } } : {}),
    };
  }

  /** Newest first. Exchanges nobody has written to yet are left out. */
  list(owner: string): ExchangeSummary[] {
    return [...this.load(owner).values()].filter((r) => r.messages.length).map((r) => this.summary(r)).sort((p, q) => q.updatedAt - p.updatedAt);
  }

  /** A bot was deleted: every exchange it was part of goes with it. */
  purgeBot(owner: string, botId: string): number {
    const m = this.load(owner);
    let n = 0;
    for (const [id, rec] of [...m]) {
      if (rec.a !== botId && rec.b !== botId) continue;
      m.delete(id);
      try { rmSync(join(this.ownerDir(owner), `${id}.json`), { force: true }); } catch { /* already gone */ }
      n++;
    }
    return n;
  }
}

export interface ExchangeMessageResult { exchange: ExchangeRecord; message: ExMessage }
