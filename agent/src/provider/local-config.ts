// The local model server the person pointed Daebot at from the Connections panel (desktop and self-host; a hosted gateway never
// has one). Saved as DATA_DIR/local-llm.json, mode 0600, written atomically. The environment (OLLAMA_HOST, DAEBOT_TIER_LOCAL,
// DAEBOT_LOCAL_LLM) stays the default; a saved value wins, so the panel changes the server without a restart.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LocalLlmConfig {
  /** On or off from the panel; absent = whatever the environment says (on unless DAEBOT_LOCAL_LLM=off). */
  enabled?: boolean;
  /** http(s)://host[:port] of Ollama, LM Studio, llama.cpp or any OpenAI-compatible server. Absent = OLLAMA_HOST, else 127.0.0.1:11434. */
  base?: string;
  /** The served model the router should prefer for local work ("qwen3:14b"), with or without the ollama/ prefix. */
  model?: string;
  updatedAt?: number;
}

export type LocalLlmPatch = { enabled?: boolean | null; base?: string | null; model?: string | null };

const BASE_RE = /^https?:\/\/[A-Za-z0-9._-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%\/-]*)?$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;

/** A clean server address or undefined: http(s) only, a host and optional port and path, no credentials, query or fragment. */
export function cleanBase(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  let s = v.trim();
  if (!s) return undefined;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  s = s.replace(/\/+$/, "");
  return s.length <= 300 && BASE_RE.test(s) ? s : undefined;
}

export function cleanModel(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().replace(/^ollama\//, "");
  return s && MODEL_RE.test(s) ? s : undefined;
}

export const localLlmFile = (dir: string): string => join(dir, "local-llm.json");

/** The saved config, or {} when there is no file or it is torn; junk fields never come through. */
export function readLocalLlm(dir: string): LocalLlmConfig {
  try {
    const j = JSON.parse(readFileSync(localLlmFile(dir), "utf8"));
    if (!j || typeof j !== "object") return {};
    const out: LocalLlmConfig = {};
    if (typeof j.enabled === "boolean") out.enabled = j.enabled;
    const base = cleanBase(j.base); if (base) out.base = base;
    const model = cleanModel(j.model); if (model) out.model = model;
    if (Number.isFinite(j.updatedAt) && j.updatedAt > 0) out.updatedAt = j.updatedAt;
    return out;
  } catch { return {}; }
}

/** Applies a patch (null clears a field) and writes the file. Returns what is now saved. Throws on a bad base or model. */
export function writeLocalLlm(dir: string, patch: LocalLlmPatch, now = Date.now()): LocalLlmConfig {
  const cur = readLocalLlm(dir);
  const next: LocalLlmConfig = { ...cur };
  if (patch.enabled === null) delete next.enabled; else if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (patch.base === null) delete next.base;
  else if (patch.base !== undefined) { const b = cleanBase(patch.base); if (!b) throw new Error("bad_base"); next.base = b; }
  if (patch.model === null) delete next.model;
  else if (patch.model !== undefined) { const m = cleanModel(patch.model); if (!m) throw new Error("bad_model"); next.model = m; }
  next.updatedAt = now;
  mkdirSync(dir, { recursive: true });
  const file = localLlmFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}
