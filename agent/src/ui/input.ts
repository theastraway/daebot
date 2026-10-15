// Multi-line line editor as a pure state machine, plus the raw-stdin key parser. No I/O.

export interface Key {
  name: string;          // "char" | "paste" | "enter" | "newline" | "backspace" | "delete" | "left" | "right" | "up" | "down"
                         // | "home" | "end" | "tab" | "escape" | "pageup" | "pagedown" | "shifttab" | <letter for ctrl/alt combos>
  text?: string;         // for "char" and "paste"
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface EditorState {
  lines: string[];
  row: number;
  col: number;           // UTF-16 index into lines[row]
  killBuf: string;
  lastWasKill: boolean;
  history: string[];     // oldest first
  histIdx: number;       // -1 when not browsing
  draft: string;         // text typed before browsing history started
}

export type EditorAction =
  | { type: "submit"; text: string }
  | { type: "interrupt" }
  | { type: "eof" }
  | { type: "clear-screen" }
  | { type: "escape" }
  | { type: "tab" };

export function newEditor(history: string[] = []): EditorState {
  return { lines: [""], row: 0, col: 0, killBuf: "", lastWasKill: false, history: [...history], histIdx: -1, draft: "" };
}

export const editorText = (s: EditorState): string => s.lines.join("\n");
export const editorIsEmpty = (s: EditorState): boolean => s.lines.length === 1 && s.lines[0] === "";

export function setEditorText(s: EditorState, text: string): EditorState {
  const lines = text.split("\n");
  return { ...s, lines, row: lines.length - 1, col: lines[lines.length - 1].length };
}

// ---------- key parsing ----------
const CSI = /^\x1b\[([0-9;?]*)([@-~])/;
const SS3 = /^\x1bO([A-Za-z])/;

function modsFrom(code: number | undefined): Pick<Key, "shift" | "alt" | "ctrl"> {
  if (code === undefined || code <= 1) return {};
  const m = code - 1;
  return { shift: !!(m & 1) || undefined, alt: !!(m & 2) || undefined, ctrl: !!(m & 4) || undefined };
}

function csiKey(params: string, final: string): Key | undefined {
  const parts = params.split(";");
  const n0 = parts[0] === "" ? undefined : Number(parts[0]);
  const mod = parts[1] !== undefined ? Number(parts[1]) : undefined;
  const mods = modsFrom(mod);
  const base = (name: string): Key => ({ name, ...mods });
  switch (final) {
    case "A": return base("up");
    case "B": return base("down");
    case "C": return base("right");
    case "D": return base("left");
    case "H": return base("home");
    case "F": return base("end");
    case "Z": return { name: "shifttab", shift: true };
    case "~": {
      if (n0 === 27 && parts.length === 3) { // xterm modifyOtherKeys: ESC [ 27 ; mod ; code ~
        const code = Number(parts[2]);
        if (code === 13) return { name: modsFrom(Number(parts[1])).shift || modsFrom(Number(parts[1])).alt ? "newline" : "enter" };
        return undefined;
      }
      switch (n0) {
        case 1: case 7: return base("home");
        case 4: case 8: return base("end");
        case 3: return base("delete");
        case 5: return base("pageup");
        case 6: return base("pagedown");
        case 2: return undefined;
      }
      return undefined;
    }
    case "u": { // kitty / CSI-u: ESC [ code ; mod u
      const code = n0;
      const mk = modsFrom(mod);
      if (code === 13) return { name: mk.shift || mk.alt ? "newline" : "enter" };
      if (code === 9) return { name: mk.shift ? "shifttab" : "tab" };
      if (code === 27) return { name: "escape" };
      if (code === 127) return { name: "backspace", ...mk };
      if (code !== undefined && code >= 32 && !mk.ctrl && !mk.alt) return { name: "char", text: String.fromCodePoint(code) };
      if (code !== undefined && mk.ctrl && code >= 97 && code <= 122) return { name: String.fromCharCode(code), ctrl: true };
      return undefined;
    }
  }
  return undefined;
}

/**
 * Parse a chunk of raw stdin bytes into keys. `rest` is an incomplete trailing sequence to prepend to the next
 * chunk; pass `flush: true` after a short idle to turn a lone ESC into an escape key.
 */
export function parseKeys(input: string, opts: { flush?: boolean } = {}): { keys: Key[]; rest: string } {
  const keys: Key[] = [];
  let i = 0;
  let text = "";
  const flushText = () => { if (text) { keys.push({ name: "char", text }); text = ""; } };
  while (i < input.length) {
    const ch = input[i];
    const code = input.charCodeAt(i);
    if (ch === "\x1b") {
      const tail = input.slice(i);
      if (tail.startsWith("\x1b[200~")) {
        const end = tail.indexOf("\x1b[201~");
        if (end === -1) { flushText(); return { keys, rest: tail }; }
        flushText();
        keys.push({ name: "paste", text: tail.slice(6, end) });
        i += end + 6; continue;
      }
      if (tail.length === 1) {
        flushText();
        if (opts.flush) { keys.push({ name: "escape" }); i++; continue; }
        return { keys, rest: tail };
      }
      if (tail[1] === "[") {
        const m = CSI.exec(tail);
        if (!m) {
          if (!opts.flush && tail.length < 24 && /^\x1b\[[0-9;?]*$/.test(tail)) { flushText(); return { keys, rest: tail }; }
          flushText(); keys.push({ name: "escape" }); i++; continue;
        }
        flushText();
        const k = csiKey(m[1], m[2]);
        if (k) keys.push(k);
        i += m[0].length; continue;
      }
      if (tail[1] === "O") {
        const m = SS3.exec(tail);
        if (!m) { if (tail.length < 3 && !opts.flush) { flushText(); return { keys, rest: tail }; } flushText(); i++; continue; }
        flushText();
        const map: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
        if (map[m[1]]) keys.push({ name: map[m[1]] });
        i += m[0].length; continue;
      }
      // Alt + something
      flushText();
      const nx = tail[1];
      if (nx === "\r" || nx === "\n") keys.push({ name: "newline", alt: true });
      else if (nx === "\x7f" || nx === "\b") keys.push({ name: "backspace", alt: true });
      else keys.push({ name: nx, alt: true });
      i += 2; continue;
    }
    if (code === 13) { flushText(); keys.push({ name: "enter" }); i++; continue; }
    if (code === 10) { flushText(); keys.push({ name: "newline" }); i++; continue; }
    if (code === 9) { flushText(); keys.push({ name: "tab" }); i++; continue; }
    if (code === 127 || code === 8) { flushText(); keys.push({ name: "backspace" }); i++; continue; }
    if (code >= 1 && code <= 26) { flushText(); keys.push({ name: String.fromCharCode(96 + code), ctrl: true }); i++; continue; }
    if (code < 32) { flushText(); i++; continue; }
    const cp = input.codePointAt(i)!;
    const c = String.fromCodePoint(cp);
    text += c; i += c.length;
  }
  flushText();
  return { keys, rest: "" };
}

// ---------- reducer ----------
const clone = (s: EditorState): EditorState => ({ ...s, lines: [...s.lines], history: s.history });

function prevIdx(line: string, col: number): number {
  if (col >= 2) {
    const lo = line.charCodeAt(col - 1), hi = line.charCodeAt(col - 2);
    if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff) return col - 2;
  }
  return Math.max(0, col - 1);
}
function nextIdx(line: string, col: number): number {
  if (col + 1 < line.length) {
    const hi = line.charCodeAt(col), lo = line.charCodeAt(col + 1);
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) return col + 2;
  }
  return Math.min(line.length, col + 1);
}
function wordStartBefore(line: string, col: number): number {
  let c = col;
  while (c > 0 && /\s/.test(line[c - 1])) c--;
  while (c > 0 && !/\s/.test(line[c - 1])) c--;
  return c;
}
function wordEndAfter(line: string, col: number): number {
  let c = col;
  while (c < line.length && /\s/.test(line[c])) c++;
  while (c < line.length && !/\s/.test(line[c])) c++;
  return c;
}

export function insertText(s: EditorState, text: string): EditorState {
  const n = clone(s);
  const clean = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const parts = clean.split("\n");
  const line = n.lines[n.row];
  const before = line.slice(0, n.col), after = line.slice(n.col);
  if (parts.length === 1) {
    n.lines[n.row] = before + parts[0] + after;
    n.col += parts[0].length;
  } else {
    const mid = parts.slice(1, -1);
    const last = parts[parts.length - 1];
    n.lines.splice(n.row, 1, before + parts[0], ...mid, last + after);
    n.row += parts.length - 1;
    n.col = last.length;
  }
  return n;
}

function loadHistory(n: EditorState, text: string): void {
  n.lines = text.split("\n");
  n.row = n.lines.length - 1;
  n.col = n.lines[n.row].length;
}

export function applyKey(prev: EditorState, key: Key): { state: EditorState; action?: EditorAction } {
  let n = clone(prev);
  const wasKill = prev.lastWasKill;
  n.lastWasKill = false;
  const line = () => n.lines[n.row];
  const setLine = (v: string) => { n.lines[n.row] = v; };
  const kill = (text: string, mode: "append" | "prepend") => {
    if (!text) return;
    n.killBuf = wasKill ? (mode === "append" ? n.killBuf + text : text + n.killBuf) : text;
    n.lastWasKill = true;
  };
  const leaveHistory = () => { n.histIdx = -1; };

  const moveLeft = () => {
    if (n.col > 0) n.col = prevIdx(line(), n.col);
    else if (n.row > 0) { n.row--; n.col = line().length; }
  };
  const moveRight = () => {
    if (n.col < line().length) n.col = nextIdx(line(), n.col);
    else if (n.row < n.lines.length - 1) { n.row++; n.col = 0; }
  };
  const backspace = () => {
    if (n.col > 0) {
      const p = prevIdx(line(), n.col);
      setLine(line().slice(0, p) + line().slice(n.col)); n.col = p;
    } else if (n.row > 0) {
      const prevLen = n.lines[n.row - 1].length;
      n.lines[n.row - 1] += n.lines[n.row]; n.lines.splice(n.row, 1); n.row--; n.col = prevLen;
    }
  };
  const del = () => {
    if (n.col < line().length) {
      const e = nextIdx(line(), n.col);
      setLine(line().slice(0, n.col) + line().slice(e));
    } else if (n.row < n.lines.length - 1) {
      n.lines[n.row] += n.lines[n.row + 1]; n.lines.splice(n.row + 1, 1);
    }
  };
  const up = (): boolean => {
    if (n.row > 0) { n.row--; n.col = Math.min(n.col, line().length); return true; }
    // history
    if (n.history.length === 0) return false;
    if (n.histIdx === -1) { n.draft = editorText(n); n.histIdx = n.history.length - 1; }
    else if (n.histIdx > 0) n.histIdx--;
    else return true;
    loadHistory(n, n.history[n.histIdx]);
    n.row = 0; n.col = Math.min(n.col, n.lines[0].length); // land at top so repeated Up keeps browsing
    return true;
  };
  const down = (): boolean => {
    if (n.row < n.lines.length - 1) { n.row++; n.col = Math.min(n.col, line().length); return true; }
    if (n.histIdx === -1) return false;
    if (n.histIdx < n.history.length - 1) { n.histIdx++; loadHistory(n, n.history[n.histIdx]); }
    else { n.histIdx = -1; loadHistory(n, n.draft); }
    return true;
  };

  const k = key;
  if (k.name === "char" || k.name === "paste") {
    leaveHistory();
    n = insertText(n, k.text ?? ""); n.lastWasKill = false;
    return { state: n };
  }
  if (k.ctrl) {
    switch (k.name) {
      case "a": n.col = 0; break;
      case "e": n.col = line().length; break;
      case "b": moveLeft(); break;
      case "f": moveRight(); break;
      case "p": up(); break;
      case "n": down(); break;
      case "h": backspace(); leaveHistory(); break;
      case "d":
        if (editorIsEmpty(prev)) return { state: n, action: { type: "eof" } };
        del(); leaveHistory(); break;
      case "c": return { state: n, action: { type: "interrupt" } };
      case "l": return { state: n, action: { type: "clear-screen" } };
      case "u": {
        const cut = line().slice(0, n.col);
        if (cut === "" && n.row > 0) { kill("\n", "prepend"); backspace(); }
        else { kill(cut, "prepend"); setLine(line().slice(n.col)); n.col = 0; }
        leaveHistory(); break;
      }
      case "k": {
        const cut = line().slice(n.col);
        if (cut === "" && n.row < n.lines.length - 1) { kill("\n", "append"); del(); }
        else { kill(cut, "append"); setLine(line().slice(0, n.col)); }
        leaveHistory(); break;
      }
      case "w": {
        if (n.col === 0) { backspace(); break; }
        const s = wordStartBefore(line(), n.col);
        kill(line().slice(s, n.col), "prepend"); setLine(line().slice(0, s) + line().slice(n.col)); n.col = s;
        leaveHistory(); break;
      }
      case "y": n = insertText(n, prev.killBuf); n.lastWasKill = false; leaveHistory(); break;
      case "j": n = insertText(n, "\n"); break;
      case "left": n.col = wordStartBefore(line(), n.col); break;
      case "right": n.col = wordEndAfter(line(), n.col); break;
      default: break;
    }
    return { state: n };
  }
  if (k.alt) {
    switch (k.name) {
      case "b": n.col = wordStartBefore(line(), n.col); break;
      case "f": n.col = wordEndAfter(line(), n.col); break;
      case "d": {
        const e = wordEndAfter(line(), n.col);
        kill(line().slice(n.col, e), "append"); setLine(line().slice(0, n.col) + line().slice(e)); leaveHistory(); break;
      }
      case "backspace": {
        if (n.col === 0) { backspace(); break; }
        const s = wordStartBefore(line(), n.col);
        kill(line().slice(s, n.col), "prepend"); setLine(line().slice(0, s) + line().slice(n.col)); n.col = s;
        leaveHistory(); break;
      }
      case "newline": n = insertText(n, "\n"); leaveHistory(); break;
      case "left": n.col = wordStartBefore(line(), n.col); break;
      case "right": n.col = wordEndAfter(line(), n.col); break;
      default: break;
    }
    return { state: n };
  }
  switch (k.name) {
    case "enter": {
      if (k.shift || k.alt) { n = insertText(n, "\n"); leaveHistory(); return { state: n }; }
      // trailing backslash continues the line
      if (n.col === line().length && line().endsWith("\\")) {
        setLine(line().slice(0, -1)); n = insertText(n, "\n"); leaveHistory(); return { state: n };
      }
      const text = editorText(n);
      const fresh = newEditor(prev.history);
      fresh.killBuf = prev.killBuf;
      if (text.trim() !== "" && fresh.history[fresh.history.length - 1] !== text) fresh.history = [...fresh.history, text];
      return { state: fresh, action: { type: "submit", text } };
    }
    case "newline": n = insertText(n, "\n"); leaveHistory(); break;
    case "backspace": backspace(); leaveHistory(); break;
    case "delete": del(); leaveHistory(); break;
    case "left": if (k.ctrl || k.alt) n.col = wordStartBefore(line(), n.col); else moveLeft(); break;
    case "right": if (k.ctrl || k.alt) n.col = wordEndAfter(line(), n.col); else moveRight(); break;
    case "up": up(); break;
    case "down": down(); break;
    case "home": n.col = 0; break;
    case "end": n.col = line().length; break;
    case "tab": return { state: n, action: { type: "tab" } };
    case "escape": return { state: n, action: { type: "escape" } };
    default: break;
  }
  return { state: n };
}
