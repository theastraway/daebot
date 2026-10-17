// STUB. scripts/build-bin.mjs overwrites this file while it runs `bun build --compile` (web/ files as base64 plus the
// package version) and restores this stub afterwards, so the Node path never embeds anything.
export const EMBEDDED_VERSION: string = "";
export const EMBEDDED_FILES: Record<string, string> = {};
