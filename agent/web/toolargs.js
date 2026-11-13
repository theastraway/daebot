// The one-line summary of a tool call's arguments, shown on a collapsed action row
// (and in the Confirm card header). A browser module with no DOM and no imports, so
// it can be unit-tested directly like toolroll.js and switchcache.js.
//
// Why this is its own module: a bash command is routinely multi-line —
//
//   export PATH="$HOME/.local/bin:$PATH"
//   cd ~/code/ContentsCounter && npm test
//
// Flattening a newline to a plain space rendered that as one impossible command
// (`export PATH="..." cd ~/code/...`), which reads as the bot having typed garbage.
// It never was: the real string keeps its newlines. The summary must not lie about
// where the command breaks, so a newline becomes a visible break marker.

/** Where the summary stops growing: the row is a single clipped line. */
export const ARG_MAX = 70;
/** Where the whole summary stops: past this the row is unreadable anyway. */
export const ARGS_TOTAL_MAX = 90;
/** How a line break is shown in a single-line row. */
export const BREAK_MARK = " ⏎ ";

/**
 * Fold a value to one line for display.
 * Newlines become BREAK_MARK so a multi-line command still reads as separate lines;
 * every other run of whitespace becomes a single space.
 */
export function oneLine(v) {
  const s = typeof v === "string" ? v : (() => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } })();
  return s
    .replace(/\r\n?/g, "\n")          // CRLF and lone CR first, so they count as one break
    .replace(/[^\S\n]+/g, " ")        // runs of spaces/tabs -> one space, newlines untouched
    .replace(/ *\n */g, BREAK_MARK)   // a break, with at most one space either side
    .trim();
}

/**
 * `{command:"a\nb", cwd:"/x"}` -> `command=a ⏎ b  cwd=/x`, capped.
 * Keys and the separator are the same as before this change; only the rendering of
 * a line break inside a value is new.
 */
export function argSummary(args, max = ARG_MAX, totalMax = ARGS_TOTAL_MAX) {
  const parts = [];
  for (const [k, v] of Object.entries(args || {})) {
    const s = oneLine(v);
    const room = Math.max(12, max - k.length - 1);
    const cut = s.length > room ? s.slice(0, room - 1) + "…" : s;
    parts.push(`${k}=${cut}`);
    if (parts.join("  ").length > totalMax) break;
  }
  return parts.join("  ");
}
