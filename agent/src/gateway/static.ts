import { createReadStream, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { resolveEmbedded } from "../embedded.ts";
import type { ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export const STATIC_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Resolves a raw request path to a file under root, or null. Never serves dotfiles or escapes root. */
export function resolveStatic(root: string, rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segs = decoded.split("/").filter((s) => s.length > 0);
  for (const s of segs) if (s.startsWith(".")) return null; // dotfiles, "." and ".."
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return null;
  }
  let candidate = join(rootReal, ...segs);
  try {
    if (statSync(candidate).isDirectory()) candidate = join(candidate, "index.html");
    const real = realpathSync(candidate);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return null; // symlink escape
    if (!statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

export function serveFile(file: string, res: ServerResponse, headOnly: boolean, extraHeaders: Record<string, string>): void {
  const st = statSync(file);
  res.writeHead(200, {
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(st.size),
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": STATIC_CSP,
    ...extraHeaders,
  });
  if (headOnly) return void res.end();
  const s = createReadStream(file);
  s.on("error", () => res.destroy());
  s.pipe(res);
}

/** Serves a file baked into the compiled binary (see src/embedded.ts). Same headers as serveFile. */
export function serveEmbedded(rawPath: string, res: ServerResponse, headOnly: boolean, extraHeaders: Record<string, string>, files?: Record<string, string>): boolean {
  const hit = resolveEmbedded(rawPath, files);
  if (!hit) return false;
  res.writeHead(200, {
    "content-type": TYPES[extname(hit.key).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(hit.data.length),
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": STATIC_CSP,
    ...extraHeaders,
  });
  res.end(headOnly ? undefined : hit.data);
  return true;
}
