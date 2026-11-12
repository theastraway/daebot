// Per-user settings file: DATA_DIR/settings/<ownerId>.json. Today it holds the default model; plain JSON, mode 0600,
// written atomically. A missing or torn file reads as "no settings".
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How the user dressed the MAIN Daebot (the plain Sessions chat): its own name, face (a faces.ts id), LED colour and instructions. All optional: absent = the stock Daebot. */
export interface MainProfile { name?: string; face?: string; color?: string; instructions?: string }
/** When the main Daebot's look (name, face, colour) and its instructions last changed by the person's hand (ms). Device sync keeps the later change per group. */
export interface MainMeta { profileAt?: number; instructionsAt?: number }
export interface UserSettings { defaultModel?: string; main?: MainProfile; mainMeta?: MainMeta }
export type SettingsPatch = { defaultModel?: string | null; main?: { [K in keyof MainProfile]?: MainProfile[K] | null } };

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
export const validModelId = (m: unknown): m is string => typeof m === "string" && MODEL_RE.test(m);

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Only fields of the right shape survive a read or a write (a hand-edited file cannot put junk on screen or in the prompt). */
function cleanMain(m: Record<string, unknown>): MainProfile {
  const out: MainProfile = {};
  if (typeof m.name === "string" && m.name.trim() && m.name.trim().length <= 80) out.name = m.name.trim().replace(/[\u0000-\u001f\u007f]+/g, " ");
  if (typeof m.face === "string" && /^[a-z0-9-]{1,32}$/.test(m.face)) out.face = m.face;
  if (typeof m.color === "string" && HEX.test(m.color.trim())) out.color = m.color.trim().toLowerCase();
  if (typeof m.instructions === "string" && m.instructions.trim() && Buffer.byteLength(m.instructions, "utf8") <= 8 * 1024) out.instructions = m.instructions;
  return out;
}

function seg(s: string): string {
  const v = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return v === "" || v === "." || v === ".." ? "_" : v;
}

export const cleanMainProfile = (m: Record<string, unknown>): MainProfile => cleanMain(m);

export interface SettingsStore { get(): UserSettings; set(patch: SettingsPatch): void; /** Device sync: replace the main profile without moving its change times except to the given ones. */ applyMain(m: MainProfile, meta: MainMeta): void }

export function createSettings(dir: string, owner: string): SettingsStore {
  const root = join(dir, "settings");
  const file = join(root, `${seg(owner)}.json`);
  const read = (): UserSettings => {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (!j || typeof j !== "object") return {};
      const out: UserSettings = {};
      if (validModelId(j.defaultModel)) out.defaultModel = j.defaultModel;
      const m = j.main && typeof j.main === "object" ? cleanMain(j.main) : {};
      if (Object.keys(m).length) out.main = m;
      const mm = j.mainMeta && typeof j.mainMeta === "object" ? j.mainMeta : {};
      const meta: MainMeta = {};
      if (Number.isFinite(mm.profileAt) && mm.profileAt > 0) meta.profileAt = mm.profileAt;
      if (Number.isFinite(mm.instructionsAt) && mm.instructionsAt > 0) meta.instructionsAt = mm.instructionsAt;
      if (Object.keys(meta).length) out.mainMeta = meta;
      return out;
    } catch { return {}; }
  };
  const write = (cur: UserSettings): void => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, ...cur }), { mode: 0o600 });
    renameSync(tmp, file);
  };
  return {
    get: read,
    applyMain(m, meta) {
      const cur = read();
      const clean = cleanMain({ ...m });
      if (Object.keys(clean).length) cur.main = clean; else delete cur.main;
      const mm: MainMeta = { ...(meta.profileAt ? { profileAt: meta.profileAt } : {}), ...(meta.instructionsAt ? { instructionsAt: meta.instructionsAt } : {}) };
      if (Object.keys(mm).length) cur.mainMeta = mm; else delete cur.mainMeta;
      write(cur);
    },
    set(patch) {
      const cur = read();
      if (patch.defaultModel === null) delete cur.defaultModel;
      else if (patch.defaultModel !== undefined) {
        if (!validModelId(patch.defaultModel)) throw new Error("bad model id");
        cur.defaultModel = patch.defaultModel;
      }
      if (patch.main) {
        const m: Record<string, unknown> = { ...(cur.main ?? {}) };
        for (const [k, v] of Object.entries(patch.main)) { if (v === null || v === "") delete m[k]; else if (v !== undefined) m[k] = v; }
        const clean = cleanMain(m);
        if (Object.keys(clean).length) cur.main = clean; else delete cur.main;
        // The person's own edit: stamp when, per group, so the other devices take the later one.
        const now = Date.now(), meta: MainMeta = { ...(cur.mainMeta ?? {}) };
        if (["name", "face", "color"].some((k) => (patch.main as Record<string, unknown>)[k] !== undefined)) meta.profileAt = now;
        if ((patch.main as Record<string, unknown>).instructions !== undefined) meta.instructionsAt = now;
        cur.mainMeta = meta;
      }
      write(cur);
    },
  };
}
