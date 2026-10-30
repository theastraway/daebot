// The main Daebot's own look: the name, LED face and LED colour the user (or Daebot itself, through bot_manage on slug "self") chose.
// Shown in the sidebar header: the brand name and the <m-bot> mascot. Nothing chosen = the stock "Daebot" with the default face and amber LEDs.
// DOM only (textContent and setAttribute).
import { mascotAttrs } from "./mbadge.js";

export const DEFAULT_NAME = "Daebot";
let current = null;
/** The profile last read from the server (null until the first read): bots.js paints the header pill of a plain session from it. */
export const currentMain = () => current;

/** What the header shows for a profile from GET /settings/daebot (pure, so a test can check it). */
export function mainLook(p) {
  const name = p && typeof p.name === "string" && p.name.trim() ? p.name.trim() : DEFAULT_NAME;
  return { name, ...mascotAttrs({ face: p && p.face, color: p && p.color }) };
}

/** Dress the header inside `root` (document or any element holding .brand-name and m-bot.brand-bot). */
export function applyMain(root, p) {
  const look = mainLook(p);
  const n = root.querySelector(".brand-name");
  if (n && n.textContent !== look.name) n.textContent = look.name;
  const m = root.querySelector("m-bot.brand-bot");
  if (m) {
    if (m.getAttribute("face") !== look.face) m.setAttribute("face", look.face);
    if (m.getAttribute("accent") !== look.accent) m.setAttribute("accent", look.accent);
  }
  return look;
}

/** Reads the profile and dresses the header; a failed read leaves what is on screen. */
export function initMainBot({ json, onChange }) {
  async function refresh() {
    try {
      const p = await json("/settings/daebot");
      const same = JSON.stringify(p) === JSON.stringify(current);
      current = p;
      applyMain(document, p);
      if (!same && onChange) onChange();
    } catch { /* keep the header as it is */ }
  }
  return { refresh };
}
