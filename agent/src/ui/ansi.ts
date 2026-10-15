// Raw ANSI helpers: styling, visible width, ANSI-aware wrapping. Pure, no I/O.

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ANSI_AT = /^\x1b\[([0-9;?]*)([A-Za-z])/;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function charWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x20d0 && cp <= 0x20ff)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Truncate to a visible width, appending an ellipsis. Keeps ANSI sequences intact and closes styling. */
export function truncate(s: string, width: number, ellipsis = "…"): string {
  if (visibleWidth(s) <= width) return s;
  const target = Math.max(0, width - visibleWidth(ellipsis));
  let out = "";
  let w = 0;
  let i = 0;
  let hadAnsi = false;
  while (i < s.length) {
    const m = ANSI_AT.exec(s.slice(i, i + 32));
    if (m && s[i] === "\x1b") { out += m[0]; i += m[0].length; hadAnsi = true; continue; }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > target) break;
    out += ch; w += cw; i += ch.length;
  }
  return out + (hadAnsi ? "\x1b[0m" : "") + ellipsis;
}

export function padRight(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

// ---------- styling ----------
export interface Styler {
  readonly enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  italic(s: string): string;
  underline(s: string): string;
  inverse(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  magenta(s: string): string;
  cyan(s: string): string;
  gray(s: string): string;
}

export function createStyler(enabled: boolean): Styler {
  const w = (open: string, close: string) => (s: string) => (enabled && s !== "" ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    enabled,
    bold: w("1", "22"), dim: w("2", "22"), italic: w("3", "23"), underline: w("4", "24"), inverse: w("7", "27"),
    red: w("31", "39"), green: w("32", "39"), yellow: w("33", "39"), blue: w("34", "39"),
    magenta: w("35", "39"), cyan: w("36", "39"), gray: w("90", "39"),
  };
}

/** True when colour should be used: a TTY and NO_COLOR unset (https://no-color.org) and TERM not dumb. */
export function colorEnabled(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  if (!isTTY) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return true;
}

// ---------- ANSI-aware wrapping ----------
type SgrState = Map<string, string>; // attribute key -> sequence that re-opens it

function applySgr(state: SgrState, params: string): void {
  const parts = params === "" ? ["0"] : params.split(";");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const n = Number(p);
    if (n === 0) state.clear();
    else if (n === 1) state.set("bold", "\x1b[1m");
    else if (n === 2) state.set("dim", "\x1b[2m");
    else if (n === 3) state.set("italic", "\x1b[3m");
    else if (n === 4) state.set("underline", "\x1b[4m");
    else if (n === 7) state.set("inverse", "\x1b[7m");
    else if (n === 22) { state.delete("bold"); state.delete("dim"); }
    else if (n === 23) state.delete("italic");
    else if (n === 24) state.delete("underline");
    else if (n === 27) state.delete("inverse");
    else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) state.set("fg", `\x1b[${n}m`);
    else if (n === 39) state.delete("fg");
    else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) state.set("bg", `\x1b[${n}m`);
    else if (n === 49) state.delete("bg");
    else if (n === 38 || n === 48) {
      const key = n === 38 ? "fg" : "bg";
      if (parts[i + 1] === "5") { state.set(key, `\x1b[${parts.slice(i, i + 3).join(";")}m`); i += 2; }
      else if (parts[i + 1] === "2") { state.set(key, `\x1b[${parts.slice(i, i + 5).join(";")}m`); i += 4; }
    }
  }
}

const reopen = (st: SgrState) => [...st.values()].join("");

/** Wrap one logical line (no "\n") to `width` visible columns, preserving SGR styling across breaks. */
export function wrapLine(input: string, width: number): string[] {
  width = Math.max(1, width);
  const lines: string[] = [];
  let cur = ""; let curW = 0; let curHasContent = false;
  let word = ""; let wordW = 0;
  const state: SgrState = new Map();
  let endState: SgrState = new Map(); // style state at end of `cur` content
  let wordStartState: SgrState = new Map();
  let startOfLine = true;

  const closeLine = (s: string, st: SgrState) => (st.size ? s + "\x1b[0m" : s);
  const pushLine = () => {
    lines.push(closeLine(cur, endState));
    cur = reopen(endState); curW = 0; curHasContent = false;
  };
  const flushWord = () => {
    if (word === "") return;
    if (curHasContent && curW + 1 + wordW > width) pushLine();
    if (curHasContent) { cur += " "; curW += 1; }
    cur += word; curW += wordW; curHasContent = true;
    endState = new Map(state);
    word = ""; wordW = 0;
  };

  let i = 0;
  while (i < input.length) {
    if (input[i] === "\x1b") {
      const m = ANSI_AT.exec(input.slice(i, i + 40));
      if (m) {
        if (word === "") wordStartState = new Map(state);
        if (m[2] === "m") applySgr(state, m[1]);
        word += m[0]; i += m[0].length; continue;
      }
    }
    const cp = input.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (ch === " ") {
      flushWord();
      if (startOfLine && !curHasContent) { // preserve leading indentation
        cur += " "; curW += 1;
      }
      continue;
    }
    startOfLine = false;
    const cw = charWidth(cp);
    if (wordW + cw > width) {
      // a single word longer than the line: hard-break it
      if (curHasContent) pushLine();
      cur += word; curW += wordW; curHasContent = true; endState = new Map(state);
      pushLine();
      word = reopen(state); wordW = 0;
    }
    word += ch; wordW += cw;
  }
  void wordStartState;
  flushWord();
  if (cur !== "" || lines.length === 0) lines.push(closeLine(cur, endState));
  return lines;
}

export function wrap(text: string, width: number): string[] {
  return text.split("\n").flatMap((l) => wrapLine(l, width));
}
