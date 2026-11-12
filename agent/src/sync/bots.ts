// Bot sync across devices (daebot.live, the desktop app, the phone). Until now only a bot's EXISTENCE (a slug and a label) was shared, through MIND; its name,
// purpose, colour, face, model, pin, instructions and its place in the list lived in each device's own store, so the phone and the Mac showed different bots.
// A bot now travels like a session does:
//   * it is keyed by its SLUG (bot ids are local to each side), and MIND still decides whether it exists (an unknown slug is ignored, never created here);
//   * its fields move in three groups, each with the time the person last changed it: the look (name, purpose, colour, face, model), the pin, and DAEBOT.md.
//     Per group the LATER writer wins on every device, so an edit made anywhere reaches everywhere. A tie settles on the larger value, so both sides agree;
//   * `createdAt` is the EARLIEST any device saw, so the list has one order everywhere (it sorts by createdAt);
//   * the main Daebot's own look and instructions ride along as the pseudo bot "main".
// "Run on a computer" (Remote) is not here: it already trades on the device poll, last writer wins.
import { createHash } from "node:crypto";
import type { BotsApi } from "../bots/types.ts";
import type { SettingsStore, MainProfile } from "../settings.ts";
import type { SyncHttp } from "./http.ts";

export const MAIN_SLUG = "main";

export interface WireBot {
  slug: string;
  name: string;
  purpose: string;
  color: string;
  face?: string;
  model?: string;
  profileAt: number;
  pinnedAt?: number;
  pinAt: number;
  instructions?: string;
  instructionsAt: number;
  createdAt: number;
}
export interface WireMain { name?: string; face?: string; color?: string; instructions?: string; profileAt: number; instructionsAt: number }

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** Fixed key order, so equal content always serialises (and hashes) the same on every side. */
export function canonBot(w: WireBot): WireBot {
  return {
    slug: w.slug, name: w.name, purpose: w.purpose, color: w.color,
    ...(w.face ? { face: w.face } : {}), ...(w.model ? { model: w.model } : {}),
    profileAt: num(w.profileAt),
    ...(w.pinnedAt ? { pinnedAt: w.pinnedAt } : {}), pinAt: num(w.pinAt),
    ...(w.instructions ? { instructions: w.instructions } : {}), instructionsAt: num(w.instructionsAt),
    createdAt: num(w.createdAt),
  };
}
export function canonMain(m: WireMain): WireMain {
  return { ...(m.name ? { name: m.name } : {}), ...(m.face ? { face: m.face } : {}), ...(m.color ? { color: m.color } : {}), ...(m.instructions ? { instructions: m.instructions } : {}), profileAt: num(m.profileAt), instructionsAt: num(m.instructionsAt) };
}
export const sigOf = (o: WireBot | WireMain): string => createHash("sha1").update(JSON.stringify(o)).digest("hex").slice(0, 16);

export function validWireBot(v: unknown): v is WireBot {
  const r = v as Partial<WireBot> | null;
  return !!r && typeof r === "object" && typeof r.slug === "string" && /^[a-z0-9-]{1,32}$/.test(r.slug) && typeof r.name === "string" && r.name.length <= 200
    && typeof r.purpose === "string" && r.purpose.length <= 2000 && typeof r.color === "string" && /^#[0-9a-fA-F]{6}$/.test(r.color)
    && (r.face === undefined || (typeof r.face === "string" && /^[a-z0-9-]{1,32}$/.test(r.face))) && (r.model === undefined || typeof r.model === "string")
    && (r.instructions === undefined || (typeof r.instructions === "string" && Buffer.byteLength(r.instructions, "utf8") <= 8 * 1024));
}
export function validWireMain(v: unknown): v is WireMain {
  const r = v as Partial<WireMain> | null;
  return !!r && typeof r === "object" && (r.name === undefined || typeof r.name === "string") && (r.face === undefined || typeof r.face === "string") && (r.color === undefined || typeof r.color === "string")
    && (r.instructions === undefined || (typeof r.instructions === "string" && Buffer.byteLength(r.instructions, "utf8") <= 8 * 1024));
}

const look = (w: WireBot): string => JSON.stringify([w.name, w.purpose, w.color, w.face ?? "", w.model ?? ""]);
/** The group a later change wins; a tie settles on the larger serialisation so both sides pick the same one. */
const later = (aAt: number, bAt: number, aVal: string, bVal: string): "a" | "b" => (aAt !== bAt ? (aAt > bAt ? "a" : "b") : aVal >= bVal ? "a" : "b");

/** The two sides' view of one bot merged: per group the later change, the earliest createdAt. Pure; symmetric (merge(a,b) equals merge(b,a)). */
export function mergeWireBot(a: WireBot, b: WireBot): WireBot {
  const L = later(a.profileAt, b.profileAt, look(a), look(b)) === "a" ? a : b;
  const P = later(a.pinAt, b.pinAt, String(a.pinnedAt ?? 0), String(b.pinnedAt ?? 0)) === "a" ? a : b;
  const I = later(a.instructionsAt, b.instructionsAt, a.instructions ?? "", b.instructions ?? "") === "a" ? a : b;
  const created = Math.min(a.createdAt || b.createdAt, b.createdAt || a.createdAt);
  return canonBot({
    slug: a.slug, name: L.name, purpose: L.purpose, color: L.color, face: L.face, model: L.model, profileAt: Math.max(a.profileAt, b.profileAt),
    pinnedAt: P.pinnedAt, pinAt: Math.max(a.pinAt, b.pinAt), instructions: I.instructions, instructionsAt: Math.max(a.instructionsAt, b.instructionsAt), createdAt: created,
  });
}

const mainLook = (m: WireMain): string => JSON.stringify([m.name ?? "", m.face ?? "", m.color ?? ""]);
export function mergeWireMain(a: WireMain, b: WireMain): WireMain {
  const L = later(a.profileAt, b.profileAt, mainLook(a), mainLook(b)) === "a" ? a : b;
  const I = later(a.instructionsAt, b.instructionsAt, a.instructions ?? "", b.instructions ?? "") === "a" ? a : b;
  return canonMain({ name: L.name, face: L.face, color: L.color, instructions: I.instructions, profileAt: Math.max(a.profileAt, b.profileAt), instructionsAt: Math.max(a.instructionsAt, b.instructionsAt) });
}

/** The main Daebot's look as the settings hold it, in wire form. */
export function exportMain(settings: SettingsStore | undefined): WireMain | undefined {
  if (!settings) return undefined;
  const s = settings.get();
  const m: MainProfile = s.main ?? {};
  const w = canonMain({ ...m, profileAt: s.mainMeta?.profileAt ?? (m.name || m.face || m.color ? 1 : 0), instructionsAt: s.mainMeta?.instructionsAt ?? (m.instructions ? 1 : 0) });
  return w.name || w.face || w.color || w.instructions || w.profileAt || w.instructionsAt ? w : undefined; // a profile nobody ever dressed has nothing to share
}
/** Takes in a main profile from another device; true = something changed here. */
export function applyMain(settings: SettingsStore | undefined, w: WireMain): boolean {
  if (!settings) return false;
  const cur = exportMain(settings) ?? canonMain({ profileAt: 0, instructionsAt: 0 });
  const merged = mergeWireMain(cur, w);
  if (sigOf(merged) === sigOf(cur)) return false;
  settings.applyMain({ ...(merged.name ? { name: merged.name } : {}), ...(merged.face ? { face: merged.face } : {}), ...(merged.color ? { color: merged.color } : {}), ...(merged.instructions ? { instructions: merged.instructions } : {}) }, { profileAt: merged.profileAt, instructionsAt: merged.instructionsAt });
  return true;
}

export interface BotSyncBody { bots?: unknown[]; main?: unknown; have?: Record<string, string>; haveMain?: string }
export interface BotSyncAnswer { now: number; bots: { wire: WireBot; sig: string }[]; main?: { wire: WireMain; sig: string }; unknown: string[] }

// ------------------------------------------------------------------ hosted side

export interface BotSyncServiceDeps {
  bots(owner: string): BotsApi | undefined;
  settings(owner: string): SettingsStore | undefined;
}

export class BotSyncService {
  private d: BotSyncServiceDeps;
  private chains = new Map<string, Promise<unknown>>();
  constructor(d: BotSyncServiceDeps) { this.d = d; }

  /** One exchange for one owner (serialised per owner: a merge is read-modify-write): takes in what the device sends, answers with everything the device does not have yet. */
  exchange(owner: string, body: BotSyncBody): Promise<BotSyncAnswer> {
    const prev = this.chains.get(owner) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.exchangeLocked(owner, body));
    this.chains.set(owner, run.catch(() => {}));
    return run;
  }

  private async exchangeLocked(owner: string, body: BotSyncBody): Promise<BotSyncAnswer> {
    const bots = this.d.bots(owner);
    const incoming = (Array.isArray(body.bots) ? body.bots : []).filter(validWireBot).slice(0, 500).map(canonBot);
    const unknown: string[] = [];
    if (bots && incoming.some((w) => !bots.bySlug(w.slug))) { try { await bots.list(); } catch { /* MIND unreachable: unknown bots wait for the next exchange */ } }
    for (const w of incoming) {
      if (!bots?.bySlug(w.slug)) { unknown.push(w.slug); continue; }
      bots.applySync?.(w);
    }
    if (body.main !== undefined && validWireMain(body.main)) applyMain(this.d.settings(owner), canonMain({ ...body.main, profileAt: num((body.main as WireMain).profileAt), instructionsAt: num((body.main as WireMain).instructionsAt) }));
    const have = body.have && typeof body.have === "object" ? body.have : {};
    const out: BotSyncAnswer["bots"] = [];
    for (const b of bots?.snapshot() ?? []) {
      const wire = bots?.exportSync?.(b.slug);
      if (!wire) continue;
      const sig = sigOf(wire);
      if (have[b.slug] !== sig) out.push({ wire, sig });
    }
    const main = exportMain(this.d.settings(owner));
    const mainSig = main ? sigOf(main) : undefined;
    return { now: Date.now(), bots: out, ...(main && mainSig !== body.haveMain ? { main: { wire: main, sig: mainSig! } } : {}), unknown };
  }
}

// ------------------------------------------------------------------ device side

export interface BotSyncAgentDeps {
  http: SyncHttp;
  bots(): BotsApi | undefined;
  settings(): SettingsStore | undefined;
  /** A bot changed here from another device: tell the UI side (reload a live session of it, etc.). */
  changed?(): void;
  log?: (line: string) => void;
}

/** The device half: each round sends what changed here since the server last agreed, takes back what changed there. Failures are logged and retried next round. */
export class BotSyncAgent {
  private d: BotSyncAgentDeps;
  private agreed = new Map<string, string>(); // slug -> sig the server and this device last agreed on
  private agreedMain = "";
  readonly stats = { pushed: 0, pulled: 0 };
  constructor(d: BotSyncAgentDeps) { this.d = d; }

  private local(): { wires: Map<string, WireBot>; main?: WireMain } {
    const bots = this.d.bots();
    const wires = new Map<string, WireBot>();
    for (const b of bots?.snapshot() ?? []) { const w = bots?.exportSync?.(b.slug); if (w) wires.set(b.slug, w); }
    return { wires, main: exportMain(this.d.settings()) };
  }

  /** One exchange. Returns how many bots changed on this device. */
  async round(): Promise<number> {
    const bots = this.d.bots();
    if (!bots?.exportSync) return 0;
    const { wires, main } = this.local();
    const push = [...wires.values()].filter((w) => this.agreed.get(w.slug) !== sigOf(w));
    const pushMain = main && sigOf(main) !== this.agreedMain ? main : undefined;
    const have: Record<string, string> = {};
    for (const [slug, sig] of this.agreed) if (wires.has(slug)) have[slug] = sig;
    const ans = await this.d.http.json<BotSyncAnswer>("POST", "/api/sync/bots", { bots: push, ...(pushMain ? { main: pushMain } : {}), have, ...(this.agreedMain ? { haveMain: this.agreedMain } : {}) });
    this.stats.pushed += push.length;
    // A bot MIND knows but this device has not listed yet: list once, then take it in.
    if (ans.bots.some((x) => !bots.bySlug(x.wire.slug))) { try { await bots.list(); } catch { /* MIND unreachable */ } }
    let changed = 0;
    for (const x of ans.bots) {
      if (!bots.bySlug(x.wire.slug) || !validWireBot(x.wire)) continue;
      if (bots.applySync?.(canonBot(x.wire))) { changed++; this.stats.pulled++; }
      const now = bots.exportSync(x.wire.slug);
      if (now && sigOf(now) === x.sig) this.agreed.set(x.wire.slug, x.sig);
    }
    // What we pushed and the server answered "same" about (it sends nothing for a bot whose sig matches): that is agreement too.
    for (const w of push) { const s = sigOf(w); if (!ans.bots.some((x) => x.wire.slug === w.slug) && !ans.unknown.includes(w.slug)) this.agreed.set(w.slug, s); }
    if (ans.main && validWireMain(ans.main.wire)) {
      if (applyMain(this.d.settings(), ans.main.wire)) { changed++; this.stats.pulled++; }
      const now = exportMain(this.d.settings());
      if (now && sigOf(now) === ans.main.sig) this.agreedMain = ans.main.sig;
    } else if (pushMain) this.agreedMain = sigOf(pushMain);
    if (changed) this.d.changed?.();
    return changed;
  }
}
