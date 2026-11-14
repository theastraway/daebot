// Photos travel with the chat they were attached to. The transcript names a photo by id ([photo p1: ...]); the bytes live in each device's own
// PhotoStore. After a session syncs, the two sides trade the photos the other one is missing, under the same ids.
import type { HistoryEvent } from "../types.ts";
import type { PhotoMeta, PhotoStore } from "../photos.ts";
import { MAX_DOC_BYTES, MAX_PHOTO_BYTES } from "../photos.ts";
import type { SyncHttp } from "./http.ts";

/** Photo ids a transcript refers to, in order, without repeats. */
export function photoIdsIn(history: HistoryEvent[]): string[] {
  const out: string[] = [];
  for (const ev of history) if (ev.type === "user" && Array.isArray(ev.photos)) for (const p of ev.photos) if (p && typeof p.id === "string" && !out.includes(p.id)) out.push(p.id);
  return out;
}

export interface PhotoPayload { meta: PhotoMeta; data: string }
const enc = (id: string) => encodeURIComponent(id);

/** Brings both sides to the same photos for one session. Throws on a transport error (the caller retries next round); a photo the server
 *  refuses for good (too big, storage full) is skipped and reported in `refused`. */
export async function reconcilePhotos(o: { http: SyncHttp; photos: PhotoStore; sessionId: string; want: string[] }): Promise<{ down: number; up: number; refused: string[] }> {
  const { http, photos, sessionId, want } = o;
  const remote = (await http.json<{ photos: PhotoMeta[] }>("GET", `/api/sync/photos/${enc(sessionId)}`)).photos;
  const rids = new Set(remote.map((p) => p.id));
  const local = photos.list(sessionId);
  const lids = new Set(local.map((p) => p.id));
  let down = 0, up = 0;
  const refused: string[] = [];
  for (const m of remote) {
    if (lids.has(m.id) || !want.includes(m.id)) continue;
    const r = await http.json<PhotoPayload>("GET", `/api/sync/photos/${enc(sessionId)}/${enc(m.id)}`);
    const added = await photos.importPhoto(sessionId, r.meta, Buffer.from(r.data, "base64"));
    if (added.ok) down++; else refused.push(m.id);
  }
  for (const m of local) {
    if (rids.has(m.id) || m.bytes > (m.kind === "document" ? MAX_DOC_BYTES : MAX_PHOTO_BYTES)) continue;
    const hit = await photos.read(sessionId, m.id);
    if (!hit) continue;
    try {
      await http.json("POST", `/api/sync/photos/${enc(sessionId)}/${enc(m.id)}`, { meta: m, data: hit.data.toString("base64") });
      up++;
    } catch (e) {
      const st = (e as { status?: number }).status;
      if (st === 413 || st === 415 || st === 400 || st === 404) refused.push(m.id); else throw e;
    }
  }
  return { down, up, refused };
}
