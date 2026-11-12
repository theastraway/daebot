// Per-owner bot store: DATA_DIR/bots/<ownerId>/bots.json + <botId>/DAEBOT.md.
// MIND is the source of truth for a bot's EXISTENCE (its workspace lives there); this store holds the local
// presentation (name, purpose, color) and the DAEBOT.md instructions. Create calls MIND first, delete calls MIND first.
// One store instance serves ONE owner, so another owner's bot id is simply unknown ("not found").
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MindClient } from "../types.ts";
import { LATEST_BOT_VERSION } from "./versions.ts";
import { isFaceId } from "./faces.ts";
import { canonVoice, cleanVoice } from "./voice.ts";
import { validModelId } from "../settings.ts";
import { BotError, MAX_INSTRUCTIONS_BYTES, MAX_REMOTE_LOG, SLUG_RE, cleanDevice, safeUpgradeUrl } from "./types.ts";
import type { BotRecord, BotsApi, RemoteDevice, RosterEntry } from "./types.ts";
import { canonBot, mergeWireBot as mergeWire, sigOf } from "../sync/bots.ts";
import type { WireBot } from "../sync/bots.ts";

/** The MIND side: POST/GET/DELETE /developer/v1/bots, always with the user's MAIN key. */
export interface BotMindApi {
  list(): Promise<{ slug: string; label?: string }[]>;
  create(slug: string, label: string): Promise<void>;
  remove(slug: string): Promise<void>;
}

interface Failure { status?: number; payload?: any; message?: string }

function failureOf(e: unknown): Failure {
  const x = e as Failure;
  return { status: typeof x?.status === "number" ? x.status : undefined, payload: x?.payload, message: String((e as Error)?.message ?? e) };
}

export function botMindApi(client: MindClient): BotMindApi {
  const run = async (args: Record<string, unknown>): Promise<unknown> => {
    const text = await client.call("bots", args);
    try { return JSON.parse(text); } catch { return text; }
  };
  return {
    async list() {
      let data: any;
      try { data = await run({ action: "list" }); } catch (e) { throw new BotError(502, "mind_unreachable", `could not list bots in MIND (${failureOf(e).message?.slice(0, 120)})`); }
      if (!data || !Array.isArray(data.bots)) throw new BotError(502, "mind_bad_response", "MIND returned an unexpected bots list");
      return data.bots.filter((b: any) => b && typeof b.slug === "string").map((b: any) => ({ slug: b.slug as string, label: typeof b.label === "string" ? b.label : undefined }));
    },
    async create(slug, label) {
      try { await run({ action: "create", slug, label }); } catch (e) {
        const f = failureOf(e);
        if (f.status === 409) throw new BotError(409, "duplicate", `a bot named "${slug}" already exists`);
        if (f.status === 402 || f.payload?.error === "bot_limit") {
          const p = f.payload ?? {};
          const limit = Number(p.limit);
          const url = safeUpgradeUrl(p.upgrade_url);
          throw new BotError(402, "bot_limit", `Your plan allows ${Number.isFinite(limit) ? limit : "a limited number of"} bots. Upgrade to add more.`, {
            ...(Number.isFinite(limit) ? { limit } : {}), tier: typeof p.tier === "string" ? p.tier.slice(0, 40) : undefined, ...(url ? { upgradeUrl: url, upgrade_url: url } : {}),
          });
        }
        throw new BotError(502, "mind_error", `MIND could not create the bot (${(f.message ?? "error").slice(0, 160)})`);
      }
    },
    async remove(slug) {
      try { await run({ action: "delete", slug }); } catch (e) {
        const f = failureOf(e);
        if (f.status === 404) return; // already gone in MIND
        throw new BotError(502, "mind_error", `MIND could not delete the bot (${(f.message ?? "error").slice(0, 160)})`);
      }
    },
  };
}

const MISS_LIMIT = 3;
const PALETTE = ["#6366f1", "#14b8a6", "#f59e0b", "#ec4899", "#22c55e", "#0ea5e9", "#a855f7", "#ef4444"];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** A face id from the allowlist, or undefined for "no face" (absent, null or ""). Anything else is a 400. */
function parseFace(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isFaceId(v)) throw new BotError(400, "bad_face", "face must be one of the listed personalities");
  return v;
}
const ID_RE = /^b_[0-9a-f]{12}$/;

function safeSegment(s: string): string {
  const v = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return v === "" || v === "." || v === ".." ? "_" : v;
}

function clip(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export interface BotStoreOptions {
  /** DATA_DIR (the store keeps its files under <dir>/bots/<owner>/). */
  dir: string;
  owner: string;
  mind: BotMindApi;
  now?: () => number;
  /** The home environment a bot created through this store gets. */
  env?: import("../env.ts").EnvTag;
}

export class BotStore implements BotsApi {
  private root: string;
  private file: string;
  private mind: BotMindApi;
  private now: () => number;
  private bots: Record<string, BotRecord> = {};
  /** Consecutive reconcile passes in which MIND did not list a bot (a bot is only dropped after MISS_LIMIT in a row). */
  private misses = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private env?: import("../env.ts").EnvTag;

  constructor(o: BotStoreOptions) {
    this.root = join(o.dir, "bots", safeSegment(o.owner));
    this.file = join(this.root, "bots.json");
    this.mind = o.mind;
    this.now = o.now ?? Date.now;
    this.env = o.env;
    this.load();
  }

  private load(): void {
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8"));
      if (j && j.v === 1 && j.bots && typeof j.bots === "object") {
        for (const [id, b] of Object.entries<any>(j.bots)) {
          if (ID_RE.test(id) && b && b.id === id && typeof b.slug === "string" && SLUG_RE.test(b.slug)) this.bots[id] = b as BotRecord;
        }
      }
    } catch { /* absent or torn file = no bots yet */ }
  }

  private save(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, bots: this.bots }), { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  /** create, remove and list run one at a time per owner. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  snapshot(): BotRecord[] {
    return Object.values(this.bots).sort((a, b) => a.createdAt - b.createdAt || a.slug.localeCompare(b.slug)).map((b) => ({ ...b }));
  }

  get(id: string): BotRecord | undefined {
    return ID_RE.test(id) && this.bots[id] ? { ...this.bots[id] } : undefined;
  }

  bySlug(slug: string): BotRecord | undefined {
    const b = Object.values(this.bots).find((x) => x.slug === slug);
    return b ? { ...b } : undefined;
  }

  roster(): RosterEntry[] {
    return this.snapshot().map((b) => ({ slug: b.slug, name: b.name, purpose: b.purpose }));
  }

  private newId(): string {
    for (;;) {
      const id = "b_" + randomBytes(6).toString("hex");
      if (!this.bots[id]) return id;
    }
  }

  /**
   * Reconciles with MIND. Only a well-formed answer changes anything. MIND is the source of truth for existence, but one odd answer
   * must never destroy a user's instructions: an EMPTY list never deletes anything, and a bot MIND stops listing is marked stale and
   * only dropped after MISS_LIMIT consecutive misses (its DAEBOT.md is moved to <root>/.trash/, never deleted).
   */
  list(): Promise<BotRecord[]> {
    return this.serial(async () => {
      let remote: { slug: string; label?: string }[];
      try { remote = await this.mind.list(); } catch { return this.snapshot(); }
      const have = new Map(Object.values(this.bots).map((b) => [b.slug, b]));
      const want = new Set(remote.map((r) => r.slug));
      let changed = false;
      for (const r of remote) {
        this.misses.delete(r.slug);
        if (have.has(r.slug) || !SLUG_RE.test(r.slug) || r.slug === "main") continue;
        const id = this.newId();
        const t = this.now();
        this.bots[id] = { id, slug: r.slug, name: clip(r.label, 80) || r.slug, purpose: "", color: PALETTE[this.colorIndex(r.slug)], createdAt: t, updatedAt: t, version: 1 };
        changed = true;
      }
      if (remote.length === 0 && have.size > 0) return this.snapshot(); // an empty answer is never proof that every bot is gone
      for (const b of have.values()) {
        if (want.has(b.slug)) continue;
        const n = (this.misses.get(b.slug) ?? 0) + 1;
        this.misses.set(b.slug, n);
        if (n < MISS_LIMIT) continue;
        this.misses.delete(b.slug);
        delete this.bots[b.id];
        this.trash(b.id);
        changed = true;
      }
      if (changed) this.save();
      return this.snapshot();
    });
  }

  /** Bots MIND did not list in the latest pass (still present locally). */
  staleSlugs(): string[] { return [...this.misses.keys()]; }

  private trash(id: string): void {
    const from = join(this.root, id);
    if (!existsSync(from)) return;
    try {
      mkdirSync(join(this.root, ".trash"), { recursive: true, mode: 0o700 });
      renameSync(from, join(this.root, ".trash", `${id}-${this.now()}`));
    } catch { /* leave it where it is rather than delete it */ }
  }

  private colorIndex(slug: string): number {
    let h = 0;
    for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % PALETTE.length;
  }

  create(a: { slug: string; name?: string; purpose?: string; color?: string; face?: unknown }): Promise<BotRecord> {
    return this.serial(() => this.createLocked(a));
  }

  private async createLocked(a: { slug: string; name?: string; purpose?: string; color?: string; face?: unknown }): Promise<BotRecord> {
    const slug = typeof a.slug === "string" ? a.slug.trim() : "";
    if (!SLUG_RE.test(slug)) throw new BotError(400, "bad_slug", "slug must be 1 to 32 characters: lowercase letters, digits and dashes");
    if (slug === "main") throw new BotError(400, "bad_slug", 'the slug "main" is reserved for your main MIND');
    if (this.bySlug(slug)) throw new BotError(409, "duplicate", `a bot named "${slug}" already exists`);
    const name = clip(a.name, 80) || slug;
    const purpose = clip(a.purpose, 500);
    const color = typeof a.color === "string" && COLOR_RE.test(a.color.trim()) ? a.color.trim().toLowerCase() : PALETTE[this.colorIndex(slug)];
    const face = parseFace(a.face);
    await this.mind.create(slug, name); // MIND first: if it refuses (limit, duplicate), nothing is written here
    const raced = this.bySlug(slug); // re-check after the await: never write a second record for one slug
    if (raced) return raced;
    const id = this.newId();
    const t = this.now();
    const rec: BotRecord = { id, slug, name, purpose, color, ...(face ? { face } : {}), ...(this.env ? { env: this.env } : {}), profileAt: t, createdAt: t, updatedAt: t, version: LATEST_BOT_VERSION };
    this.bots[id] = rec;
    try { this.save(); } catch (e) {
      delete this.bots[id];
      await this.mind.remove(slug).catch(() => {}); // do not leave an orphan workspace in MIND
      throw new BotError(500, "store_failed", `could not save the bot (${String((e as Error)?.message ?? e).slice(0, 100)})`);
    }
    return { ...rec };
  }

  update(id: string, patch: { name?: string; purpose?: string; color?: string; face?: unknown; model?: string | null; voice?: unknown; pinned?: boolean; remote?: boolean }): BotRecord {
    const b = ID_RE.test(id) ? this.bots[id] : undefined;
    if (!b) throw new BotError(404, "not_found", "no such bot");
    if (patch.name !== undefined) {
      const n = clip(patch.name, 80);
      if (!n) throw new BotError(400, "bad_name", "name cannot be empty");
      b.name = n;
    }
    if (patch.purpose !== undefined) b.purpose = clip(patch.purpose, 500);
    if (patch.face !== undefined) {
      const face = parseFace(patch.face);
      if (face) b.face = face; else delete b.face;
    }
    if (patch.model !== undefined) {
      if (patch.model === null || patch.model === "") delete b.model;
      else if (!validModelId(patch.model)) throw new BotError(400, "bad_model", "that is not a valid model id");
      else b.model = patch.model;
    }
    if (patch.voice !== undefined) {
      const vc = patch.voice === null ? undefined : cleanVoice(patch.voice);
      if (patch.voice !== null && !vc && Object.keys((patch.voice ?? {}) as object).length) throw new BotError(400, "bad_voice", "that voice setting is not valid");
      if (vc) b.voice = vc; else delete b.voice;
    }
    if (patch.color !== undefined) {
      if (typeof patch.color !== "string" || !COLOR_RE.test(patch.color.trim())) throw new BotError(400, "bad_color", "color must look like #1a2b3c");
      b.color = patch.color.trim().toLowerCase();
    }
    if (patch.pinned !== undefined) {
      if (typeof patch.pinned !== "boolean") throw new BotError(400, "bad_pinned", "pinned must be true or false");
      if (patch.pinned) { if (!b.pinnedAt) { b.pinnedAt = this.now(); b.pinAt = b.pinnedAt; } } else if (b.pinnedAt) { delete b.pinnedAt; b.pinAt = this.now(); }
    }
    if (patch.remote !== undefined) {
      if (typeof patch.remote !== "boolean") throw new BotError(400, "bad_remote", "remote must be true or false");
      this.applyRemote(b, patch.remote, { by: "user" });
    }
    // Pinning and Remote are view/connection preferences, not edits: they do not move "updated".
    if (Object.keys(patch).some((k) => k !== "pinned" && k !== "remote" && (patch as Record<string, unknown>)[k] !== undefined)) { b.updatedAt = this.now(); b.profileAt = b.updatedAt; } // the look changed: other devices take the later one
    this.save();
    return { ...b };
  }

  private applyRemote(b: BotRecord, remote: boolean, o: { by: "user" | "auto"; note?: string; at?: number; device?: RemoteDevice }): void {
    const at = o.at ?? this.now();
    const dev = cleanDevice(o.device);
    if (!remote) delete b.remoteDevice; // off = MIND Cloud: nothing is pinned
    if (!!b.remote === remote) {
      // Already in that state. A different computer named while it is on = the person moved it: pin it there and say so.
      if (remote && dev && b.remoteDevice?.id !== dev.id) {
        const was = b.remoteDevice?.name;
        b.remoteDevice = dev; b.remoteAt = Math.max(b.remoteAt ?? 0, at);
        b.remoteLog = [...(b.remoteLog ?? []), { at: b.remoteAt, remote, by: o.by, note: (o.note ?? `Moved to ${dev.name}${was ? ` from ${was}` : ""}.`).slice(0, 200) }].slice(-MAX_REMOTE_LOG);
        return;
      }
      if (remote && dev && b.remoteDevice && b.remoteDevice.name !== dev.name) b.remoteDevice = dev; // the same place under a new name
      if (b.remoteAt !== undefined || remote) b.remoteAt = Math.max(b.remoteAt ?? 0, at);
      return; // no change: nothing to log
    }
    b.remote = remote;
    b.remoteAt = at;
    if (remote && dev) b.remoteDevice = dev;
    const note = o.note ?? (o.by === "user" ? (remote ? "Turned on in settings." : "Turned off in settings.") : remote ? "Turned on automatically." : "Turned off automatically.");
    b.remoteLog = [...(b.remoteLog ?? []), { at, remote, by: o.by, note: note.slice(0, 200) }].slice(-MAX_REMOTE_LOG);
  }

  setRemote(id: string, remote: boolean, o: { by: "user" | "auto"; note?: string; at?: number; device?: RemoteDevice }): BotRecord {
    const b = ID_RE.test(id) ? this.bots[id] : undefined;
    if (!b) throw new BotError(404, "not_found", "no such bot");
    this.applyRemote(b, remote, o);
    this.save();
    return { ...b };
  }

  upgrade(id: string): BotRecord {
    const b = ID_RE.test(id) ? this.bots[id] : undefined;
    if (!b) throw new BotError(404, "not_found", "no such bot");
    b.version = LATEST_BOT_VERSION;
    b.updatedAt = this.now();
    this.save();
    return { ...b };
  }

  remove(id: string): Promise<void> {
    return this.serial(() => this.removeLocked(id));
  }

  private async removeLocked(id: string): Promise<void> {
    const b = ID_RE.test(id) ? this.bots[id] : undefined;
    if (!b) throw new BotError(404, "not_found", "no such bot");
    await this.mind.remove(b.slug); // MIND first; a failure keeps the local record so the user can retry
    delete this.bots[id];
    this.save();
    try { rmSync(join(this.root, id), { recursive: true, force: true }); } catch { /* best effort */ }
  }

  instructions(id: string): string {
    if (!ID_RE.test(id) || !this.bots[id]) return "";
    try { return readFileSync(join(this.root, id, "DAEBOT.md"), "utf8"); } catch { return ""; }
  }

  setInstructions(id: string, text: string): void {
    const b = ID_RE.test(id) ? this.bots[id] : undefined;
    if (!b) throw new BotError(404, "not_found", "no such bot");
    if (typeof text !== "string") throw new BotError(400, "bad_instructions", "instructions must be text");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_INSTRUCTIONS_BYTES) throw new BotError(413, "instructions_too_long", `DAEBOT.md is capped at ${MAX_INSTRUCTIONS_BYTES / 1024} KB (this is ${(bytes / 1024).toFixed(1)} KB)`);
    const dir = join(this.root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "DAEBOT.md");
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
    b.updatedAt = this.now();
    b.instructionsAt = b.updatedAt;
    this.save();
  }

  // ---------- device sync (see sync/bots.ts) ----------

  /** The synced fields of a bot, in wire form. Records from before the change times existed fall back to their updatedAt (an edited record beats an untouched one). */
  exportSync(slug: string): WireBot | undefined {
    const b = Object.values(this.bots).find((x) => x.slug === slug);
    if (!b) return undefined;
    const text = this.instructions(b.id);
    const edited = b.updatedAt > b.createdAt ? b.updatedAt : 0;
    return canonBot({
      slug: b.slug, name: b.name, purpose: b.purpose, color: b.color, face: b.face, model: b.model, voice: canonVoice(b.voice),
      profileAt: b.profileAt ?? edited, pinnedAt: b.pinnedAt, pinAt: b.pinAt ?? b.pinnedAt ?? 0,
      instructions: text || undefined, instructionsAt: b.instructionsAt ?? (text ? edited || 1 : 0), createdAt: b.createdAt,
    });
  }

  /** Takes in the other side's bot: per group the later change wins, createdAt is the earlier. true = something changed here. */
  applySync(w: WireBot): boolean {
    const b = Object.values(this.bots).find((x) => x.slug === w.slug);
    if (!b) return false;
    const cur = this.exportSync(w.slug)!;
    const merged = mergeWire(cur, canonBot(w));
    if (sigOf(merged) === sigOf(cur)) return false;
    b.createdAt = merged.createdAt;
    b.name = merged.name; b.purpose = merged.purpose; b.color = merged.color;
    if (merged.face) b.face = merged.face; else delete b.face;
    if (merged.model && validModelId(merged.model)) b.model = merged.model; else delete b.model;
    if (merged.voice) b.voice = merged.voice; else delete b.voice;
    b.profileAt = merged.profileAt;
    if (merged.pinnedAt) b.pinnedAt = merged.pinnedAt; else delete b.pinnedAt;
    b.pinAt = merged.pinAt;
    if (merged.instructionsAt > (cur.instructionsAt)) this.writeInstructions(b.id, merged.instructions ?? "");
    b.instructionsAt = merged.instructionsAt;
    this.save();
    return true;
  }

  private writeInstructions(id: string, text: string): void {
    const dir = join(this.root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "DAEBOT.md");
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  }

  /** Test/diagnostic: does the instructions file exist on disk. */
  hasInstructionsFile(id: string): boolean { return ID_RE.test(id) && existsSync(join(this.root, id, "DAEBOT.md")); }
}
