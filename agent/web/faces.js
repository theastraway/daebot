// Bot faces (web). Each face is a small inline-SVG character AND a personality preset: the id stored on the bot, a name and one-line
// blurb for the picker. The personality paragraph itself lives on the server (src/bots/faces.ts) and is appended to the bot's system
// prompt there; a test keeps the ids, names and blurbs here identical to that list.
//
// Drawn on a 40x40 grid in currentColor (the badge sets `color` to the bot's LED colour), with no external assets.
// DOM only: built with createElementNS, never innerHTML.

const NS = "http://www.w3.org/2000/svg";

// Shape helpers. Strokes are the default; `fill` shapes are the lit parts (eyes, visor).
const line = (d) => ["path", { d }];
const dot = (cx, cy, r) => ["circle", { cx, cy, r, fill: "currentColor", stroke: "none" }];
const ring = (cx, cy, r) => ["circle", { cx, cy, r }];
const box = (x, y, w, h, rx) => ["rect", { x, y, width: w, height: h, rx }];
const solid = (d) => ["path", { d, fill: "currentColor" }];

export const FACES = [
  { id: "analyst", name: "Analyst", blurb: "Numbers first. Shows its working.",
    shapes: [box(6, 13, 12, 9, 2.5), box(22, 13, 12, 9, 2.5), line("M18 17.5H22"), dot(12, 17.5, 1.8), dot(28, 17.5, 1.8), line("M15 29H25")] },
  { id: "closer", name: "Closer", blurb: "Confident. Drives to the next step.",
    shapes: [dot(13, 19, 2.6), dot(27, 19, 2.6), line("M9 13L17 14.5"), line("M23 12Q27 8.5 31 11"), line("M12 28Q21 34 29 26")] },
  { id: "coach", name: "Coach", blurb: "Encouraging. Builds your skills.",
    shapes: [dot(13, 18, 2.8), dot(27, 18, 2.8), line("M8.5 11.5Q13 8 17.5 11.5"), line("M22.5 11.5Q27 8 31.5 11.5"), solid("M11 25Q20 37 29 25Z")] },
  { id: "guardian", name: "Guardian", blurb: "Careful. Checks before it acts.",
    shapes: [["rect", { x: 6, y: 14, width: 28, height: 8, rx: 4, fill: "currentColor" }], line("M15 8L20 5.5L25 8"), line("M16 30H24")] },
  { id: "builder", name: "Builder", blurb: "Practical. Ships working things.",
    shapes: [line("M8 15Q8 5 20 5Q32 5 32 15Z"), line("M4.5 15H35.5"), dot(14, 23, 2.2), dot(26, 23, 2.2), line("M14 30Q20 34 26 30")] },
  { id: "concierge", name: "Concierge", blurb: "Gracious. Handles the details.",
    shapes: [line("M8.5 19Q13 12.5 17.5 19"), line("M22.5 19Q27 12.5 31.5 19"), line("M12.5 27Q20 34 27.5 27"), dot(20, 35, 1.4)] },
  { id: "researcher", name: "Researcher", blurb: "Curious. Digs until it knows.",
    shapes: [ring(13, 18, 6.5), dot(13, 18, 2.2), dot(29, 18, 2.4), ring(21, 30, 2.6)] },
  { id: "operator", name: "Operator", blurb: "Steady. Runs the process.",
    shapes: [line("M6 20Q6 6 20 6Q34 6 34 20"), box(3.5, 17, 4.5, 9, 2), box(32, 17, 4.5, 9, 2), line("M34 26Q34 32 27 32"), dot(14, 20, 2.2), dot(26, 20, 2.2), line("M16 27H24")] },
  { id: "creator", name: "Creator", blurb: "Imaginative. Makes fresh options.",
    shapes: [line("M20 9V5"), dot(20, 3.8, 1.8), solid("M13 14L16.5 18.5L13 23L9.5 18.5Z"), solid("M27 14L30.5 18.5L27 23L23.5 18.5Z"), line("M11 30Q15.5 25.5 20 30T29 30")] },
  { id: "skeptic", name: "Skeptic", blurb: "Challenges. Finds the holes.",
    shapes: [line("M8 12.5L17 15.5"), line("M23 11.5Q28 7 32 11"), line("M10 21H17"), dot(27, 20, 2.8), line("M13 30L27 27.5")] },
];

export const FACE_IDS = FACES.map((f) => f.id);

/** The face for an id, or undefined (old bots have none, and anything not in the list is ignored). */
export function faceOf(id) {
  return typeof id === "string" ? FACES.find((f) => f.id === id) : undefined;
}

/** An <svg> for a face (colour comes from CSS `color`), or null for an unknown id. */
export function faceSvg(id) {
  const f = faceOf(id);
  if (!f) return null;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.setAttribute("class", "face-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const [tag, attrs] of f.shapes) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    svg.append(n);
  }
  return svg;
}
