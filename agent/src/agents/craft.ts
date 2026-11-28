// Craft mode: Daebot's own Craft Anything. The composer's "Chat | Craft" switch sends capability "craft"; the runtime turns that
// message into a loop run (agents/loop.ts) with the bar at 9 and a rubric picked from the goal, and the chat shows a live scorecard
// (the loop's `loop` progress events). The user's own words stay the visible message; only the model sees the instruction.
// UI goals ("make it look like ...", a URL or an image to match) also get a likeness category when this environment can capture pages.

export const CRAFT_CAPABILITY = "craft";
export const CRAFT_BAR = 9;

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/i;
const UI_RE = /\b(ui|ux|website|web site|site|web ?page|page|landing|homepage|home page|screen|layout|design|dashboard|app screen|mock-?up|hero|header|navbar)\b/i;
const MATCH_RE = /\b(look(?:s|ing)? (?:just |exactly )?like|match(?:es|ing)?|copy|clone|replicate|recreate|rebuild|same as|pixel[- ]perfect|like this (?:image|screenshot|photo|design))\b/i;
const IMAGE_RE = /\b(image|screenshot|photo|picture|mock-?up|figma)\b/i;

/** The first http(s) URL in the goal: the page to match. */
export function referenceUrl(goal: string): string | undefined {
  const m = URL_RE.exec(String(goal ?? ""));
  return m ? m[0].replace(/[.,;:!?]+$/, "") : undefined;
}

/** A UI/website/page/screen goal with something to match (a "look like", a URL or an image). */
export function isLikenessGoal(goal: string): boolean {
  const g = String(goal ?? "");
  if (!UI_RE.test(g) && !referenceUrl(g)) return false;
  return MATCH_RE.test(g) || !!referenceUrl(g) || (IMAGE_RE.test(g) && UI_RE.test(g));
}

/** "PREVIEW: <url>" in a builder's report: where the built page can be opened for the likeness capture. */
export function previewUrl(report: string): string | undefined {
  const m = /^\s*PREVIEW:\s*(https?:\/\/\S+)\s*$/im.exec(String(report ?? ""));
  return m ? m[1].replace(/[.,;]+$/, "") : undefined;
}

/**
 * A Craft send becomes the instruction the model acts on: run the loop on the user's words with bar 9 and the auto rubric.
 * The transcript keeps the typed text (the runtime records `msg`, the model gets this). "/loop x" typed in Craft is the same goal x.
 */
export function expandCraftMessage(text: string, o: { canBuild: boolean }): string {
  const raw = String(text ?? "");
  const goal = raw.replace(/^\s*\/loop\b\s*/i, "").trim();
  if (goal.length < 12) return `${raw}\n\n[Craft mode is on: the user wants something made and graded. This is too short to grade. Ask in one line what to make, for whom, and what done looks like.]`;
  const build = o.canBuild && /\b(code|build|fix|implement|refactor|feature|bug|test|app|page|site|website|screen|component|api|ui)\b/i.test(goal);
  const like = isLikenessGoal(goal);
  return `${raw}\n\n[Craft mode: call the loop tool now with goal set to the user's words above, mode "${build ? "build" : "write"}", no rubric (the categories are picked from the goal) and bar ${CRAFT_BAR}. ` +
    `${like ? "It is a UI goal with something to match: the loop also measures likeness where it can. " : ""}` +
    `The chat shows the live scorecard, so do not narrate rounds. When it ends, say in two or three lines what was made, the final score and what to review.]`;
}
