// Live-call chat bindings. One JSON file on the gateway's data disk (DATA_DIR/voice-calls.json), the same
// place sessions, users and the other ledgers already live. There is no SQL or KV in this process: a second
// gateway sees a binding only when it shares that directory (one Render disk, or one machine). Lookups re-read
// the file so the other process's write is visible. Writes are tmp + rename. Expired rows are dropped on the
// next lookup. Last writer wins if two processes rewrite the file in the same instant; a call is one row.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LiveCall { chatId: string; startedAt: number; expiresAt: number }

interface FileShape { v: 1; owners: Record<string, Record<string, LiveCall>> }

export interface CallBook {
  get(owner: string, slug: string): LiveCall | undefined;
  put(owner: string, slug: string, call: LiveCall): void;
  delete(owner: string, slug: string): void;
}

const empty = (): FileShape => ({ v: 1, owners: {} });

function validCall(v: unknown): v is LiveCall {
  const c = v as Partial<LiveCall> | null;
  return !!c && typeof c.chatId === "string" && c.chatId.length > 0 && typeof c.startedAt === "number" && typeof c.expiresAt === "number";
}

function parse(raw: string): FileShape | undefined {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return undefined; }
  const rec = j as { v?: unknown; owners?: unknown } | null;
  if (!rec || rec.v !== 1 || !rec.owners || typeof rec.owners !== "object") return undefined;
  const owners: FileShape["owners"] = {};
  for (const [owner, bots] of Object.entries(rec.owners as Record<string, unknown>)) {
    if (!bots || typeof bots !== "object") continue;
    const m: Record<string, LiveCall> = {};
    for (const [slug, c] of Object.entries(bots as Record<string, unknown>)) if (validCall(c)) m[slug] = { chatId: c.chatId, startedAt: c.startedAt, expiresAt: c.expiresAt };
    if (Object.keys(m).length) owners[owner] = m;
  }
  return { v: 1, owners };
}

/** Drop rows whose call has ended. Returns whether the shape changed. */
function purge(shape: FileShape, now: number): boolean {
  let dropped = false;
  for (const [owner, bots] of Object.entries(shape.owners)) {
    for (const [slug, c] of Object.entries(bots)) if (c.expiresAt <= now) { delete bots[slug]; dropped = true; }
    if (!Object.keys(bots).length) { delete shape.owners[owner]; dropped = true; }
  }
  return dropped;
}

function memoryBook(now: () => number): CallBook {
  const mem = new Map<string, LiveCall>();
  const key = (owner: string, slug: string) => `${owner}\n${slug}`;
  const sweep = () => { const t = now(); for (const [k, c] of mem) if (c.expiresAt <= t) mem.delete(k); };
  return {
    get(owner, slug) { sweep(); return mem.get(key(owner, slug)); },
    put(owner, slug, call) { sweep(); mem.set(key(owner, slug), call); },
    delete(owner, slug) { mem.delete(key(owner, slug)); },
  };
}

function fileBook(file: string, now: () => number): CallBook {
  // ok: the file was missing or parsed. A torn read is not ok: do not replace the file with a guess.
  const read = (): { shape: FileShape; ok: boolean } => {
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? { shape: empty(), ok: true } : { shape: empty(), ok: false }; }
    const shape = parse(raw);
    return shape ? { shape, ok: true } : { shape: empty(), ok: false };
  };
  const write = (shape: FileShape) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(shape), { mode: 0o600 });
    renameSync(tmp, file);
  };
  return {
    get(owner, slug) {
      const { shape, ok } = read();
      if (!ok) return undefined;
      const dropped = purge(shape, now());
      const row = shape.owners[owner]?.[slug];
      if (dropped) { try { write(shape); } catch { /* the next lookup drops them again */ } }
      return row;
    },
    put(owner, slug, call) {
      const { shape, ok } = read();
      if (!ok) throw new Error("voice-calls file is unreadable");
      purge(shape, now());
      (shape.owners[owner] ??= {})[slug] = call;
      write(shape);
    },
    delete(owner, slug) {
      const { shape, ok } = read();
      if (!ok) return;
      const dropped = purge(shape, now());
      const bots = shape.owners[owner];
      if (bots?.[slug]) {
        delete bots[slug];
        if (!Object.keys(bots).length) delete shape.owners[owner];
        write(shape);
      } else if (dropped) {
        try { write(shape); } catch { /* next lookup */ }
      }
    },
  };
}

/** `file` omitted: this process only. The gateway always passes the data-dir file. */
export function createCallBook(o: { file?: string; now?: () => number } = {}): CallBook {
  const now = o.now ?? (() => Date.now());
  return o.file ? fileBook(o.file, now) : memoryBook(now);
}
