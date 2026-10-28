// Event -> row folding and row -> display line rendering. Pure (no I/O) so it is unit-testable.
import type { AgentEvent, GateVerdict, Usage, Violation } from "../types.ts";
import { charWidth, createStyler, padRight, truncate, visibleWidth, wrapLine } from "./ansi.ts";
import type { Styler } from "./ansi.ts";
import { MdStream } from "./markdown.ts";
import type { EditorState } from "./input.ts";

// ---------- rows ----------
export type Row =
  | { kind: "user"; text: string }
  | { kind: "assistantDelta"; delta: string }
  | { kind: "assistantEnd" }
  | { kind: "tool"; receiptId: string; tool: string; args: Record<string, unknown>; ok: boolean; preview: string }
  | { kind: "gate"; gate: string; action: GateVerdict["action"]; reason: string; enforced: boolean }
  | { kind: "confirm"; id: string; tool: string; args: Record<string, unknown>; reason: string }
  | { kind: "notice"; level: "info" | "warn"; text: string }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export interface RunningTool { receiptId: string; tool: string; args: Record<string, unknown>; startedAt: number }
export interface PendingConfirm { id: string; tool: string; args: Record<string, unknown>; reason: string }

/** Folds a stream of AgentEvents into rows plus the live bookkeeping the status line needs. */
export class TurnFolder {
  running = new Map<string, RunningTool>();
  toolLog: { receiptId: string; tool: string; args: Record<string, unknown>; ok: boolean; preview: string }[] = [];
  totalCostUsd = 0;
  promptTokens = 0;
  completionTokens = 0;
  pendingConfirm: PendingConfirm | undefined;
  private streamedChars = 0;
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  startTurn(): void { this.streamedChars = 0; this.running.clear(); }

  handle(ev: AgentEvent): Row[] {
    switch (ev.type) {
      case "text":
        this.streamedChars += ev.delta.length;
        return [{ kind: "assistantDelta", delta: ev.delta }];
      case "toolStart":
        this.running.set(ev.receiptId, { receiptId: ev.receiptId, tool: ev.tool, args: ev.args, startedAt: this.now() });
        return [];
      case "toolEnd": {
        const started = this.running.get(ev.receiptId);
        this.running.delete(ev.receiptId);
        const entry = { receiptId: ev.receiptId, tool: ev.tool, args: started?.args ?? {}, ok: ev.ok, preview: ev.preview };
        this.toolLog.push(entry);
        return [{ kind: "tool", ...entry }];
      }
      case "gate":
        return [{ kind: "gate", gate: ev.verdict.gate, action: ev.verdict.action, reason: ev.verdict.reason, enforced: ev.enforced }];
      case "confirm":
        this.pendingConfirm = { id: ev.id, tool: ev.tool, args: ev.args, reason: ev.reason };
        return [{ kind: "confirm", id: ev.id, tool: ev.tool, args: ev.args, reason: ev.reason }];
      case "permission": // cards are for the web UI; the terminal never asks to show one (its turns are not interactive)
      case "permissionResolved":
      case "device_call": // relay-only: a device request for the iPhone or Mac app, never shown in a terminal
        return [];
      case "notice":
        return [{ kind: "notice", level: ev.level, text: ev.text }];
      case "retract":
        // A terminal cannot unprint: mark the block above as withdrawn so nobody reads it as the answer.
        return [{ kind: "notice", level: "warn", text: `the text above was withdrawn by a gate, rewriting: ${ev.reason}` }];
      case "usage":
        this.totalCostUsd = ev.totalCostUsd;
        this.addUsage(ev.usage);
        return [];
      case "done": {
        this.running.clear();
        const rows: Row[] = [];
        if (this.streamedChars === 0 && ev.finalText) rows.push({ kind: "assistantDelta", delta: ev.finalText });
        rows.push({ kind: "assistantEnd" });
        return rows;
      }
    }
  }
  private addUsage(u: Usage): void { this.promptTokens += u.promptTokens; this.completionTokens += u.completionTokens; }
}

// ---------- small formatters ----------
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
export const shortId = (id: string): string => (id.length > 10 ? id.slice(0, 8) : id);

function oneLine(v: unknown, max: number): string {
  let s: string;
  if (typeof v === "string") s = JSON.stringify(v);
  else { try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); } }
  s = s.replace(/\s+/g, " ");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** `{path:"a", mode:"r"}` -> `path: "a", mode: "r"` capped to `max` chars. */
export function summarizeArgs(args: Record<string, unknown>, max = 60): string {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) return "";
  const parts: string[] = [];
  let used = 0;
  for (const [k, v] of entries) {
    const room = Math.max(12, max - used - k.length - 4);
    const p = `${k}: ${oneLine(v, room)}`;
    if (used + p.length > max && parts.length > 0) { parts.push("…"); break; }
    parts.push(p); used += p.length + 2;
  }
  return parts.join(", ");
}

// ---------- symbols ----------
export interface Symbols { user: string; asst: string; ok: string; fail: string; tool: string; gate: string; info: string; warn: string; spin: string[]; rule: string; dot: string; boxTL: string; boxTR: string; boxBL: string; boxBR: string; boxH: string; boxV: string; sep: string }
export const UNICODE: Symbols = { user: "›", asst: "◆", ok: "✓", fail: "✗", tool: "⏺", gate: "⛨", info: "ℹ", warn: "⚠", spin: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], rule: "─", dot: "●", boxTL: "╭", boxTR: "╮", boxBL: "╰", boxBR: "╯", boxH: "─", boxV: "│", sep: "·" };
export const ASCII: Symbols = { user: ">", asst: "*", ok: "ok", fail: "FAIL", tool: "-", gate: "!", info: "i", warn: "!", spin: ["|", "/", "-", "\\"], rule: "-", dot: "*", boxTL: "+", boxTR: "+", boxBL: "+", boxBR: "+", boxH: "-", boxV: "|", sep: "|" };

export interface RenderOptions { width: number; color: boolean; ascii?: boolean; expand?: boolean }

/** Turns rows into display lines. Holds the markdown stream state for the assistant block in flight. */
export class TranscriptRenderer {
  private opts: RenderOptions;
  private md: MdStream;
  private inAssistant = false;
  private lastBlank = true;
  private sym: Symbols;
  constructor(opts: RenderOptions) {
    this.opts = { expand: false, ...opts };
    this.sym = this.opts.ascii ? ASCII : UNICODE;
    this.md = new MdStream(this.mdOpts());
  }
  private mdOpts() { return { width: Math.max(10, this.opts.width - 2), color: this.opts.color, ascii: this.opts.ascii }; }
  private get st(): Styler { return createStyler(this.opts.color); }

  setWidth(width: number): void { this.opts = { ...this.opts, width }; this.md.setOptions(this.mdOpts()); }
  setExpand(v: boolean): void { this.opts = { ...this.opts, expand: v }; }
  get expand(): boolean { return !!this.opts.expand; }
  get width(): number { return this.opts.width; }

  private assistantLines(lines: string[]): string[] {
    const st = this.st;
    const out: string[] = [];
    for (const l of lines) {
      if (!this.inAssistant) {
        if (l === "") continue; // never open a block with an empty line
        if (!this.lastBlank) out.push("");
        out.push(st.cyan(this.sym.asst) + " " + l);
        this.inAssistant = true;
      } else out.push(l === "" ? "" : "  " + l);
      this.lastBlank = l === "";
    }
    return out;
  }

  /** Display lines for the unfinished tail of the assistant text (re-rendered each frame, not committed). */
  pending(): string[] {
    const lines = this.md.pending();
    if (!lines.length) return [];
    const st = this.st;
    return lines.map((l, i) => (!this.inAssistant && i === 0 ? st.cyan(this.sym.asst) + " " : "  ") + l);
  }

  private endAssistant(): string[] {
    const out = this.assistantLines(this.md.flush());
    this.inAssistant = false;
    return out;
  }

  /** Commit a row; returns the lines to print into scrollback. */
  push(row: Row): string[] {
    const st = this.st;
    const S = this.sym;
    const w = Math.max(20, this.opts.width);
    if (row.kind === "assistantDelta") return this.assistantLines(this.md.push(row.delta));
    if (row.kind === "assistantEnd") {
      const out = this.endAssistant();
      return out;
    }
    const pre = this.endAssistant();
    let out: string[] = [];
    switch (row.kind) {
      case "user": {
        const lines = row.text.split("\n");
        out.push("");
        lines.forEach((l, i) => out.push((i === 0 ? st.bold(st.green(S.user)) + " " : "  ") + st.bold(l)));
        this.lastBlank = false;
        break;
      }
      case "tool": {
        const head = `${st.dim(S.tool)} ${st.bold(row.tool)}${st.dim("(" + summarizeArgs(row.args, Math.max(20, Math.floor(w / 2) - 10)) + ")")} ${row.ok ? st.green(S.ok) : st.red(S.fail)}`;
        const previewLines = row.preview.replace(/\r/g, "").split("\n").filter((l, i, a) => !(l === "" && i === a.length - 1));
        const first = previewLines[0] ?? "";
        if (!this.opts.expand) {
          const room = w - 4 - visibleWidth(head);
          const more = previewLines.length > 1 ? ` (+${previewLines.length - 1} lines)` : "";
          const pv = first ? " " + truncate(first + "", Math.max(8, room - more.length)) + more : "";
          out.push("  " + head + st.dim(pv));
        } else {
          out.push("  " + head);
          for (const l of previewLines.slice(0, 60)) for (const p of wrapLine(l === "" ? " " : l, w - 6)) out.push("    " + st.dim(p));
          if (previewLines.length > 60) out.push("    " + st.dim(`… ${previewLines.length - 60} more lines`));
        }
        break;
      }
      case "gate": {
        const tag = row.enforced ? st.bold(st.red("ENFORCED")) : st.bold(st.yellow("SHADOW"));
        const color = (s: string) => (row.enforced ? st.magenta(s) : st.yellow(s));
        const head = `${color(S.gate)} ${color(st.bold("gate:" + row.gate))} ${st.dim("[" + row.action + "]")} ${tag}`;
        out.push("  " + head);
        for (const p of wrapLine(row.reason, w - 6)) out.push("    " + color(p));
        break;
      }
      case "confirm": out = this.confirmCard(row); break;
      case "notice": {
        const warn = row.level === "warn";
        const icon = warn ? st.yellow(S.warn) : st.cyan(S.info);
        wrapLine(row.text, w - 4).forEach((p, i) => out.push(i === 0 ? `  ${icon} ${warn ? st.yellow(p) : p}` : `    ${warn ? st.yellow(p) : p}`));
        break;
      }
      case "info":
        out = row.text.split("\n").flatMap((l) => (l === "" ? [""] : wrapLine(l, w - 2).map((p) => "  " + p)));
        break;
      case "error":
        wrapLine(row.text, w - 4).forEach((p, i) => out.push(i === 0 ? `  ${st.red(S.fail)} ${st.red(p)}` : `    ${st.red(p)}`));
        break;
    }
    if (row.kind !== "user") this.lastBlank = false;
    return [...pre, ...out];
  }

  private confirmCard(row: Extract<Row, { kind: "confirm" }>): string[] {
    const st = this.st, S = this.sym;
    const boxW = Math.min(this.opts.width - 2, 84);
    const inner = boxW - 4;
    const body: string[] = [];
    body.push(st.bold(row.tool) + st.dim("(" + summarizeArgs(row.args, inner - row.tool.length - 2) + ")"));
    for (const p of wrapLine(row.reason, inner)) body.push(p);
    body.push("");
    for (const p of wrapLine('This needs your go-ahead. Reply with an explicit action phrase to approve, e.g. "send it", "do it" or "go ahead and run it". Anything else declines.', inner)) body.push(st.yellow(p));
    const title = ` Confirm `;
    const top = S.boxTL + S.boxH + title + S.boxH.repeat(Math.max(0, boxW - 3 - title.length)) + S.boxTR;
    const lines = [st.yellow(top)];
    for (const b of body) lines.push(st.yellow(S.boxV) + " " + padRight(b, inner) + " " + st.yellow(S.boxV));
    lines.push(st.yellow(S.boxBL + S.boxH.repeat(boxW - 2) + S.boxBR));
    return ["", ...lines.map((l) => "  " + l)];
  }
}

// ---------- live region ----------
export interface InputLayout { rows: string[]; cursorRow: number; cursorCol: number }

/** Hard-wrap the editor buffer to `width` columns (after a 2-col prompt) and locate the cursor. */
export function layoutInput(ed: Pick<EditorState, "lines" | "row" | "col">, width: number, prompt: string, cont: string): InputLayout {
  const avail = Math.max(4, width - 2);
  const rows: string[] = [];
  let cursorRow = 0, cursorCol = 2;
  ed.lines.forEach((line, li) => {
    const chunks: string[] = [];
    let cur = "", curW = 0;
    let cursorChunk = -1, cursorOff = 0;
    let idx = 0;
    for (const ch of line) {
      const cw = charWidth(ch.codePointAt(0)!);
      if (curW + cw > avail) { chunks.push(cur); cur = ""; curW = 0; }
      if (li === ed.row && idx === ed.col) { cursorChunk = chunks.length; cursorOff = curW; }
      cur += ch; curW += cw; idx += ch.length;
    }
    if (li === ed.row && cursorChunk === -1) {
      // cursor at end of line
      if (curW >= avail) { chunks.push(cur); cur = ""; curW = 0; }
      cursorChunk = chunks.length; cursorOff = curW;
    }
    chunks.push(cur);
    chunks.forEach((c, ci) => rows.push((li === 0 && ci === 0 ? prompt : cont) + c));
    if (li === ed.row) { cursorRow = rows.length - chunks.length + cursorChunk; cursorCol = 2 + cursorOff; }
  });
  return { rows, cursorRow, cursorCol };
}

export interface StatusInput {
  model?: string; sessionId?: string; costUsd: number; kernel?: "on" | "shadow" | "off";
  connected: boolean; running?: { elapsedMs: number; frame: number }; queued?: number; awaitingConfirm?: boolean;
  expand?: boolean;
}

export function buildStatus(s: StatusInput, width: number, color: boolean, ascii = false): string {
  const st = createStyler(color);
  const S = ascii ? ASCII : UNICODE;
  const sep = ` ${S.sep} `;
  const parts: string[] = [];
  parts.push(s.model ?? "default model");
  parts.push(s.sessionId ? `session ${shortId(s.sessionId)}` : "no session");
  parts.push(formatCost(s.costUsd));
  const k = s.kernel ?? "on";
  parts.push(`kernel ${k}`);
  if (s.expand) parts.push("expanded");
  if (s.awaitingConfirm) parts.push("awaiting confirm");
  if (s.queued) parts.push(`${s.queued} queued`);
  let left = parts.join(sep);
  const conn = s.connected ? `${S.dot} connected` : `${S.dot} offline`;
  const run = s.running ? `${S.spin[s.running.frame % S.spin.length]} working ${Math.floor(s.running.elapsedMs / 1000)}s  ` : "";
  let right = run + conn;
  const total = visibleWidth(left) + visibleWidth(right) + 3;
  if (total > width) left = truncate(left, Math.max(8, width - visibleWidth(right) - 3));
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 2);
  const connStyled = s.connected ? st.green(conn) : st.red(conn);
  right = run + connStyled;
  const line = " " + left + " ".repeat(gap) + right + " ";
  return color ? st.inverse(padRightPlain(line, width)) : line;
}
function padRightPlain(s: string, w: number): string { return padRight(s, w); }

export interface LiveParams {
  width: number; color: boolean; ascii?: boolean;
  pending: string[];                // assistant tail, already rendered
  running: { tool: string; args: Record<string, unknown>; elapsedMs: number }[];
  frame: number;
  editor: Pick<EditorState, "lines" | "row" | "col">;
  status: StatusInput;
  maxRows: number;                  // terminal rows available
  hint?: string;
}
export interface LiveRegion { lines: string[]; cursorRow: number; cursorCol: number }

/** Compose the redrawn bottom region: pending text, running tools, rule, input box, status line. */
export function composeLive(p: LiveParams): LiveRegion {
  const st = createStyler(p.color);
  const S = p.ascii ? ASCII : UNICODE;
  const width = Math.max(20, p.width);
  const input = layoutInput(p.editor, width, st.bold(st.green(S.user)) + " ", "  ");
  const status = buildStatus(p.status, width - 1, p.color, p.ascii);
  const hint = p.hint && visibleWidth(p.hint) + 14 <= width ? p.hint : "";
  const rule = st.dim(S.rule.repeat(Math.max(0, width - 1 - (hint ? visibleWidth(hint) + 2 : 0)))) + (hint ? " " + st.dim(hint) : "");
  const fixed = 1 /*rule*/ + 1 /*status*/;
  const maxInput = Math.max(1, Math.min(input.rows.length, Math.floor(p.maxRows / 2)));
  let inRows = input.rows;
  let cursorRowInInput = input.cursorRow;
  if (inRows.length > maxInput) {
    const start = Math.min(Math.max(0, input.cursorRow - maxInput + 1), inRows.length - maxInput);
    inRows = inRows.slice(start, start + maxInput);
    cursorRowInInput = input.cursorRow - start;
  }
  const runLines = p.running.map((r) => truncate(`  ${st.cyan(S.spin[p.frame % S.spin.length])} ${st.bold(r.tool)}${st.dim("(" + summarizeArgs(r.args, 50) + ")")} ${st.dim(Math.floor(r.elapsedMs / 1000) + "s")}`, width - 1));
  const room = Math.max(0, p.maxRows - fixed - inRows.length - runLines.length - 1);
  const pend = p.pending.slice(-room).map((l) => truncate(l, width - 1));
  const lines = [...pend, ...runLines, rule, ...inRows.map((l) => truncate(l, width - 1, "")), status];
  const cursorRow = pend.length + runLines.length + 1 + cursorRowInInput;
  return { lines, cursorRow, cursorCol: Math.min(input.cursorCol, width - 1) };
}

// ---------- violations / sessions views ----------
export function formatViolations(vs: Violation[]): string {
  if (!vs.length) return "No violations recorded this session.";
  return vs.map((v) => `${new Date(v.at).toISOString().slice(11, 19)} ${v.enforced ? "ENFORCED" : "SHADOW  "} ${v.gate} [${v.action}] ${v.reason}`).join("\n");
}
