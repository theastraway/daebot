// Flicker-free output: scrollback lines are committed above, only the live region is redrawn in place.
// This file builds the escape-sequence string for one frame; the app writes it in a single write().
import { visibleWidth } from "./ansi.ts";
import type { LiveRegion } from "./render.ts";

export const SYNC_BEGIN = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";
export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const PASTE_ON = "\x1b[?2004h";
export const PASTE_OFF = "\x1b[?2004l";
export const CLEAR_ALL = "\x1b[2J\x1b[3J\x1b[H";

export class LiveScreen {
  private prevWidths: number[] = [];
  private prevCursorRow = 0;

  /** Rows the previous live region occupies after the terminal re-wrapped it to `cols` columns, up to its cursor row. */
  private rowsAboveCursor(cols: number): number {
    let rows = 0;
    for (let i = 0; i < this.prevCursorRow; i++) rows += Math.max(1, Math.ceil((this.prevWidths[i] ?? 0) / Math.max(1, cols)));
    return rows;
  }

  /**
   * Build one frame: move to the top of the old live region, erase it, print `commit` lines (they scroll into
   * history), then paint the new live region and park the cursor in the input. `live === null` just clears.
   */
  frame(commit: string[], live: LiveRegion | null, cols: number): string {
    let s = SYNC_BEGIN + HIDE_CURSOR;
    const up = this.rowsAboveCursor(cols);
    if (up > 0) s += `\x1b[${up}A`;
    s += "\r\x1b[J";
    for (const l of commit) s += l + "\n";
    if (live) {
      s += live.lines.join("\n");
      const last = live.lines.length - 1;
      if (last - live.cursorRow > 0) s += `\x1b[${last - live.cursorRow}A`;
      s += `\r\x1b[${live.cursorCol + 1}G`;
      this.prevWidths = live.lines.map((l) => visibleWidth(l));
      this.prevCursorRow = live.cursorRow;
      s += SHOW_CURSOR;
    } else {
      this.prevWidths = []; this.prevCursorRow = 0;
      s += SHOW_CURSOR;
    }
    return s + SYNC_END;
  }
}
