// Apple Calendar on the user's own device (web side). Daebot never reaches Calendar from the server: the agent publishes a `device_call`
// event into the turn's stream, this file hands it to native code in the app (EventKit), and the answer is POSTed back to the turn.
//
//   iPhone app:  window.webkit.messageHandlers.daebotCalendar.postMessage({ op, args })  -> Promise<{ ok: true, result } | { ok: false, error }>
//   Mac app:     window.mindclawDesktop.calendar.call(op, args)                           -> the same { ok, result | error } shape
//
// Ops: status, request, calendars, events, create, update, delete. Everything else is refused here and never reaches native code.
// This file builds no DOM at all.

export const CALENDAR_OPS = Object.freeze(["status", "request", "calendars", "events", "create", "update", "delete"]);
export const CAPABILITY = "apple_calendar";
const MAX_REPLY_CHARS = 800_000; // the gateway refuses a body over 1 MiB
const SEEN_KEY = "daebot:device-calls";

const plainError = (e, fallback) => {
  const m = e && typeof e === "object" && typeof e.message === "string" ? e.message : typeof e === "string" ? e : "";
  return (m || fallback).replace(/\s+/g, " ").trim().slice(0, 500);
};

/** The raw native transport of this device, or null when it has no Apple Calendar bridge. Takes the window so tests can stub it. */
function transport(win) {
  try {
    const ios = win && win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers.daebotCalendar;
    if (ios && typeof ios.postMessage === "function") return (op, args) => ios.postMessage({ op, args });
    const mac = win && win.mindclawDesktop && win.mindclawDesktop.calendar;
    if (mac && typeof mac.call === "function") return (op, args) => mac.call(op, args);
  } catch { /* a locked-down webview: no bridge */ }
  return null;
}

/**
 * The device's calendar, or null when this device has no Apple Calendar bridge (plain browser, Windows, Linux, Android).
 * call(op, args) resolves with the native result, or rejects with an Error whose message is a sentence the user can act on.
 * status also carries the device time zone, so the agent writes every time in the user's own zone.
 */
export function deviceCalendar(win = typeof window !== "undefined" ? window : undefined) {
  const send = transport(win);
  if (!send) return null;
  return {
    async call(op, args) {
      if (!CALENDAR_OPS.includes(op)) throw new Error("That Calendar request is not supported.");
      let reply;
      try { reply = await send(op, args && typeof args === "object" ? args : {}); }
      catch (e) { throw new Error(plainError(e, "Daebot could not reach Calendar on this device.")); }
      if (!reply || typeof reply !== "object") throw new Error("Calendar on this device sent back something Daebot could not read.");
      if (reply.ok !== true) throw new Error(plainError(reply.error, "Calendar on this device could not do that."));
      let result = reply.result;
      if (op === "status" && result && typeof result === "object" && !Array.isArray(result) && result.timeZone === undefined) {
        try { result = { ...result, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }; } catch { /* no Intl: leave it out */ }
      }
      return result;
    },
  };
}

/** True when this device can answer Apple Calendar requests: the send request lists the capability. */
export function calendarCapabilities(win) {
  return deviceCalendar(win) ? [CAPABILITY] : [];
}

/** Makes a reply fit the gateway's body limit: notes go first, then the tail of a long list. */
export function fitResult(result) {
  const size = (v) => { try { return JSON.stringify(v).length; } catch { return Infinity; } };
  if (size(result) <= MAX_REPLY_CHARS) return result;
  if (!Array.isArray(result)) return result;
  let list = result.map((x) => (x && typeof x === "object" && "notes" in x ? { ...x, notes: "" } : x));
  while (list.length > 1 && size(list) > MAX_REPLY_CHARS) list = list.slice(0, Math.ceil(list.length * 0.8));
  return list;
}

function loadSeen(storage) {
  try { const v = JSON.parse(storage.getItem(SEEN_KEY) || "[]"); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []); } catch { return new Set(); }
}
function saveSeen(storage, seen) {
  try { storage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-60))); } catch { /* storage unavailable: dedupe stays in memory */ }
}

/**
 * Receives `device_call` events from a turn's stream and answers them. One instance per page.
 *   post(sessionId, body)  POSTs { id, ok, result | error } to /sessions/:id/device-result
 * handle(sessionId, ev) returns true when the event was a device call (answered, or skipped as a repeat), false when it is not one of ours.
 * Works while the turn keeps streaming (the answer is sent in the background). A call seen before (a re-attached stream) is never run twice.
 */
export function createDeviceCalls({ post, getCalendar = () => deviceCalendar(), storage } = {}) {
  let store = storage;
  if (!store) { try { store = window.sessionStorage; } catch { store = undefined; } }
  const seen = store ? loadSeen(store) : new Set();
  const remember = (id) => { seen.add(id); if (store) saveSeen(store, seen); };
  return {
    async handle(sessionId, ev) {
      if (!ev || ev.type !== "device_call" || ev.tool !== CAPABILITY) return false;
      if (typeof ev.id !== "string" || !ev.id) return false;
      if (typeof ev.sessionId === "string" && ev.sessionId !== sessionId) return false; // a call for another session is not ours to answer
      if (seen.has(ev.id)) return true;
      remember(ev.id);
      let body;
      const cal = getCalendar();
      if (!cal) body = { id: ev.id, ok: false, error: "Apple Calendar works in the Daebot iPhone and Mac apps." };
      else {
        try { body = { id: ev.id, ok: true, result: fitResult(await cal.call(ev.op, ev.args)) }; }
        catch (e) { body = { id: ev.id, ok: false, error: plainError(e, "Calendar on this device could not do that.") }; }
      }
      try { await post(sessionId, body); } catch { /* the turn times out on its own and says so */ }
      return true;
    },
  };
}
