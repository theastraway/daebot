// What the Daebot window may be granted. Only the microphone, only for our own UI (the local gateway origin), for the mic
// button and hands-free voice. Camera, screen capture, location, notifications, MIDI, HID and every other permission stay denied.
// On macOS the system prompt itself comes from systemPreferences.askForMediaAccess("microphone"), which needs the
// com.apple.security.device.audio-input entitlement (hardened runtime) and NSMicrophoneUsageDescription in Info.plist.
import { classifyUrl } from "./allowlist.mjs";

/** A permission *request* (getUserMedia): audio only, nothing else in the same request. */
export function isMicRequest(permission, details) {
  if (permission !== "media") return false;
  const types = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
  return types.length > 0 && types.every((t) => t === "audio");
}

/** A permission *check* (the page asking whether it already has the mic). */
export function isMicCheck(permission, details) {
  return permission === "media" && details?.mediaType === "audio";
}

/** True only when our own UI asks for the microphone. */
export function allowMediaRequest({ permission, details, url, gatewayOrigin }) {
  return isMicRequest(permission, details) && classifyUrl(url ?? "", gatewayOrigin) === "internal";
}

export function allowMediaCheck({ permission, details, origin, gatewayOrigin }) {
  return isMicCheck(permission, details) && classifyUrl(origin ?? "", gatewayOrigin) === "internal";
}

/**
 * Install the handlers on the window's session. askOs: () => Promise<boolean> shows the OS prompt (macOS) or resolves true.
 * getOrigin: () => the current gateway origin (it is only known once the gateway is up).
 */
export function installMediaPermissions(ses, { getOrigin, askOs, log = () => {} }) {
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const url = details?.requestingUrl ?? wc?.getURL?.() ?? "";
    if (!allowMediaRequest({ permission, details, url, gatewayOrigin: getOrigin() })) return cb(false);
    Promise.resolve()
      .then(() => askOs())
      .then((ok) => { log(`microphone ${ok ? "granted" : "denied by the OS"}`); cb(!!ok); })
      .catch((e) => { log("microphone prompt failed:", String(e?.message ?? e)); cb(false); });
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) =>
    allowMediaCheck({ permission, details, origin, gatewayOrigin: getOrigin() }));
}
