// Per-user settings file: DATA_DIR/settings/<ownerId>.json. Today it holds the default model; plain JSON, mode 0600,
// written atomically. A missing or torn file reads as "no settings".
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface UserSettings { defaultModel?: string }

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
export const validModelId = (m: unknown): m is string => typeof m === "string" && MODEL_RE.test(m);

function seg(s: string): string {
  const v = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return v === "" || v === "." || v === ".." ? "_" : v;
}

export function createSettings(dir: string, owner: string): { get(): UserSettings; set(patch: { defaultModel?: string | null }): void } {
  const root = join(dir, "settings");
  const file = join(root, `${seg(owner)}.json`);
  const read = (): UserSettings => {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      return j && typeof j === "object" && validModelId(j.defaultModel) ? { defaultModel: j.defaultModel } : {};
    } catch { return {}; }
  };
  return {
    get: read,
    set(patch) {
      const cur = read();
      if (patch.defaultModel === null) delete cur.defaultModel;
      else if (patch.defaultModel !== undefined) {
        if (!validModelId(patch.defaultModel)) throw new Error("bad model id");
        cur.defaultModel = patch.defaultModel;
      }
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, ...cur }), { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}
