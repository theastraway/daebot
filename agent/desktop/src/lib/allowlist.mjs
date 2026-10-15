// Navigation policy: the window may only ever show the gateway origin. Everything else is handed to the default browser
// (http/https/mailto only) or dropped.

export function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** True only when `url` is on exactly the gateway origin (scheme + host + port). */
export function isAllowedNavigation(url, gatewayOrigin) {
  if (!gatewayOrigin) return false;
  const o = originOf(url);
  return o !== null && o === gatewayOrigin;
}

/** What to do with a URL the window wants to open or navigate to. */
export function classifyUrl(url, gatewayOrigin) {
  if (isAllowedNavigation(url, gatewayOrigin)) return "internal";
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:") return "external";
  } catch { /* fallthrough */ }
  return "block";
}

/** The one URL the window is loaded with: token appears in the query once (the web UI scrubs it). */
export function buildLoadUrl(gatewayUrl, token) {
  const u = new URL(gatewayUrl);
  u.pathname = "/";
  u.search = "";
  if (token) u.searchParams.set("token", token);
  return u.toString();
}

/** Same URL with any token query removed (safe to log). */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has("token")) u.searchParams.set("token", "REDACTED");
    return u.toString();
  } catch {
    return "[invalid url]";
  }
}
