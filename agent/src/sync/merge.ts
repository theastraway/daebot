// Session sync: the pure merge rules. A session is one StoredSession record. Two devices that both changed it converge on
// the same record by these rules:
//   - the visible transcript (history) is APPEND-ONLY and keyed by message id: the union of both sides, never a loss;
//     for the same id the newer writer (the record with the later updatedAt) wins its version of that message;
//   - everything else (title, model, archived, unread marker, per-message reactions, task board...) is last-writer-wins on the
//     whole record by updatedAt;
//   - the model context (state) comes from the side whose transcript is more complete, so a resumed chat never forgets a message.
import { createHash } from "node:crypto";
import type { StoredSession } from "../persist.ts";
import type { HistoryEvent } from "../types.ts";

/** Stable identity of one transcript item: its message id, else a hash of its content. */
function baseKey(ev: HistoryEvent): string {
  const id = (ev as { id?: unknown }).id;
  if (typeof id === "string" && id) return `i:${id}`;
  return `h:${createHash("sha1").update(JSON.stringify(ev)).digest("hex").slice(0, 20)}`;
}

/** Keys with an occurrence counter, so two identical id-less events (two equal notices) stay two events. */
export function eventKeys(history: HistoryEvent[]): string[] {
  const seen = new Map<string, number>();
  return history.map((ev) => {
    const k = baseKey(ev);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return `${k}#${n}`;
  });
}

/** Union of two transcripts. `primary` keeps its order and its version of every shared message; items only the other side has are
 *  inserted after the item that preceded them on that side. */
export function mergeHistory(primary: HistoryEvent[], other: HistoryEvent[]): HistoryEvent[] {
  if (other.length === 0) return primary;
  const pk = eventKeys(primary);
  const ok = eventKeys(other);
  const have = new Set(pk);
  const onlyOther = ok.filter((k) => !have.has(k));
  if (onlyOther.length === 0) return primary;
  const out = primary.slice();
  const outKeys = pk.slice();
  let anchor = -1; // index in `out` of the last item of `other` that is already placed
  for (let i = 0; i < other.length; i++) {
    const at = outKeys.indexOf(ok[i]);
    if (at !== -1) { anchor = at; continue; }
    anchor += 1;
    out.splice(anchor, 0, other[i]);
    outKeys.splice(anchor, 0, ok[i]);
  }
  return out;
}

/** The time of the latest change of a record: a new message (updatedAt) or a rename / archive (metaAt). */
export const changeAt = (r: Pick<StoredSession, "updatedAt" | "metaAt">): number => Math.max(r.updatedAt, r.metaAt ?? 0);

/** A cheap fingerprint of a record: equal sigs mean "nothing to exchange". */
export function recordSig(rec: Pick<StoredSession, "updatedAt" | "history"> & { metaAt?: number }): string {
  const h = rec.history;
  const last = h.length ? baseKey(h[h.length - 1]) : "";
  return `${changeAt(rec)}:${h.length}:${last}`;
}

function pickWinner(a: StoredSession, b: StoredSession): { win: StoredSession; lose: StoredSession } {
  if (changeAt(a) !== changeAt(b)) return changeAt(a) > changeAt(b) ? { win: a, lose: b } : { win: b, lose: a };
  if (a.history.length !== b.history.length) return a.history.length > b.history.length ? { win: a, lose: b } : { win: b, lose: a };
  return { win: b, lose: a }; // a tie: the incoming side (b) wins, so repeated merges settle instead of flipping
}

/** Merges the local copy `a` (may be absent) with the incoming copy `b`. The result keeps `owner` of `a` when it exists, else `b`'s. */
export function mergeRecords(a: StoredSession | undefined, b: StoredSession): StoredSession {
  if (!a) return b;
  const { win, lose } = pickWinner(a, b);
  const history = mergeHistory(win.history, lose.history);
  const moreComplete = history.length > win.history.length && lose.history.length >= win.history.length ? lose : win;
  const out: StoredSession = {
    ...win,
    owner: a.owner ?? b.owner,
    tier: a.tier, // the local identity tier always stands
    createdAt: Math.min(a.createdAt || b.createdAt, b.createdAt || a.createdAt),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    ...(Math.max(a.metaAt ?? 0, b.metaAt ?? 0) ? { metaAt: Math.max(a.metaAt ?? 0, b.metaAt ?? 0) } : {}),
    history,
    state: moreComplete.state,
    violations: moreComplete.violations,
  };
  // A thread the winner has no value for keeps the other side's (bot, peer and model never vanish in a merge).
  for (const k of ["bot", "peer", "model"] as const) if (out[k] === undefined && lose[k] !== undefined) out[k] = lose[k];
  return out;
}
