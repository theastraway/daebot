// Shared threads: a MIND user adds other MIND users to one thread of theirs (a bot's thread or a main chat). The invitee uses it from their OWN
// Daebot login; it is listed under "Shared Threads". The share itself is MIND's own Agent Session share (agent_session_shares: viewer = read, editor =
// read + post), so it is managed "through MIND": the same grant shows in MIND, MIND sends the in-app notification, and revoking it in either place
// takes effect here. Nothing about the thread is copied: the invitee reads and posts into the OWNER's live session, which runs where the owner's bot
// runs (its home device) and is billed to the owner's account.
//
// This module only talks to MIND (with each person's own key) and remembers what it just read for a few seconds. It never decides what a thread
// shows; the gateway does that after `grantFor` says yes.
import type { MindClient } from "../types.ts";
import type { Principal } from "../auth/users.ts";
import { userIdFor } from "../auth/users.ts";

export type ShareRole = "viewer" | "editor";

export interface SharedGrant {
  /** The Daebot session id (the same id the owner uses). */
  sessionId: string;
  /** The MIND Agent Session id the grant hangs on. */
  mid: string;
  ownerId: string;
  ownerUsername: string;
  ownerLabel: string;
  role: ShareRole;
  sourceKey: string;
  title: string;
  sharedAt?: string;
  unread: number;
  muted: boolean;
  updatedAt?: string;
}

export interface ShareMember { shareId: string; username: string; label: string; role: ShareRole; avatar?: string; sharedAt?: string }
export interface ShareTarget { username: string; label: string; avatar?: string }

export class ShareError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface SharedThreadsDeps {
  /** A MIND client signed in as this person (their own key). undefined = this person has no MIND key here. */
  mindFor(p: Principal): MindClient | undefined;
  /** How long a person's list of shared threads is trusted (default 3 s). A change made through this module drops it at once. */
  ttlMs?: number;
  now?: () => number;
  /** A grant was removed: the gateway closes that person's open streams of the thread. */
  onRevoke?(granteeId: string, sessionId: string): void;
}

/** Only Daebot's own Agent Sessions can be shared here: `daebot` (main chats) and `daebot-bot-<slug>` (a bot's threads). */
export const DAEBOT_SOURCE = /^daebot(-bot-[A-Za-z0-9._-]+)?$/;

const asRole = (v: unknown): ShareRole => (String(v ?? "").toLowerCase() === "viewer" || String(v ?? "").toLowerCase() === "view" ? "viewer" : "editor");
const str = (v: unknown, n = 200): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v)).trim().slice(0, n);

function parse(raw: string): Record<string, any> {
  try { const j = JSON.parse(raw); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}

function httpStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

/** A readable reason for a MIND failure. */
function reason(e: unknown, fallback: string): ShareError {
  const st = httpStatus(e);
  const msg = String((e as Error)?.message ?? e);
  const detail = /HTTP \d+ (.*)$/.exec(msg)?.[1]?.replace(/^"|"$/g, "") ?? "";
  if (st === 404) return new ShareError(404, detail || "not found");
  if (st === 400) return new ShareError(400, detail || "that share was not accepted");
  if (st === 403) return new ShareError(502, "MIND did not allow this sign-in to share threads yet. Sign out and in again.");
  return new ShareError(502, fallback);
}

export class SharedThreads {
  private d: SharedThreadsDeps;
  private lists = new Map<string, { at: number; rows: SharedGrant[] }>();
  private mids = new Map<string, string>();
  private ttl: number;
  private now: () => number;

  constructor(d: SharedThreadsDeps) {
    this.d = d;
    this.ttl = d.ttlMs ?? 3000;
    this.now = d.now ?? Date.now;
  }

  private client(p: Principal): MindClient {
    const c = p.owner ? undefined : this.d.mindFor(p);
    if (!c) throw new ShareError(403, "Sign in with your MIND account to share threads.");
    return c;
  }

  /** Forgets what was read for this person (their next read goes to MIND). */
  invalidate(uid: string): void { this.lists.delete(uid); }

  // ---------------------------------------------------------------------------------------------------------------- invitee side
  /** The threads shared WITH this person, newest first. Throws when MIND cannot be reached and nothing recent is remembered. */
  async listFor(me: Principal): Promise<SharedGrant[]> {
    if (me.owner) return [];
    const have = this.lists.get(me.id);
    if (have && this.now() - have.at < this.ttl) return have.rows;
    let rows: SharedGrant[];
    try {
      const c = this.d.mindFor(me);
      if (!c) return [];
      const data = parse(await c.call("agent_sessions", { action: "list", shared_only: true, limit: 200 }));
      rows = [];
      for (const s of Array.isArray(data.sessions) ? data.sessions : []) {
        const sh = s?.shared;
        const source = str(s?.source_key, 120);
        const ext = str(s?.external_session_id, 200);
        if (!sh?.shared_with_me || !DAEBOT_SOURCE.test(source) || !ext || !s.session_id) continue;
        const owner = str(sh.owner ?? s.user_id, 120);
        if (!owner || owner.toLowerCase() === me.username.toLowerCase()) continue;
        rows.push({
          sessionId: ext, mid: str(s.session_id, 120), ownerId: userIdFor(owner), ownerUsername: owner, ownerLabel: str(sh.owner_label, 80) || owner,
          role: asRole(sh.role), sourceKey: source, title: str(s.title, 200), sharedAt: str(sh.shared_at, 40) || undefined,
          unread: Number(sh.unread) || 0, muted: !!sh.muted, updatedAt: str(s.last_activity_at ?? s.updated_at, 40) || undefined,
        });
      }
    } catch (e) {
      // MIND is unreachable: a grant read in the last minute still stands (a revoke made in that minute shows once MIND answers); otherwise nothing is allowed.
      if (have && this.now() - have.at < 60_000) return have.rows;
      throw reason(e, "Could not read the threads shared with you.");
    }
    this.lists.set(me.id, { at: this.now(), rows });
    return rows;
  }

  /** What this person may do with one thread, or undefined (no access at all). */
  async grantFor(me: Principal, sessionId: string): Promise<SharedGrant | undefined> {
    try { return (await this.listFor(me)).find((g) => g.sessionId === sessionId); } catch { return undefined; }
  }

  // ---------------------------------------------------------------------------------------------------------------- owner side
  /** MIND's Agent Session for one of the owner's threads (opened on first use; the same one the session logger writes to). */
  private async midFor(owner: Principal, t: { sessionId: string; sourceKey: string; title: string }): Promise<string> {
    if (!DAEBOT_SOURCE.test(t.sourceKey)) throw new ShareError(400, "This thread cannot be shared.");
    const key = `${owner.id}|${t.sourceKey}|${t.sessionId}`;
    const have = this.mids.get(key);
    if (have) return have;
    try {
      const data = parse(await this.client(owner).call("agent_sessions", { action: "open", source_key: t.sourceKey, external_session_id: t.sessionId, runtime: "mindclaw", title: (t.title || "Daebot thread").slice(0, 200) }));
      if (!data.session_id) throw new ShareError(502, "MIND did not return the thread.");
      this.mids.set(key, String(data.session_id));
      return String(data.session_id);
    } catch (e) { if (e instanceof ShareError) throw e; throw reason(e, "Could not reach MIND to share this thread."); }
  }

  async members(owner: Principal, t: { sessionId: string; sourceKey: string; title: string }): Promise<ShareMember[]> {
    const mid = await this.midFor(owner, t);
    try {
      const data = parse(await this.client(owner).call("agent_sessions", { action: "shares", session_id: mid }));
      return (Array.isArray(data.shares) ? data.shares : []).map((s: any) => ({
        shareId: str(s.id, 80), username: str(s.grantee_username, 120), label: str(s.grantee_label, 80) || str(s.grantee_username, 120), role: asRole(s.role),
        ...(s.grantee_avatar ? { avatar: str(s.grantee_avatar, 400) } : {}), ...(s.shared_at || s.created_at ? { sharedAt: str(s.shared_at ?? s.created_at, 40) } : {}),
      })).filter((m: ShareMember) => m.shareId && m.username);
    } catch (e) { if (e instanceof ShareError) throw e; throw reason(e, "Could not read who this thread is shared with."); }
  }

  async add(owner: Principal, t: { sessionId: string; sourceKey: string; title: string }, username: string, role: ShareRole = "editor"): Promise<ShareMember[]> {
    const who = username.trim().replace(/^@/, "");
    if (!who) throw new ShareError(400, "Choose a person to share with.");
    if (who.toLowerCase() === owner.username.toLowerCase()) throw new ShareError(400, "You can't share a thread with yourself.");
    const mid = await this.midFor(owner, t);
    try {
      await this.client(owner).call("agent_sessions", { action: "share_add", session_id: mid, grantee_username: who, role });
    } catch (e) { if (e instanceof ShareError) throw e; throw reason(e, "Could not share this thread."); }
    this.invalidate(userIdFor(who));
    return this.members(owner, t);
  }

  /** Removes one person (by MIND username) from a thread. Their access ends now: the next request is refused and their open streams close. */
  async remove(owner: Principal, t: { sessionId: string; sourceKey: string; title: string }, username: string): Promise<ShareMember[]> {
    const list = await this.members(owner, t);
    const m = list.find((x) => x.username.toLowerCase() === username.trim().toLowerCase());
    if (!m) throw new ShareError(404, "That person is not on this thread.");
    const mid = await this.midFor(owner, t);
    try {
      await this.client(owner).call("agent_sessions", { action: "share_remove", session_id: mid, share_id: m.shareId });
    } catch (e) { if (e instanceof ShareError) throw e; throw reason(e, "Could not remove that person."); }
    const gid = userIdFor(m.username);
    this.invalidate(gid);
    this.d.onRevoke?.(gid, t.sessionId);
    return list.filter((x) => x.shareId !== m.shareId);
  }

  /** Existing MIND accounts to share with (username prefix, or an exact email). MIND returns no email. */
  async search(owner: Principal, q: string): Promise<ShareTarget[]> {
    const needle = q.trim();
    if (needle.length < 2) return [];
    try {
      const data = parse(await this.client(owner).call("agent_sessions", { action: "share_targets", q: needle, limit: 8 }));
      return (Array.isArray(data.users) ? data.users : []).map((u: any) => ({ username: str(u.username, 120), label: str(u.label, 80) || str(u.username, 120), ...(u.avatar_url ? { avatar: str(u.avatar_url, 400) } : {}) })).filter((u: ShareTarget) => u.username && u.username.toLowerCase() !== owner.username.toLowerCase());
    } catch (e) { if (e instanceof ShareError) throw e; throw reason(e, "Could not search MIND people."); }
  }
}

/** The label a participant's message carries in the shared thread. The gateway writes it; the web page shows it as a name above the message. */
export const SENDER_MARK = /^⟦([^⟧\n]{1,60})⟧ /;
export function attribute(name: string, text: string): string {
  const clean = name.replace(/[⟦⟧\n]/g, "").trim().slice(0, 60) || "guest";
  return `⟦${clean}⟧ ${text.replace(/[⟦⟧]/g, (c) => (c === "⟦" ? "[" : "]"))}`;
}
