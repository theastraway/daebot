// How each bot face looks on the M mascot's LED screen. Pure data, no DOM, so a test can check it.
//
// A bot's face (analyst, closer, ...) is chosen in the bot's settings. On the <m-bot> mascot it becomes the mascot's resting
// expression: <m-bot face="coach">. The mascot's own mood (thinking, talking...) still wins while it is not idle.
//
// Look keys (all optional; the default look is the commercial's plain smile):
//   mouth     "smile" | "grin" | "flat" | "sad" | "o"
//   eyeShape  "happy" | "heart" | "big" | "spin"
//   wink      true = the right eye winks
//   blush     true = the red cheek
//   maxOpen   0..1, how far the eyes open (a squint)

export const DEFAULT_FACE = "operator";

export const FACE_LOOKS = {
  analyst:    { mouth: "flat" },
  closer:     { mouth: "grin", wink: true },
  coach:      { mouth: "grin", eyeShape: "happy", blush: true },
  guardian:   { mouth: "flat", maxOpen: 0.55 },
  builder:    { mouth: "grin" },
  concierge:  { mouth: "smile", eyeShape: "happy" },
  researcher: { mouth: "flat", eyeShape: "spin" },
  operator:   { mouth: "smile" },
  creator:    { mouth: "smile", eyeShape: "heart" },
  skeptic:    { mouth: "sad", maxOpen: 0.55 },
};

/** The look for a face id. An unknown or missing id gets the default face (never a letter, never nothing). */
export function faceLook(id) {
  return typeof id === "string" && Object.hasOwn(FACE_LOOKS, id) ? FACE_LOOKS[id] : FACE_LOOKS[DEFAULT_FACE];
}

/** The face id to put on the mascot: the bot's own, else the default. */
export function mascotFace(id) {
  return typeof id === "string" && Object.hasOwn(FACE_LOOKS, id) ? id : DEFAULT_FACE;
}
