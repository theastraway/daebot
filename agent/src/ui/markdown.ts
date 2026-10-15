// Light markdown renderer for terminals: headings, lists, quotes, rules, fenced code with a left rule,
// inline code, bold, italic and links. Pure. Streaming-friendly via MdStream (line at a time).
import { createStyler, wrapLine } from "./ansi.ts";
import type { Styler } from "./ansi.ts";

export interface MdOptions { width: number; color: boolean; ascii?: boolean }

/** Render inline spans of a single line to a styled string (no wrapping). */
export function renderInline(text: string, st: Styler): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    // inline code
    if (c === "`") {
      let ticks = 1;
      while (text[i + ticks] === "`") ticks++;
      const fence = "`".repeat(ticks);
      const end = text.indexOf(fence, i + ticks);
      if (end > i + ticks) {
        const code = text.slice(i + ticks, end).replace(/^ (.*) $/, "$1");
        out += st.enabled ? st.yellow(code) : "`" + code + "`";
        i = end + ticks; continue;
      }
      out += fence; i += ticks; continue;
    }
    // bold
    if ((c === "*" && text[i + 1] === "*") || (c === "_" && text[i + 1] === "_")) {
      const mark = c + c;
      const end = text.indexOf(mark, i + 2);
      if (end > i + 2 && !/^\s/.test(text[i + 2])) {
        const inner = renderInline(text.slice(i + 2, end), st);
        out += st.enabled ? st.bold(inner) : inner;
        i = end + 2; continue;
      }
    }
    // italic
    if ((c === "*" || c === "_") && text[i + 1] !== c && text[i + 1] !== undefined && !/\s/.test(text[i + 1])) {
      const prev = i > 0 ? text[i - 1] : " ";
      if (c === "*" || !/[A-Za-z0-9]/.test(prev)) {
        const end = text.indexOf(c, i + 1);
        if (end > i + 1 && !/\s/.test(text[end - 1]) && (c === "*" || !/[A-Za-z0-9]/.test(text[end + 1] ?? " "))) {
          const inner = renderInline(text.slice(i + 1, end), st);
          out += st.enabled ? st.italic(inner) : inner;
          i = end + 1; continue;
        }
      }
    }
    // link [label](url)
    if (c === "[") {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m) {
        out += st.enabled ? st.underline(st.cyan(m[1])) + st.dim(" (" + m[2] + ")") : `${m[1]} (${m[2]})`;
        i += m[0].length; continue;
      }
    }
    // bare url
    if (c === "h" && (text.startsWith("http://", i) || text.startsWith("https://", i))) {
      const m = /^https?:\/\/[^\s)<>]+/.exec(text.slice(i));
      if (m) {
        const url = m[0].replace(/[.,;:!?]+$/, "");
        out += st.enabled ? st.underline(st.cyan(url)) : url;
        i += url.length; continue;
      }
    }
    out += c; i++;
  }
  return out;
}

export interface MdState { inFence: boolean; fenceLang: string; fenceMark: string }
export const newMdState = (): MdState => ({ inFence: false, fenceLang: "", fenceMark: "" });

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;

/** Render ONE raw markdown line (mutating fence state) into zero or more display lines. */
export function renderMdLine(raw: string, state: MdState, opts: MdOptions): string[] {
  const st = createStyler(opts.color);
  const width = Math.max(10, opts.width);
  const A = !!opts.ascii;
  const rule = st.dim(A ? "| " : "│ ");
  const fm = FENCE_RE.exec(raw);

  if (state.inFence) {
    if (fm && fm[1][0] === state.fenceMark[0] && fm[1].length >= state.fenceMark.length && fm[2] === "") {
      state.inFence = false; state.fenceLang = ""; state.fenceMark = "";
      return [st.dim(A ? "+-" : "╰─")];
    }
    const body = raw.replace(/\t/g, "  ");
    const parts = body === "" ? [""] : hardWrap(body, width - 2);
    return parts.map((p) => rule + (st.enabled ? st.gray(p) : p));
  }
  if (fm) {
    state.inFence = true; state.fenceMark = fm[1]; state.fenceLang = fm[2];
    return [st.dim((A ? "+-" : "╭─") + (fm[2] ? " " + fm[2] : ""))];
  }
  if (raw.trim() === "") return [""];

  let m: RegExpExecArray | null;
  if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw))) {
    const body = renderInline(m[2], st);
    const styled = st.enabled ? st.bold(m[1].length <= 2 ? st.cyan(body) : body) : body;
    return wrapLine(styled, width);
  }
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) return [st.dim((A ? "-" : "─").repeat(Math.min(width, 40)))];
  if ((m = /^(\s*)>\s?(.*)$/.exec(raw))) {
    const q = st.dim(A ? "> " : "▎ ");
    return wrapLine(renderInline(m[2], st), width - 2).map((l) => q + (st.enabled ? st.italic(l) : l));
  }
  if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw))) {
    const indent = " ".repeat(Math.min(8, Math.floor(m[1].length / 2) * 2));
    const bullet = /\d/.test(m[2]) ? m[2] : A ? "*" : "•";
    const lead = indent + (st.enabled ? st.cyan(bullet) : bullet) + " ";
    const leadW = indent.length + bullet.length + 1;
    const lines = wrapLine(renderInline(m[3], st), width - leadW);
    return lines.map((l, i) => (i === 0 ? lead : " ".repeat(leadW)) + l);
  }
  return wrapLine(renderInline(raw, st), width);
}

function hardWrap(s: string, width: number): string[] {
  const out: string[] = [];
  const cps = Array.from(s);
  for (let i = 0; i < cps.length; i += Math.max(1, width)) out.push(cps.slice(i, i + width).join(""));
  return out.length ? out : [""];
}

/** Render a whole markdown document. */
export function renderMarkdown(text: string, opts: MdOptions): string[] {
  const state = newMdState();
  const out: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) out.push(...renderMdLine(raw, state, opts));
  if (state.inFence) out.push(createStyler(opts.color).dim(opts.ascii ? "+-" : "╰─"));
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** Incremental renderer: feed deltas, get finished display lines back; the open partial line is exposed separately. */
export class MdStream {
  private buf = "";
  private state = newMdState();
  private opts: MdOptions;
  constructor(opts: MdOptions) { this.opts = opts; }
  setOptions(opts: MdOptions): void { this.opts = opts; }
  push(delta: string): string[] {
    this.buf += delta.replace(/\r\n/g, "\n");
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      out.push(...renderMdLine(line, this.state, this.opts));
    }
    return out;
  }
  /** Display lines for the unfinished tail, without committing it. */
  pending(): string[] {
    if (this.buf === "") return [];
    const copy: MdState = { ...this.state };
    return renderMdLine(this.buf, copy, this.opts);
  }
  hasPending(): boolean { return this.buf !== ""; }
  flush(): string[] {
    const out: string[] = [];
    if (this.buf !== "") { out.push(...renderMdLine(this.buf, this.state, this.opts)); this.buf = ""; }
    if (this.state.inFence) { out.push(createStyler(this.opts.color).dim(this.opts.ascii ? "+-" : "╰─")); this.state = newMdState(); }
    return out;
  }
}
