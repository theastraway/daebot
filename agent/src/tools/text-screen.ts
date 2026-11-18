// Screen text the model did not write (a web page today, a MIND recall chunk later).
// One chunk is one non-empty line: htmlToText emits a line per block. Neighbouring lines are judged
// together so a phrase split by a <br> cannot sneak through. Flagged chunks are dropped and replaced
// by one notice. The patterns live in learn/guard.ts so a lesson and a page share the specific rules.
// Named text-screen.ts because tools/screen.ts is the live screen-feed tool.
import { fetchedInstructionProblem } from "../learn/guard.ts";

export function withheldNotice(n: number): string {
  return `[withheld ${n} chunk(s) that looked like instructions to the assistant]`;
}

export interface ScreenResult { text: string; withheld: number }

function hit(s: string): boolean {
  return fetchedInstructionProblem(s) !== null;
}

function nextFilled(lines: string[], i: number): number {
  for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) return j;
  return -1;
}

/** Drop instruction-bearing chunks. `text` is what remains, with no notice attached. */
export function screenUntrustedText(text: string): ScreenResult {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const bad = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i].trim();
    if (!a) continue;
    if (hit(a)) bad[i] = true;
    const j = nextFilled(lines, i);
    if (j === -1) continue;
    const b = lines[j].trim();
    if (!hit(a) && !hit(b) && hit(`${a} ${b}`)) { bad[i] = true; bad[j] = true; continue; }
    const k = nextFilled(lines, j);
    if (k === -1) continue;
    const c = lines[k].trim();
    if (!hit(a) && !hit(b) && !hit(c) && hit(`${a} ${b} ${c}`)) { bad[i] = true; bad[j] = true; bad[k] = true; }
  }
  let withheld = 0;
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!bad[i]) { kept.push(lines[i]); continue; }
    if (lines[i].trim()) withheld++;
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), withheld };
}

/** Kept text plus the one notice. The notice stays even when the caller clips the body first. */
export function withScreenNotice(screened: ScreenResult): string {
  if (!screened.withheld) return screened.text;
  const note = withheldNotice(screened.withheld);
  return screened.text ? `${screened.text}\n\n${note}` : note;
}
