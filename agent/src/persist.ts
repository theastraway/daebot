// Server-side session persistence. One JSON file per session under DATA_DIR/sessions so a restart or redeploy
// does not lose chats. Hosted: DATA_DIR=/data (a Render persistent disk). Local default: ~/.mindclaw/data.
// Zero dependencies; writes are atomic (tmp + rename) and serialized per session.
import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { rename, writeFile, mkdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HistoryEvent, Message, SessionState, Violation } from "./types.ts";

export interface RunMark { id: string; status: "running" | "done" | "error" | "interrupted"; startedAt: number; updatedAt: number }

export interface StoredSession {
  v: 1;
  id: string;
  surface: string;
  title: string;
  tier: string;
  /** Principal that owns the session ("owner" for the access-code login, else the MIND user id). Absent on old records = "owner". */
  owner?: string;
  /** Bot id when this is a thread of a bot (its home MIND is the bot's). Absent = a plain session. */
  bot?: string;
  /** Bot-to-bot DM thread: the other end ("main" for a person's session, else a bot id). */
  peer?: string;
  /** Model this session runs on (absent = the default). */
  model?: string;
  /** The latest turn. "running" on disk with no live owner process = the server died mid-turn (shown as interrupted). */
  run?: RunMark;
  createdAt: number;
  updatedAt: number;
  state: SessionState;
  violations: Violation[];
  history: HistoryEvent[];
}

export interface StoredMeta { id: string; surface: string; title: string; updatedAt: number; owner?: string; bot?: string; peer?: string; model?: string }

function metaOf(rec: StoredSession): StoredMeta {
  return { id: rec.id, surface: rec.surface, title: rec.title, updatedAt: rec.updatedAt, owner: rec.owner, bot: rec.bot, peer: rec.peer, model: rec.model };
}

export interface SessionStore {
  save(rec: StoredSession): Promise<void>;
  load(id: string): StoredSession | undefined;
  list(): StoredMeta[];
  /** Cheap ownership lookup (no file read after the first scan). */
  meta?(id: string): StoredMeta | undefined;
  /** Deletes a saved session (used when a bot is deleted: its threads go with it). */
  remove?(id: string): Promise<void>;
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const d = (env.DATA_DIR ?? "").trim();
  return d || join(env.HOME || homedir(), ".mindclaw", "data");
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Session ids come from clients (resumeId), so they never reach the filesystem unless they are plainly safe. */
export function fileNameFor(id: string): string {
  return SAFE_ID.test(id) ? `${id}.json` : `h-${createHash("sha256").update(id).digest("hex").slice(0, 40)}.json`;
}

function validRecord(v: unknown): v is StoredSession {
  const r = v as Partial<StoredSession> | null;
  return !!r && typeof r === "object" && r.v === 1 && typeof r.id === "string" && !!r.state && Array.isArray(r.state.messages) && Array.isArray(r.history);
}

export function createFileStore(dir: string): SessionStore {
  const root = join(dir, "sessions");
  try { mkdirSync(root, { recursive: true, mode: 0o700 }); } catch { /* surfaced on first save */ }
  const index = new Map<string, StoredMeta>();
  let scanned = false;
  const queues = new Map<string, Promise<void>>();

  function scan(): void {
    if (scanned) return;
    scanned = true;
    let names: string[] = [];
    try { names = readdirSync(root); } catch { return; }
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(root, n), "utf8"));
        if (validRecord(rec)) index.set(rec.id, metaOf(rec));
      } catch { /* a torn or foreign file is skipped, never fatal */ }
    }
  }

  return {
    save(rec) {
      const file = join(root, fileNameFor(rec.id));
      // Screenshots are sent to the model once and never written to disk (size, and they can show anything on screen).
      const data = JSON.stringify(rec, (k, v) => (k === "images" ? undefined : v));
      const prev = queues.get(rec.id) ?? Promise.resolve();
      const next = prev.catch(() => {}).then(async () => {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, data, { mode: 0o600 });
        await rename(tmp, file);
        index.set(rec.id, metaOf(rec));
      });
      queues.set(rec.id, next);
      return next.finally(() => { if (queues.get(rec.id) === next) queues.delete(rec.id); });
    },
    load(id) {
      const file = join(root, fileNameFor(id));
      if (!existsSync(file)) return undefined;
      try {
        const rec = JSON.parse(readFileSync(file, "utf8"));
        return validRecord(rec) && rec.id === id ? rec : undefined;
      } catch { return undefined; }
    },
    list() {
      scan();
      return [...index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    meta(id) {
      scan();
      return index.get(id);
    },
    async remove(id) {
      scan();
      const prev = queues.get(id) ?? Promise.resolve();
      await prev.catch(() => {});
      index.delete(id);
      await unlink(join(root, fileNameFor(id))).catch(() => {});
    },
  };
}

/**
 * A crash mid-turn can leave an assistant tool call without its result (or a result without its call);
 * providers reject that shape. Drop the orphans so a resumed session always sends a valid history.
 */
export function repairMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool") continue; // re-added below, only after a call that owns it
    if (m.role === "assistant" && m.toolCalls?.length) {
      const results = new Map<string, Message>();
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") { const t = messages[j]; if (t.toolCallId) results.set(t.toolCallId, t); j++; }
      const answered = m.toolCalls.filter((c) => results.has(c.id));
      if (answered.length === m.toolCalls.length) {
        out.push(m);
        for (const c of m.toolCalls) out.push(results.get(c.id)!);
      } else if (m.content.trim()) {
        out.push({ role: "assistant", content: m.content });
      }
      i = j - 1;
      continue;
    }
    out.push(m);
  }
  return out;
}
