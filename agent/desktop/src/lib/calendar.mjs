// Apple Calendar for the Mac app. The web UI calls window.mindclawDesktop.calendar.call(op, args); the preload forwards it over IPC
// ("desktop:calendar"), main answers ONLY our own window, and this module runs the bundled `daebot-calendar` helper (EventKit) once per
// call: one JSON request on its stdin, one JSON reply on its stdout. The helper runs inside the app bundle, so macOS shows the Calendar
// permission prompt as Daebot's own and the person never leaves the app. Nothing here touches the network or the gateway.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const CALENDAR_CHANNEL = "desktop:calendar";
export const CALENDAR_OPS = Object.freeze(["status", "request", "calendars", "events", "create", "update", "delete"]);
/** `request` waits for a person reading an OS prompt; everything else answers at once. The gateway gives up a little earlier than both. */
export const REQUEST_TIMEOUT_MS = 130_000;
export const CALL_TIMEOUT_MS = 35_000;
const MAX_REQUEST_BYTES = 200_000;
const MAX_REPLY_BYTES = 4_000_000;

export const NOT_BUNDLED = "Apple Calendar is not set up in this copy of Daebot. Update the Daebot app and try again.";
export const NOT_OUR_WINDOW = "Apple Calendar is only available inside the Daebot window.";

/** Where the helper lives: <resources>/bin/daebot-calendar when packaged, desktop/build/bin/daebot-calendar in development. Null when absent. */
export function findCalendarHelper({ resourcesPath, devDir, platform = process.platform, exists = existsSync } = {}) {
  if (platform !== "darwin") return null;
  for (const dir of [resourcesPath && join(resourcesPath, "bin"), devDir]) {
    if (!dir) continue;
    const p = join(dir, "daebot-calendar");
    if (exists(p)) return p;
  }
  return null;
}

/** Checks one request before anything is spawned. Returns the JSON line for the helper, or { error }. */
export function frameRequest(op, args) {
  if (typeof op !== "string" || !CALENDAR_OPS.includes(op)) return { error: "That Calendar request is not supported." };
  const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  let line;
  try { line = JSON.stringify({ op, args: a }); } catch { return { error: "That Calendar request could not be read." }; }
  if (line.length > MAX_REQUEST_BYTES) return { error: "That Calendar request is too large." };
  return { line: `${line}\n` };
}

/** Turns the helper's stdout into the { ok, result | error } reply. Takes the last non-empty line, so stray output before it cannot hide the answer. */
export function parseReply(stdout) {
  const lines = String(stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return { ok: false, error: "Calendar did not answer. Try again." };
  let v;
  try { v = JSON.parse(last); } catch { return { ok: false, error: "Calendar sent back something Daebot could not read." }; }
  if (!v || typeof v !== "object") return { ok: false, error: "Calendar sent back something Daebot could not read." };
  if (v.ok === true) return { ok: true, result: v.result === undefined ? null : v.result };
  return { ok: false, error: typeof v.error === "string" && v.error.trim() ? v.error.trim().slice(0, 500) : "Calendar could not do that." };
}

/**
 * @param {object} o
 * @param {string|null} o.helperPath  the bundled helper, or null (every call then answers NOT_BUNDLED)
 * @param {Function} o.spawn          child_process.spawn (a stub in tests)
 * @param {(ms:number, fn:Function)=>any} [o.setTimer]
 */
export function createCalendarBridge({ helperPath, spawn, setTimer = setTimeout, clearTimer = clearTimeout }) {
  return {
    call(op, args) {
      const framed = frameRequest(op, args);
      if (framed.error) return Promise.resolve({ ok: false, error: framed.error });
      if (!helperPath) return Promise.resolve({ ok: false, error: NOT_BUNDLED });
      return new Promise((resolve) => {
        let settled = false;
        let out = "";
        let child;
        const finish = (reply) => { if (settled) return; settled = true; clearTimer(timer); resolve(reply); };
        const timer = setTimer(() => {
          try { child?.kill(); } catch { /* already gone */ }
          finish({ ok: false, error: op === "request" ? "The Calendar permission prompt was not answered in time. Ask again when you are ready." : "Calendar did not answer in time. Try again." });
        }, op === "request" ? REQUEST_TIMEOUT_MS : CALL_TIMEOUT_MS);
        timer?.unref?.();
        try { child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "ignore"] }); }
        catch { return finish({ ok: false, error: "Daebot could not start Calendar on this Mac." }); }
        child.on("error", () => finish({ ok: false, error: "Daebot could not start Calendar on this Mac." }));
        child.stdout?.on("data", (d) => {
          out += d.toString();
          if (out.length > MAX_REPLY_BYTES) { try { child.kill(); } catch { /* gone */ } finish({ ok: false, error: "Calendar sent back too much at once. Narrow the dates and try again." }); }
        });
        child.on("close", (code, signal) => {
          // No answer and a bad exit: macOS stopped the helper (a missing permission string or entitlement does this), not a slow reply.
          if (!out.trim() && (code || signal)) return finish({ ok: false, error: "Calendar was stopped by macOS before it could answer. Check System Settings > Privacy & Security > Calendars, then try again." });
          finish(parseReply(out));
        });
        try { child.stdin?.on("error", () => {}); child.stdin?.end(framed.line); }
        catch { finish({ ok: false, error: "Daebot could not talk to Calendar on this Mac." }); }
      });
    },
  };
}

/** The IPC handler: refuses anything that does not come from our own window, before the helper is ever reached. */
export function createCalendarHandler({ bridge, isOurUi }) {
  return async (event, op, args) => {
    let ours = false;
    try { ours = isOurUi(event) === true; } catch { ours = false; }
    if (!ours) return { ok: false, error: NOT_OUR_WINDOW };
    return bridge.call(op, args);
  };
}
