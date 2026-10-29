// Screen capture permission, as the desktop shell sees it. The USER grants it (macOS System Settings > Privacy & Security > Screen Recording);
// this module only reads the state and names the deep link. Daebot never changes an OS permission and never grants one for itself.
// Windows needs no permission for capturing the desktop. Linux is treated as allowed; a Wayland compositor that refuses shows up as a capture error.

export const MAC_SCREEN_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/**
 * @param {{platform: string, status?: string}} o  status = systemPreferences.getMediaAccessStatus("screen") on macOS
 * @returns {{state: "granted"|"needs-permission"|"restricted"|"unsupported"|"unknown", canOpenSettings: boolean, askable: boolean, raw?: string}}
 *   askable: the OS has never been asked, so one capture attempt makes macOS show its own prompt (the user answers it).
 */
export function screenAccess({ platform, status } = {}) {
  if (platform === "win32" || platform === "linux") return { state: "granted", canOpenSettings: false, askable: false };
  if (platform !== "darwin") return { state: "unsupported", canOpenSettings: false, askable: false };
  switch (status) {
    case "granted": return { state: "granted", canOpenSettings: false, askable: false, raw: status };
    case "not-determined": return { state: "needs-permission", canOpenSettings: true, askable: true, raw: status };
    case "denied": return { state: "needs-permission", canOpenSettings: true, askable: false, raw: status };
    case "restricted": return { state: "restricted", canOpenSettings: false, askable: false, raw: status };
    default: return { state: "needs-permission", canOpenSettings: true, askable: false, raw: status };
  }
}

/** The URL the "Open System Settings" button opens, or null when this platform has no such pane. Only that exact link is ever opened. */
export function permissionSettingsUrl(platform) {
  return platform === "darwin" ? MAC_SCREEN_SETTINGS_URL : null;
}
