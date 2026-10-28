// Native notification policy for `confirm` events and the validated payload accepted from the preload hook.

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** Notify only for confirm events and permission cards while the user cannot see the window. */
export function shouldNotify(event, win) {
  if (!event || (event.type !== "confirm" && event.type !== "permission")) return false;
  if (!win) return true;
  return !(win.visible && win.focused);
}

export function buildConfirmNotification(event) {
  const tool = typeof event.tool === "string" ? clean(event.tool) : "an action";
  if (event.type === "permission") {
    return { title: clip(`Daebot is asking permission: ${tool}`, 80), body: clip(typeof event.title === "string" && event.title ? clean(event.title) : "An action is waiting for your answer.", 200) };
  }
  const reason = typeof event.reason === "string" ? clean(event.reason) : "";
  return {
    title: clip(`Daebot needs your go: ${tool}`, 80),
    body: clip(reason || "An action is waiting for your confirmation.", 200),
  };
}

/** Validate window.mindclawDesktop.notify({title, body}) before it reaches the OS. Returns {title, body} or null. */
export function validateNotifyPayload(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (typeof p.title !== "string" || typeof p.body !== "string") return null;
  const title = clean(p.title);
  const body = clean(p.body);
  if (!title || title.length > 120 || body.length > 500) return null;
  return { title, body };
}

/** Tiny rate limit so a page cannot spam notifications: at most `max` per `windowMs`. */
export function createRateLimiter(max = 5, windowMs = 10_000, now = () => Date.now()) {
  const stamps = [];
  return () => {
    const t = now();
    while (stamps.length && t - stamps[0] > windowMs) stamps.shift();
    if (stamps.length >= max) return false;
    stamps.push(t);
    return true;
  };
}
