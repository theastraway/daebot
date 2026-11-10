// Session sync wire format. A saved session travels between the desktop app and daebot.live as one JSON record.
// Bot ids are local to each side (each store mints its own b_<hex> for the same MIND bot), so a thread names its bot by SLUG on the
// wire and each side maps the slug back to its own id. The owner never travels: the receiver stamps its own principal.
import type { StoredSession } from "../persist.ts";
import type { BotsApi } from "../bots/types.ts";

export type WireRecord = Omit<StoredSession, "owner" | "bot" | "peer" | "run" | "tier"> & { botSlug?: string; peerSlug?: string };

export const MAX_RECORD_BYTES = 6 * 1024 * 1024;
export const MAX_HISTORY_EVENTS = 50_000;
/** Routine runs are per-runtime bookkeeping (each side has its own routines): they never sync. */
export const NOT_SYNCED_SURFACES: ReadonlySet<string> = new Set(["routine"]);

/** `undefined` = this thread cannot be mapped to a slug yet (its bot is unknown here), so it is not sent. */
export function toWire(rec: StoredSession, bots: BotsApi | undefined): WireRecord | undefined {
  if (NOT_SYNCED_SURFACES.has(rec.surface)) return undefined;
  const { owner: _o, bot, peer, run: _r, tier: _t, ...rest } = rec;
  const out: WireRecord = rest;
  if (bot) {
    const slug = bots?.get(bot)?.slug;
    if (!slug) return undefined;
    out.botSlug = slug;
  }
  if (peer) {
    if (peer === "main") out.peerSlug = "main";
    else {
      const slug = bots?.get(peer)?.slug;
      if (!slug) return undefined;
      out.peerSlug = slug;
    }
  }
  return out;
}

export function validWire(v: unknown): v is WireRecord {
  const r = v as Partial<WireRecord> | null;
  return !!r && typeof r === "object" && r.v === 1 && typeof r.id === "string" && r.id.length > 0 && r.id.length <= 200
    && typeof r.surface === "string" && typeof r.title === "string" && typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt)
    && typeof r.createdAt === "number" && !!r.state && Array.isArray(r.state.messages) && Array.isArray(r.history) && r.history.length <= MAX_HISTORY_EVENTS
    && Array.isArray(r.violations);
}

export type FromWire = { ok: true; rec: StoredSession } | { ok: false; reason: "nobot"; slug: string } | { ok: false; reason: "invalid" };

/** Maps a wire record onto this side's bot ids and stamps `owner`. */
/** `tier` is THIS side's identity tier for the owner: a tier never travels (a desktop admin chat must not become an admin chat on the server). */
export function fromWire(w: unknown, bots: BotsApi | undefined, owner: string, tier: string): FromWire {
  if (!validWire(w)) return { ok: false, reason: "invalid" };
  const { botSlug, peerSlug, ...rest } = w;
  const rec: StoredSession = { ...rest, owner, tier };
  if (botSlug) {
    const b = bots?.bySlug(botSlug);
    if (!b) return { ok: false, reason: "nobot", slug: botSlug };
    rec.bot = b.id;
  }
  if (peerSlug) {
    if (peerSlug === "main") rec.peer = "main";
    else {
      const b = bots?.bySlug(peerSlug);
      if (!b) return { ok: false, reason: "nobot", slug: peerSlug };
      rec.peer = b.id;
    }
  }
  return { ok: true, rec };
}
