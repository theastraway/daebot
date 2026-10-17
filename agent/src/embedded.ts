// Assets baked into the `bun build --compile` binary: the web UI (web/) and the package version.
// On plain Node the generated module is an empty stub, so nothing here changes behaviour.
import { EMBEDDED_FILES, EMBEDDED_VERSION } from "./embedded.generated.ts";

export function embeddedVersion(): string | undefined {
  return EMBEDDED_VERSION || undefined;
}

export function hasEmbeddedSite(files: Record<string, string> = EMBEDDED_FILES): boolean {
  return Object.keys(files).length > 0;
}

const decoded = new Map<string, Buffer>();

/**
 * Looks up a request path in the embedded site. Same rules as the on-disk resolver: no dotfiles, no backslashes or NULs,
 * a directory (or a trailing slash) serves its index.html. Returns the file's relative key and bytes, or null.
 */
export function resolveEmbedded(rawPath: string, files: Record<string, string> = EMBEDDED_FILES): { key: string; data: Buffer } | null {
  let p: string;
  try {
    p = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (p.includes("\0") || p.includes("\\")) return null;
  const segs = p.split("/").filter((s) => s.length > 0);
  if (segs.some((s) => s.startsWith("."))) return null;
  const key = segs.join("/");
  const candidates = key === "" ? ["index.html"] : [key, `${key}/index.html`];
  for (const c of candidates) {
    if (!Object.hasOwn(files, c)) continue;
    let data = files === EMBEDDED_FILES ? decoded.get(c) : undefined;
    if (!data) {
      data = Buffer.from(files[c]!, "base64");
      if (files === EMBEDDED_FILES) decoded.set(c, data);
    }
    return { key: c, data };
  }
  return null;
}
