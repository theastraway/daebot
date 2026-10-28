// Web / mobile-app update check. The page is always served by the live gateway, so "latest" is whatever /health reports as the
// build. When that differs from the build this tab loaded with, a newer Daebot is live and one Reload picks it up.
// Pure logic first (testable), DOM wiring in app.js.

export const WEB_CHECK_MS = 5 * 60 * 1000;

/** @param {{build?: string}|null} h  @param {string|null} loaded  @returns {{loaded:string|null, latest:string|null, stale:boolean}} */
export function compareBuild(loaded, h) {
  const latest = h && typeof h.build === "string" && h.build ? h.build : null;
  const seen = loaded || latest; // first successful read is "the build this tab runs"
  return { loaded: seen, latest, stale: !!(seen && latest && seen !== latest) };
}

export function webUpdateText(state) {
  const short = (b) => (b ? String(b).slice(0, 7) : "");
  if (state.stale) return { text: "A new version of Daebot is ready", button: "Reload" };
  if (state.loaded) return { text: `Daebot · up to date (${short(state.loaded)})`, button: "Check for updates" };
  return { text: "Daebot", button: "Check for updates" };
}
