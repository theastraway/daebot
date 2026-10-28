// "Keep working in the background": the gateway (a separate process) keeps running when the window is closed or hidden, and the
// system is kept from idle-sleeping while the setting is on, so a running turn or a background `process` is not suspended.
// prevent-app-suspension stops the machine sleeping; it does NOT stop the screen locking and never touches any OS security setting.

/** Start or stop the power-save blocker to match `enabled`. Returns the blocker id to remember (null when off). Never throws. */
export function applyKeepWorking({ powerSaveBlocker, enabled, current = null }) {
  try {
    if (enabled) {
      if (current !== null && powerSaveBlocker.isStarted(current)) return current;
      return powerSaveBlocker.start("prevent-app-suspension");
    }
    if (current !== null && powerSaveBlocker.isStarted(current)) powerSaveBlocker.stop(current);
  } catch { return enabled ? current : null; }
  return null;
}

/** One line of help text for the setting. */
export function keepWorkingNote(platform = process.platform) {
  return platform === "win32"
    ? "Daebot keeps running shell commands and background processes while the screen is locked. Screen capture and mouse/keyboard control need an unlocked, interactive desktop."
    : "Daebot keeps running shell commands and background processes while the screen is locked.";
}
