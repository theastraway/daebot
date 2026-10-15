// The terminal app: wires stdin/stdout, the SessionClient, the pure editor and the pure renderer together.
// Two modes: interactive (raw-mode TTY, redrawn live region) and plain (line mode for pipes / non-TTY).
import type { AgentEvent } from "../types.ts";
import { colorEnabled } from "./ansi.ts";
import { COMMANDS, completeCommand, routeInput } from "./commands.ts";
import type { Action } from "./commands.ts";
import type { RuntimeInfo, SessionClient } from "./client.ts";
import { appendHistory, loadHistory } from "./history.ts";
import { applyKey, editorIsEmpty, editorText, newEditor, parseKeys, setEditorText } from "./input.ts";
import type { EditorState } from "./input.ts";
import { composeLive, formatCost, formatViolations, shortId, TranscriptRenderer, TurnFolder } from "./render.ts";
import type { Row } from "./render.ts";
import { CLEAR_ALL, LiveScreen, PASTE_OFF, PASTE_ON, SHOW_CURSOR } from "./screen.ts";

export interface InStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding?(enc: string): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on(event: string, cb: (...a: any[]) => void): unknown;
  off?(event: string, cb: (...a: any[]) => void): unknown;
  removeListener?(event: string, cb: (...a: any[]) => void): unknown;
}
export interface OutStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(s: string): unknown;
  on?(event: string, cb: (...a: any[]) => void): unknown;
  off?(event: string, cb: (...a: any[]) => void): unknown;
  removeListener?(event: string, cb: (...a: any[]) => void): unknown;
}

export interface AppDeps {
  client: SessionClient;
  stdin: InStream;
  stdout: OutStream;
  env?: Record<string, string | undefined>;
  historyPath?: string | null;      // null disables persistence
  now?: () => number;
  /** Force a mode (tests). Default: interactive iff stdin and stdout are TTYs. */
  interactive?: boolean;
}

const CTRL_C_WINDOW_MS = 2000;

export class TuiApp {
  private d: AppDeps;
  private env: Record<string, string | undefined>;
  private now: () => number;
  readonly interactive: boolean;
  private color: boolean;
  private ascii: boolean;
  private client: SessionClient;
  private sessionId = "";
  private info: RuntimeInfo = {};
  private folder: TurnFolder;
  private renderer: TranscriptRenderer;
  private screen = new LiveScreen();
  private editor: EditorState = newEditor();
  private running = false;
  private turnStartedAt = 0;
  private abortCtl: AbortController | undefined;
  private aborted = false;
  private queue: string[] = [];
  private lastCtrlC = 0;
  private frame = 0;
  private pendingCommit: string[] = [];
  private drawTimer: ReturnType<typeof setTimeout> | undefined;
  private spinTimer: ReturnType<typeof setInterval> | undefined;
  private escTimer: ReturnType<typeof setTimeout> | undefined;
  private keyRest = "";
  private finished = false;
  private resolveRun!: (code: number) => void;
  private historyPath: string | null;
  private listeners: { target: any; event: string; cb: (...a: any[]) => void }[] = [];
  private plainChain: Promise<void> = Promise.resolve();
  private plainBuf = "";
  private hint = "";

  constructor(deps: AppDeps) {
    this.d = deps;
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? Date.now;
    this.client = deps.client;
    this.interactive = deps.interactive ?? (!!deps.stdin.isTTY && !!deps.stdout.isTTY && this.env.TERM !== "dumb");
    this.color = this.interactive && colorEnabled(this.env, true);
    this.ascii = !this.interactive || this.env.MINDCLAW_ASCII === "1";
    this.folder = new TurnFolder(this.now);
    this.renderer = new TranscriptRenderer({ width: this.cols() - 1, color: this.color, ascii: this.ascii });
    this.historyPath = deps.historyPath === undefined ? null : deps.historyPath;
    if (this.interactive && this.historyPath) this.editor = newEditor(loadHistory(this.historyPath));
  }

  private cols(): number { return Math.max(40, this.d.stdout.columns || (this.interactive ? 80 : 100)); }
  private rows(): number { return Math.max(8, this.d.stdout.rows || 24); }

  // ---------- output ----------
  private commit(lines: string[]): void {
    if (!lines.length) return;
    if (this.interactive) { this.pendingCommit.push(...lines); this.scheduleDraw(); }
    else this.d.stdout.write(lines.join("\n") + "\n");
  }
  private pushRow(row: Row): void { this.commit(this.renderer.push(row)); }

  private scheduleDraw(): void {
    if (!this.interactive || this.finished || this.drawTimer) return;
    this.drawTimer = setTimeout(() => { this.drawTimer = undefined; this.draw(); }, 12);
  }

  private draw(clearOnly = false): void {
    if (!this.interactive) return;
    if (this.drawTimer) { clearTimeout(this.drawTimer); this.drawTimer = undefined; }
    const commit = this.pendingCommit; this.pendingCommit = [];
    const now = this.now();
    const live = clearOnly ? null : composeLive({
      width: this.cols(), color: this.color, ascii: this.ascii,
      pending: this.renderer.pending(),
      running: [...this.folder.running.values()].map((r) => ({ tool: r.tool, args: r.args, elapsedMs: now - r.startedAt })),
      frame: this.frame,
      editor: this.editor,
      maxRows: this.rows() - 1,
      hint: this.hint || (this.running ? "ctrl+c abort" : "enter send  shift+enter newline  /help"),
      status: {
        model: this.info.model, sessionId: this.sessionId, costUsd: this.folder.totalCostUsd, kernel: this.info.kernel,
        connected: this.client.connected(), running: this.running ? { elapsedMs: now - this.turnStartedAt, frame: this.frame } : undefined,
        queued: this.queue.length, awaitingConfirm: !!this.folder.pendingConfirm && !this.running, expand: this.renderer.expand,
      },
    });
    this.d.stdout.write(this.screen.frame(commit, live, this.cols()));
  }

  // ---------- lifecycle ----------
  run(): Promise<number> {
    const done = new Promise<number>((resolve) => { this.resolveRun = resolve; });
    void this.start();
    return done;
  }

  private listen(target: any, event: string, cb: (...a: any[]) => void): void {
    if (!target || typeof target.on !== "function") return;
    target.on(event, cb);
    this.listeners.push({ target, event, cb });
  }

  private async start(): Promise<void> {
    try {
      this.info = await this.client.info();
      this.sessionId = await this.client.open({ title: "Terminal session" });
    } catch (e) {
      this.d.stdout.write(`mindclaw: ${(e as Error).message}\n`);
      return this.finish(1);
    }
    const kernel = this.info.kernel ?? "on";
    this.pushRow({ kind: "info", text: `MINDClaw terminal  ${this.ascii ? "|" : "·"}  ${this.client.mode === "gateway" ? "gateway " + this.client.label : "in-process"}  ${this.ascii ? "|" : "·"}  session ${shortId(this.sessionId)}  ${this.ascii ? "|" : "·"}  kernel ${kernel}\n/help lists commands.${this.interactive ? " Ctrl+C aborts a turn; Ctrl+D quits." : ""}` });
    if (this.interactive) this.startInteractive(); else this.startPlain();
  }

  private startInteractive(): void {
    const { stdin, stdout } = this.d;
    try { stdin.setRawMode?.(true); } catch { /* not a real TTY */ }
    stdin.setEncoding?.("utf8");
    stdin.resume?.();
    stdout.write(PASTE_ON);
    this.listen(stdin, "data", (chunk: string | Uint8Array) => this.onData(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")));
    this.listen(stdin, "end", () => void this.quit());
    this.listen(stdout, "resize", () => { this.renderer.setWidth(this.cols() - 1); this.draw(); });
    this.listen(process, "SIGTERM", () => void this.quit());
    this.listen(process, "exit", () => { try { stdout.write(SHOW_CURSOR + PASTE_OFF); } catch { /* ignore */ } });
    this.draw();
  }

  private startPlain(): void {
    const { stdin } = this.d;
    stdin.setEncoding?.("utf8");
    this.listen(stdin, "data", (chunk: string | Uint8Array) => {
      this.plainBuf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      let nl: number;
      while ((nl = this.plainBuf.indexOf("\n")) !== -1) {
        const line = this.plainBuf.slice(0, nl).replace(/\r$/, "");
        this.plainBuf = this.plainBuf.slice(nl + 1);
        this.plainChain = this.plainChain.then(() => this.handleLine(line));
      }
    });
    this.listen(stdin, "end", () => {
      if (this.plainBuf.trim()) { const line = this.plainBuf; this.plainBuf = ""; this.plainChain = this.plainChain.then(() => this.handleLine(line)); }
      this.plainChain = this.plainChain.then(() => this.quit());
    });
    stdin.resume?.();
  }

  private async finish(code: number): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.spinTimer) clearInterval(this.spinTimer);
    if (this.drawTimer) clearTimeout(this.drawTimer);
    if (this.escTimer) clearTimeout(this.escTimer);
    for (const { target, event, cb } of this.listeners) {
      try { (target.off ?? target.removeListener)?.call(target, event, cb); } catch { /* ignore */ }
    }
    this.listeners = [];
    if (this.interactive) {
      try { this.d.stdin.setRawMode?.(false); } catch { /* ignore */ }
      this.d.stdin.pause?.();
    }
    this.resolveRun(code);
  }

  async quit(code = 0): Promise<void> {
    if (this.finished) return;
    if (this.running) { this.aborted = true; this.abortCtl?.abort(); if (this.sessionId) void this.client.abort(this.sessionId); }
    if (this.interactive) {
      this.pendingCommit.push(...this.renderer.push({ kind: "assistantEnd" }));
      this.draw(true);
      this.d.stdout.write(PASTE_OFF + SHOW_CURSOR);
    }
    if (this.sessionId) {
      await Promise.race([this.client.close(this.sessionId).catch(() => undefined), new Promise((r) => setTimeout(r, 2500).unref?.())]);
    }
    await this.finish(code);
  }

  // ---------- interactive input ----------
  private onData(chunk: string): void {
    if (this.escTimer) { clearTimeout(this.escTimer); this.escTimer = undefined; }
    const { keys, rest } = parseKeys(this.keyRest + chunk);
    this.keyRest = rest;
    if (rest) this.escTimer = setTimeout(() => {
      const r = parseKeys(this.keyRest, { flush: true }); this.keyRest = r.rest;
      for (const k of r.keys) this.onKey(k);
      this.scheduleDraw();
    }, 40);
    for (const k of keys) this.onKey(k);
    this.scheduleDraw();
  }

  onKey(k: import("./input.ts").Key): void {
    if (this.finished) return;
    this.hint = "";
    const { state, action } = applyKey(this.editor, k);
    this.editor = state;
    if (!action) return;
    switch (action.type) {
      case "submit": void this.submit(action.text); break;
      case "interrupt": this.onCtrlC(); break;
      case "eof": void this.quit(); break;
      case "clear-screen": this.clearScreen(); break;
      case "escape": break;
      case "tab": this.onTab(); break;
    }
  }

  private onCtrlC(): void {
    const t = this.now();
    if (t - this.lastCtrlC < CTRL_C_WINDOW_MS && this.lastCtrlC !== 0) { void this.quit(); return; }
    this.lastCtrlC = t;
    if (this.running) {
      this.aborted = true; this.abortCtl?.abort(); void this.client.abort(this.sessionId);
      this.pushRow({ kind: "notice", level: "warn", text: "aborting turn (press Ctrl+C again within 2s to quit)" });
    } else if (!editorIsEmpty(this.editor)) {
      this.editor = newEditor(this.editor.history); this.lastCtrlC = 0;
    } else this.hint = "press ctrl+c again to quit";
    this.scheduleDraw();
  }

  private onTab(): void {
    const text = editorText(this.editor);
    if (!text.startsWith("/") || text.includes("\n") || text.includes(" ")) return;
    const m = completeCommand(text);
    if (m.length === 1) this.editor = setEditorText(this.editor, "/" + m[0] + (m[0] === "resume" || m[0] === "expand" ? " " : ""));
    else if (m.length > 1) this.hint = m.map((x) => "/" + x).join(" ");
  }

  private clearScreen(): void {
    this.d.stdout.write(CLEAR_ALL);
    this.screen = new LiveScreen();
    this.pendingCommit = [];
    this.draw();
  }

  private async submit(text: string): Promise<void> {
    if (this.historyPath) appendHistory(this.historyPath, text);
    await this.handleLine(text);
  }

  // ---------- shared line handling ----------
  async handleLine(line: string): Promise<void> {
    const action = routeInput(line);
    if (action.type === "noop") return;
    if (action.type === "send") {
      if (this.running) {
        this.queue.push(action.text);
        this.pushRow({ kind: "notice", level: "info", text: `queued (${this.queue.length}); sends when the current turn finishes` });
        return;
      }
      await this.runTurn(action.text);
      return;
    }
    await this.runCommand(action);
  }

  private async runTurn(text: string): Promise<void> {
    this.running = true; this.aborted = false;
    this.turnStartedAt = this.now();
    this.folder.startTurn();
    this.folder.pendingConfirm = undefined;
    this.abortCtl = new AbortController();
    if (this.interactive) {
      this.pushRow({ kind: "user", text });
      this.spinTimer = setInterval(() => { this.frame++; this.scheduleDraw(); }, 110);
      this.spinTimer.unref?.();
    }
    try {
      for await (const ev of this.client.send(this.sessionId, text, this.abortCtl.signal) as AsyncIterable<AgentEvent>) {
        for (const row of this.folder.handle(ev)) this.pushRow(row);
        if (this.interactive) this.scheduleDraw();
      }
    } catch (e) {
      if (!this.aborted) this.pushRow({ kind: "error", text: (e as Error).message || String(e) });
    } finally {
      this.pushRow({ kind: "assistantEnd" });
      if (this.aborted) this.pushRow({ kind: "notice", level: "warn", text: "turn aborted" });
      this.running = false; this.folder.running.clear();
      if (this.spinTimer) { clearInterval(this.spinTimer); this.spinTimer = undefined; }
      this.abortCtl = undefined;
      this.scheduleDraw();
    }
    const next = this.queue.shift();
    if (next !== undefined && !this.finished) await this.runTurn(next);
  }

  private async switchSession(opts: { resumeId?: string }): Promise<void> {
    const old = this.sessionId;
    const id = await this.client.open({ title: "Terminal session", resumeId: opts.resumeId });
    this.sessionId = id;
    this.folder = new TurnFolder(this.now);
    if (old && old !== id) void this.client.close(old);
    this.pushRow({ kind: "info", text: `${opts.resumeId ? "resumed" : "new"} session ${id}` });
  }

  private async runCommand(a: Action): Promise<void> {
    try {
      switch (a.type) {
        case "error": this.pushRow({ kind: "error", text: a.message }); break;
        case "help": {
          const w = Math.max(...COMMANDS.map((c) => c.usage.length));
          const lines = COMMANDS.map((c) => `${c.usage.padEnd(w)}  ${c.help}`);
          lines.push("", "Keys: Enter send  Shift/Alt+Enter newline (or end a line with \\)  Up/Down history  Ctrl+A/E line start/end",
            "      Ctrl+U/K kill to start/end  Ctrl+W kill word  Ctrl+Y yank  Ctrl+L clear  Ctrl+C abort turn (twice: quit)  Ctrl+D quit",
            "Start a message with // to send a literal leading slash.");
          this.pushRow({ kind: "info", text: lines.join("\n") });
          break;
        }
        case "sessions": {
          const list = await this.client.list();
          if (!list.length) { this.pushRow({ kind: "info", text: "No sessions." }); break; }
          const text = list.map((s) => `${s.id === this.sessionId ? "*" : " "} ${s.id}  ${s.surface.padEnd(8)} ${ago(this.now() - s.updatedAt).padStart(8)}  ${s.title}`).join("\n");
          this.pushRow({ kind: "info", text });
          break;
        }
        case "new": await this.switchSession({}); break;
        case "resume": {
          const list = await this.client.list();
          const hits = list.filter((s) => s.id === a.id || s.id.startsWith(a.id));
          const exact = hits.find((s) => s.id === a.id);
          const pick = exact ?? (hits.length === 1 ? hits[0] : undefined);
          if (!pick) { this.pushRow({ kind: "error", text: hits.length > 1 ? `ambiguous id ${a.id}: ${hits.map((h) => shortId(h.id)).join(", ")}` : `no session matching ${a.id} (try /sessions)` }); break; }
          if (pick.id === this.sessionId) { this.pushRow({ kind: "info", text: "already in that session" }); break; }
          await this.switchSession({ resumeId: pick.id });
          break;
        }
        case "model": {
          this.info = { ...this.info, ...(await this.client.info()) };
          this.pushRow({ kind: "info", text: `model: ${this.info.model ?? "(runtime default; the gateway does not report it)"}\nThe model is chosen by the runtime config (MINDCLAW_MODEL / ~/.mindclaw/config.json); change it there and restart.` });
          break;
        }
        case "shadow": {
          this.info = { ...this.info, ...(await this.client.info()) };
          const vs = await this.client.violations(this.sessionId);
          const shadow = vs.filter((v) => !v.enforced).length;
          this.pushRow({ kind: "info", text: `kernel: ${this.info.kernel ?? "on"}  (on = gates block, shadow = gates log only, off = no gates)\nthis session: ${vs.length - shadow} enforced, ${shadow} shadow-logged violation(s)\nMode is set at start by MINDCLAW_SHADOW=1 / MINDCLAW_KERNEL=0; /violations lists them.` });
          break;
        }
        case "violations": this.pushRow({ kind: "info", text: formatViolations(await this.client.violations(this.sessionId)) }); break;
        case "cost": {
          const f = this.folder;
          this.pushRow({ kind: "info", text: `cost this session: ${formatCost(f.totalCostUsd)}  (${f.promptTokens} prompt + ${f.completionTokens} completion tokens)` });
          break;
        }
        case "expand": {
          const arg = a.arg.trim().toLowerCase();
          if (arg === "" || arg === "on" || arg === "off") {
            const v = arg === "" ? !this.renderer.expand : arg === "on";
            this.renderer.setExpand(v);
            this.pushRow({ kind: "info", text: `tool output ${v ? "expanded" : "collapsed"} for new tool rows` });
          } else {
            const log = this.folder.toolLog;
            const picks = arg === "all" ? log : arg === "last" ? log.slice(-1) : log.filter((t) => t.receiptId === arg);
            if (!picks.length) { this.pushRow({ kind: "error", text: arg === "last" || arg === "all" ? "no tool calls yet" : `no tool call ${arg} (ids look like c1, c2)` }); break; }
            const full = new TranscriptRenderer({ width: this.cols() - 1, color: this.color, ascii: this.ascii, expand: true });
            for (const t of picks) this.commit(full.push({ kind: "tool", ...t }));
          }
          break;
        }
        case "clear":
          if (this.interactive) this.clearScreen(); else this.pushRow({ kind: "info", text: "(clear: nothing to do in plain mode)" });
          break;
        case "quit": await this.quit(); break;
        case "send": case "noop": break;
      }
    } catch (e) {
      this.pushRow({ kind: "error", text: (e as Error).message });
    }
  }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
