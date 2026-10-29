// A bot's icon: the animated M Daebot mascot wearing the LED face the owner chose in the bot's settings, in the bot's LED colour.
// The same <m-bot> component as the floating mascot (brand/mbot.js), in its small "lite" build. It sits still until the pointer is
// over it (or its row), then comes alive; prefers-reduced-motion keeps it still. A bot with no face chosen wears the default face.
// DOM only: createElement and setAttribute, no HTML strings.

import { mascotFace } from "./brand/mfaces.js";

export const DEFAULT_LED = "#ffd25a";

/** A colour we are willing to put on screen: #rrggbb only, else the default amber. */
export function ledColor(c) {
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim().toLowerCase() : DEFAULT_LED;
}

/** The attributes an M avatar gets for a bot (pure, so a test can check the mapping). */
export function mascotAttrs(bot) {
  return { face: mascotFace(bot && bot.face), accent: ledColor(bot && bot.color) };
}

/** A fresh <m-bot> avatar for `bot`. */
export function mascotFor(bot) {
  const m = document.createElement("m-bot");
  m.setAttribute("lite", ""); m.setAttribute("calm", "");
  m.setAttribute("aria-hidden", "true");
  setMascot(m, bot);
  return m;
}

/** Re-dress an existing avatar (a rename of the face or colour never rebuilds the LEDs). */
export function setMascot(m, bot) {
  const a = mascotAttrs(bot);
  if (m.getAttribute("face") !== a.face) m.setAttribute("face", a.face);
  if (m.getAttribute("accent") !== a.accent) m.setAttribute("accent", a.accent);
  return m;
}

/** Wake the avatar while the pointer or keyboard focus is on `host` (a row, a button, the badge itself). */
export function wakeOn(host, m) {
  const on = () => { m.hot = true; };
  const off = () => { m.hot = false; };
  host.addEventListener("pointerenter", on);
  host.addEventListener("pointerleave", off);
  host.addEventListener("focusin", on);
  host.addEventListener("focusout", off);
}
