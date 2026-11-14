import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Tool, ToolClass } from "../types.ts";
import { cap, fail, ok } from "./util.ts";
import { shellCommand, shellEnv } from "./bash.ts";

// Interactive shell sessions for the owner's own machine (desktop / CLI only: hostedToolAllowed never lets `terminal` through).
// Default backend is pipes: a hidden shell child of the gateway, no window. When the desktop app attaches, the backend is a real
// PTY hosted in Electron's main process (node-pty never loads in this process). The model still reads ANSI-stripped text.
// Isolation: a session belongs to the chat that opened it (ctx.sessionId); no other chat can see, read, type into or close it.
const BUF_CAP = 256 * 1024;       // per-session output kept; older bytes are dropped (and counted)
const READ_CAP = 30_000;          // chars returned by one read
const MAX_PER_OWNER = 8;
const MAX_TOTAL = 16;
const IDLE_MS = 30 * 60_000;
const DEFAULT_WAIT_MS = 1500;
const MAX_WAIT_MS = 60_000;
const SETTLE_MS = 300;            // output counts as settled after this much silence
const MAX_TEXT = 20_000;

export type TermStatus = "running" | "exited" | "closed";
export interface TermInfo { id: string; shell: string; cwd: string; pid: number | undefined; status: TermStatus; exitCode: number | null; startedAt: number; lastActiveAt: number; backend: "pipe" | "pty"; typeable: boolean }
export interface UserActivity { at: number; bytes: number }
type SpawnFn = (file: string, args: string[], opts: SpawnOptions) => ChildProcess;
export interface TerminalOpts { spawn?: SpawnFn; platform?: string; now?: () => number; env?: () => NodeJS.ProcessEnv; idleMs?: number; reapEveryMs?: number | false; backend?: TermBackend }

interface Session extends TermInfo { owner: string; handle: TermHandle; buf: string; dropped: number; total: number; readPos: number; screen: string; screenTotal: number; screenDropped: number; lastDataAt: number; listeners: Set<() => void>; activity: UserActivity[]; cols: number; rows: number }

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r(?!\n)/g, "\n");

// A colour sequence often arrives split across two reads (`\x1b[31` then `m`). Holding a short unfinished tail
// keeps the escape out of the scrollback; a longer tail is flushed so a stray ESC cannot stall output forever.
const ANSI_HOLD_MAX = 64;

function partialAnsi(tail: string): boolean {
  if (tail === "\x1b") return true;
  if (/^\x1b\[[0-9;?]*[ -/]*$/.test(tail)) return true; // CSI with no final byte yet
  if (/^\x1b[()]$/.test(tail)) return true; // charset designator missing its one byte
  if (tail.startsWith("\x1b]") && !tail.includes("\x07") && !tail.endsWith("\x1b\\")) return true; // OSC not yet BEL or ST
  return false;
}

/** Split a raw chunk into text that is safe to strip now, and a short unfinished escape to keep for the next chunk. */
export function splitAnsiHold(s: string): { done: string; held: string } {
  const esc = s.lastIndexOf("\x1b");
  if (esc < 0) return { done: s, held: "" };
  const tail = s.slice(esc);
  if (tail.length > ANSI_HOLD_MAX || !partialAnsi(tail)) return { done: s, held: "" };
  return { done: s.slice(0, esc), held: tail };
}

export type ShellName = "bash" | "pwsh" | "powershell" | "cmd";
/** The shell to run for a name. Default: bash everywhere but a Windows machine without bash (then Windows PowerShell). */
export function shellSpec(shell: string | undefined, platform: string = process.platform, mode?: { pty?: boolean }): { name: ShellName; file: string; args: string[]; eol: string } | { error: string } {
  const win = platform === "win32";
  const pty = mode?.pty === true;
  let name = shell;
  if (!name) name = win ? (shellCommand("exit 0", platform).label === "bash" ? "bash" : "powershell") : "bash";
  switch (name) {
    // A PTY bash is interactive (-i) so it owns the tty. Pipes stay non-interactive: the existing args are what tests pin.
    case "bash": return { name, file: "bash", args: pty ? ["--noprofile", "--norc", "-i"] : ["--noprofile", "--norc"], eol: "\n" };
    case "pwsh": return { name, file: "pwsh", args: pty ? ["-NoLogo", "-NoProfile"] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], eol: "\n" };
    case "powershell":
      return win
        ? { name, file: "powershell.exe", args: pty ? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], eol: "\r\n" }
        : { error: "terminal: shell powershell exists on Windows only; use bash or pwsh here" };
    case "cmd":
      return win ? { name, file: "cmd.exe", args: ["/Q", "/D"], eol: "\r\n" } : { error: "terminal: shell cmd exists on Windows only; use bash or pwsh here" };
    default: return { error: `terminal: unknown shell ${JSON.stringify(name)}; use bash, pwsh${win ? ", powershell or cmd" : ""}` };
  }
}

const WRAPPERS = new Set(["sudo", "command", "time", "nice", "nohup", "exec"]);
const DEPLOYERS = new Set(["npm", "npx", "yarn", "pnpm", "bun", "fly", "flyctl", "vercel", "heroku"]);

function shellWords(seg: string): string[] {
  const out: string[] = [];
  for (const m of seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out.filter((w) => w !== "");
}

function hasShort(args: string[], letter: string): boolean {
  for (const a of args) {
    if (a.startsWith("-") && !a.startsWith("--") && a.slice(1).includes(letter)) return true;
  }
  return false;
}

function hasLong(args: string[], name: string): boolean {
  return args.some((a) => a === name || a.startsWith(name + "="));
}

/**
 * Destructive shell text the danger gate must ask about: rm with both recursive and force,
 * a forced git push, a deploy command, or terraform destroy. A plain `rm file` or `git push` is not.
 */
export function isIrreversibleShell(text: string): boolean {
  const parts = text.split(/&&|\|\||[;\n|]/);
  for (const seg of parts) {
    const words = shellWords(seg);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    while (i < words.length && WRAPPERS.has(words[i]!.replace(/^.*\//, ""))) i++;
    const cmd = (words[i] ?? "").replace(/^.*\//, "");
    const args = words.slice(i + 1);
    if (!cmd) continue;
    if (cmd === "rm") {
      const recursive = hasShort(args, "r") || hasShort(args, "R") || hasLong(args, "--recursive");
      const force = hasShort(args, "f") || hasLong(args, "--force");
      if (recursive && force) return true;
    } else if (cmd === "git" && args[0] === "push") {
      const rest = args.slice(1);
      if (hasShort(rest, "f") || hasLong(rest, "--force") || hasLong(rest, "--force-with-lease")) return true;
    } else if (cmd === "terraform" && args[0] === "destroy") {
      return true;
    } else if (cmd === "deploy" || (DEPLOYERS.has(cmd) && args.includes("deploy"))) {
      return true;
    }
  }
  return false;
}

/** A live shell the registry owns. Pipe and PTY backends both speak this. Tests inject a fake. */
export interface TermHandle {
  pid: number | undefined;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onStdout(fn: (chunk: string) => void): void;
  onStderr(fn: (chunk: string) => void): void;
  onError(fn: (message: string) => void): void;
  onExit(fn: (code: number | null) => void): void;
  interrupt(): { sent: boolean; note: string };
  kill(sync: boolean): void;
}

export interface TermSpawnSpec {
  id: string;
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  name: ShellName;
  eol: string;
  platform: string;
}

export interface TermBackend {
  kind: "pipe" | "pty";
  typeable: boolean;
  /** Synchronous spawn. The pipe backend and unit-test fakes use this. */
  spawn?(spec: TermSpawnSpec): TermHandle;
  /** The desktop PTY host is reached over HTTP, so opening it waits. */
  openAsync?(spec: TermSpawnSpec): Promise<TermHandle>;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function createPipeBackend(spawnFn: SpawnFn, platform: string): TermBackend {
  return {
    kind: "pipe",
    typeable: false,
    spawn(spec) {
      const child = spawnFn(spec.file, spec.args, { cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"], detached: platform !== "win32", windowsHide: true, env: spec.env });
      child.stdin?.on("error", () => { /* shell already gone: the close handler records it */ });
      return {
        pid: child.pid,
        write(data) { child.stdin?.write(data); },
        resize() { /* a pipe has no tty size */ },
        onStdout(fn) { child.stdout?.on("data", (d: Buffer | string) => fn(d.toString())); },
        onStderr(fn) { child.stderr?.on("data", (d: Buffer | string) => fn(d.toString())); },
        onError(fn) { child.on("error", (err: Error) => fn(err.message)); },
        onExit(fn) { child.on("close", (code: number | null) => fn(code)); },
        interrupt() {
          const pid = child.pid;
          if (!pid) return { sent: false, note: "no pid" };
          if (platform === "win32") {
            const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$k=0; Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Number(pid)}' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $k++ }; exit ($(if($k){0}else{1}))`], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
            return r.status === 0 ? { sent: true, note: "stopped the shell's running program" } : { sent: false, note: "nothing is running in the shell" };
          }
          const r = spawnSync("pkill", ["-INT", "-P", String(pid)], { stdio: "ignore", timeout: 5000 });
          return r.status === 0 ? { sent: true, note: "sent Ctrl-C (SIGINT) to what the shell is running" } : { sent: false, note: "nothing is running in the shell" };
        },
        kill(sync) {
          const pid = child.pid;
          try { child.stdin?.end(); } catch { /* gone */ }
          if (platform === "win32") {
            try {
              if (!pid) child.kill();
              else if (sync) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
              else nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => { /* taskkill missing: the shell is already gone */ });
            } catch { try { child.kill(); } catch { /* gone */ } }
          } else {
            try { if (pid) process.kill(-pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
          }
        },
      };
    },
  };
}

export class TerminalRegistry {
  private sessions = new Map<string, Session>();
  private seq = 0;
  private platform: string;
  private now: () => number;
  private envFn: () => NodeJS.ProcessEnv;
  private idleMs: number;
  private timer: NodeJS.Timeout | undefined;
  private backend: TermBackend;
  constructor(o: TerminalOpts = {}) {
    this.platform = o.platform ?? process.platform;
    this.now = o.now ?? Date.now;
    this.envFn = o.env ?? (() => shellEnv(process.env, this.platform));
    this.idleMs = o.idleMs ?? IDLE_MS;
    const spawnFn = o.spawn ?? ((f, a, op) => nodeSpawn(f, a, op));
    this.backend = o.backend ?? createPipeBackend(spawnFn, this.platform);
    if (o.reapEveryMs !== false) {
      this.timer = setInterval(() => this.reap(), o.reapEveryMs ?? 60_000);
      this.timer.unref();
    }
  }

  /** Swap the backend used for sessions opened after this call. Already-open sessions keep the handle they started with. */
  setBackend(backend: TermBackend): void { this.backend = backend; }
  backendKind(): "pipe" | "pty" { return this.backend.kind; }
  typeable(): boolean { return this.backend.typeable; }

  open(owner: string, cwd: string, shell?: string): TermInfo {
    const prep = this.prepare(owner, cwd, shell);
    if (!this.backend.spawn) throw new Error("terminal: this PTY opens through the desktop host");
    return this.finish(prep, this.spawnOrThrow(prep, this.backend.spawn(prep.spec)));
  }

  /** Same as open, but waits when the backend is the desktop PTY host. */
  async openSession(owner: string, cwd: string, shell?: string): Promise<TermInfo> {
    const prep = this.prepare(owner, cwd, shell);
    const handle = this.backend.kind === "pty" && this.backend.openAsync
      ? await this.backend.openAsync(prep.spec)
      : this.backend.spawn?.(prep.spec);
    if (!handle) throw new Error("terminal: this PTY opens through the desktop host");
    return this.finish(prep, this.spawnOrThrow(prep, handle));
  }

  private prepare(owner: string, cwd: string, shell?: string): { owner: string; cwd: string; sp: { name: ShellName; eol: string }; spec: TermSpawnSpec } {
    this.reap();
    const mine = [...this.sessions.values()].filter((s) => s.owner === owner && s.status === "running").length;
    if (mine >= MAX_PER_OWNER) throw new Error(`terminal: ${MAX_PER_OWNER} sessions already open in this chat; close one first`);
    if ([...this.sessions.values()].filter((s) => s.status === "running").length >= MAX_TOTAL) throw new Error(`terminal: ${MAX_TOTAL} sessions already open on this machine; close one first`);
    const pty = this.backend.kind === "pty";
    const sp = shellSpec(shell, this.platform, { pty });
    if ("error" in sp) throw new Error(sp.error);
    const env = { ...this.envFn() };
    if (pty) env.TERM = env.TERM || "xterm-256color";
    const id = `t${++this.seq}`;
    return { owner, cwd, sp, spec: { id, file: sp.file, args: sp.args, cwd, env, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, name: sp.name, eol: sp.eol, platform: this.platform } };
  }

  private spawnOrThrow(prep: { sp: { name: string } }, handle: TermHandle): TermHandle {
    if (handle.pid === undefined) {
      try { handle.kill(true); } catch { /* the spawn already failed */ }
      throw new Error(`terminal: could not start ${prep.sp.name} (is it installed?)`);
    }
    return handle;
  }

  private finish(prep: { owner: string; cwd: string; sp: { name: ShellName }; spec: TermSpawnSpec }, handle: TermHandle): TermInfo {
    const t = this.now();
    const typeable = this.backend.typeable;
    const s: Session = {
      id: prep.spec.id, owner: prep.owner, shell: prep.sp.name, cwd: prep.cwd, pid: handle.pid, status: "running", exitCode: null,
      startedAt: t, lastActiveAt: t, backend: this.backend.kind, typeable, handle, buf: "", dropped: 0, total: 0, readPos: 0,
      screen: "", screenTotal: 0, screenDropped: 0, lastDataAt: t, listeners: new Set(), activity: [], cols: prep.spec.cols, rows: prep.spec.rows,
    };
    this.sessions.set(s.id, s);
    let holdOut = "";
    let holdErr = "";
    const commit = (raw: string): void => {
      const text = stripAnsi(raw);
      if (!text) return;
      s.buf += text;
      s.total += text.length;
      if (s.buf.length > BUF_CAP) { const cut = s.buf.length - BUF_CAP; s.buf = s.buf.slice(cut); s.dropped += cut; }
      s.lastDataAt = Date.now();
      this.wake(s);
    };
    const commitScreen = (chunk: string): void => {
      if (!typeable || !chunk) return;
      s.screen += chunk;
      s.screenTotal += chunk.length;
      if (s.screen.length > BUF_CAP) { const cut = s.screen.length - BUF_CAP; s.screen = s.screen.slice(cut); s.screenDropped += cut; }
      s.lastDataAt = Date.now();
      this.wake(s);
    };
    // stdout and stderr each keep their own unfinished escape, so a split colour code is not glued to the other stream.
    const push = (which: "out" | "err", chunk: string, final: boolean): void => {
      const prev = which === "out" ? holdOut : holdErr;
      const merged = prev + chunk;
      const split = final ? { done: merged, held: "" } : splitAnsiHold(merged);
      if (which === "out") holdOut = split.held; else holdErr = split.held;
      if (split.done) commit(split.done);
    };
    const flushHold = (): void => { push("out", "", true); push("err", "", true); };
    handle.onStdout((chunk) => { commitScreen(chunk); push("out", chunk, false); });
    handle.onStderr((chunk) => { commitScreen(chunk); push("err", chunk, false); });
    handle.onError((message) => { flushHold(); commit(`[spawn error: ${message}]\n`); if (s.status === "running") s.status = "exited"; this.wake(s); });
    handle.onExit((code) => { flushHold(); if (s.status === "running") s.status = "exited"; s.exitCode = code; this.wake(s); });
    return this.info(s);
  }

  private info(s: Session): TermInfo {
    return { id: s.id, shell: s.shell, cwd: s.cwd, pid: s.pid, status: s.status, exitCode: s.exitCode, startedAt: s.startedAt, lastActiveAt: s.lastActiveAt, backend: s.backend, typeable: s.typeable };
  }
  private wake(s: Session): void {
    // Copy first: a listener may unsubscribe itself. A throw stays inside that listener so the agent's read still wakes.
    for (const l of [...s.listeners]) { try { l(); } catch { /* the pane must not stall the shell */ } }
  }
  private mine(owner: string, id: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner) throw new Error(`terminal: unknown session ${id || "(none)"}; open one first`);
    return s;
  }

  list(owner: string): TermInfo[] { this.reap(); return [...this.sessions.values()].filter((s) => s.owner === owner).map((s) => this.info(s)); }
  status(owner: string, id: string): TermInfo { return this.info(this.mine(owner, id)); }

  /**
   * Buffered output for a pane. `fromTotal` is an absolute offset into everything this session has ever printed
   * (default: the whole retained buffer). Does not move `readPos`, so the agent's next `read` still receives the text.
   * `text` is at most READ_CAP characters (the newest part). `dropped` counts characters between `fromTotal` and `text`
   * that the ring already discarded or this reply skipped to stay under the cap. `total` is the absolute end.
   * A wrong owner is an unknown session, same as every other call.
   */
  peek(owner: string, id: string, fromTotal?: number): { info: TermInfo; text: string; total: number; dropped: number; screen?: string; screenTotal?: number; screenDropped?: number } {
    const s = this.mine(owner, id);
    const from = fromTotal === undefined || !Number.isFinite(fromTotal) ? 0 : Math.max(0, Math.floor(fromTotal));
    const start = s.total - s.buf.length; // absolute offset of buf[0]
    const lo = Math.max(from, start);
    let text = lo >= s.total ? "" : s.buf.slice(lo - start);
    let dropped = lo - from;
    if (text.length > READ_CAP) {
      const cut = text.length - READ_CAP;
      text = text.slice(cut); // the pane shows the newest output, and the next peek(from=total) continues live
      dropped += cut;
    }
    // A PTY pane needs the raw bytes (colour and cursor motion). A pipe pane keeps using the stripped text.
    if (!s.typeable) return { info: this.info(s), text, total: s.total, dropped };
    return { info: this.info(s), text, total: s.total, dropped, screen: s.screen, screenTotal: s.screenTotal, screenDropped: s.screenDropped };
  }

  /**
   * Calls `fn` when the shell prints something or its status changes (exit, close, spawn error). Same wake set the
   * agent's `read` waits on. The returned function detaches. A wrong owner throws unknown, and does not subscribe.
   */
  subscribe(owner: string, id: string, fn: () => void): () => void {
    const s = this.mine(owner, id);
    s.listeners.add(fn);
    let on = true;
    return () => { if (!on) return; on = false; s.listeners.delete(fn); };
  }

  /** Write text to the shell's stdin. `enter` (default true) appends the shell's line ending. */
  send(owner: string, id: string, text: string, enter = true): TermInfo {
    const s = this.mine(owner, id);
    if (s.status !== "running") throw new Error(`terminal: session ${id} has ${s.status}${s.exitCode !== null ? ` (exit ${s.exitCode})` : ""}; open a new one`);
    const eol = s.shell === "cmd" || s.shell === "powershell" ? "\r\n" : "\n";
    const body = enter ? (text.endsWith("\n") ? text : text + eol) : text;
    s.handle.write(body);
    s.lastActiveAt = this.now();
    return this.info(s);
  }

  /**
   * Keystrokes from the person at the pane. Not an agent send: no permission check here.
   * The text is not stored. The activity log keeps only when and how many bytes.
   */
  input(owner: string, id: string, data: string): { bytes: number } {
    const s = this.mine(owner, id);
    if (!s.typeable) throw new Error("terminal: this session is a pipe, not a PTY, so the pane cannot send keystrokes");
    if (s.status !== "running") throw new Error(`terminal: session ${id} has ${s.status}; open a new one`);
    if (typeof data !== "string" || data.length === 0) return { bytes: 0 };
    if (data.length > 8000) throw new Error("terminal: input is too long");
    s.handle.write(data);
    this.noteUser(s, data.length);
    return { bytes: data.length };
  }

  /** Pane resize. A pipe has no tty, so this refuses. */
  resize(owner: string, id: string, cols: number, rows: number): TermInfo {
    const s = this.mine(owner, id);
    if (!s.typeable) throw new Error("terminal: this session is a pipe, not a PTY, so it cannot be resized");
    if (!Number.isInteger(cols) || cols < 2 || cols > 500) throw new Error("terminal: cols out of range");
    if (!Number.isInteger(rows) || rows < 1 || rows > 200) throw new Error("terminal: rows out of range");
    s.cols = cols;
    s.rows = rows;
    s.handle.resize(cols, rows);
    s.lastActiveAt = this.now();
    return this.info(s);
  }

  /** Byte counts of pane keystrokes. The characters themselves are not kept. A look (peek) is not activity. */
  userActivity(owner: string, id: string): UserActivity[] {
    return this.mine(owner, id).activity.map((a) => ({ at: a.at, bytes: a.bytes }));
  }

  private noteUser(s: Session, bytes: number): void {
    s.lastActiveAt = this.now();
    s.activity.push({ at: s.lastActiveAt, bytes });
    if (s.activity.length > 32) s.activity.splice(0, s.activity.length - 32);
  }

  /**
   * New output since the last read. Waits (up to waitMs) for: `until` to match the new output; or, without it, for output to
   * arrive and then go quiet (SETTLE_MS); or the shell to exit; or the turn to be aborted.
   */
  async read(owner: string, id: string, o: { waitMs?: number; until?: RegExp; signal?: AbortSignal } = {}): Promise<{ info: TermInfo; text: string; dropped: number; matched: boolean }> {
    const s = this.mine(owner, id);
    s.lastActiveAt = this.now();
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(o.waitMs ?? 0)));
    const start = Date.now();
    const startTotal = s.total;
    const fresh = () => s.buf.slice(Math.max(0, s.buf.length - (s.total - s.readPos)));
    let matched = false;
    if (waitMs > 0) {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const done = () => { if (timer) clearTimeout(timer); s.listeners.delete(check); o.signal?.removeEventListener("abort", done); resolve(); };
        const check = () => {
          if (o.until) { if (o.until.test(fresh())) { matched = true; return done(); } }
          if (s.status !== "running") return done();
          const left = waitMs - (Date.now() - start);
          if (left <= 0) return done();
          if (timer) clearTimeout(timer);
          // no `until`: once something new has arrived, finish after SETTLE_MS of silence; else wait out the budget.
          if (!o.until && s.total > startTotal) {
            const quiet = SETTLE_MS - (Date.now() - s.lastDataAt);
            if (quiet <= 0) return done();
            timer = setTimeout(check, Math.min(left, quiet));
          } else timer = setTimeout(check, left);
        };
        s.listeners.add(check);
        if (o.signal?.aborted) return done();
        o.signal?.addEventListener("abort", done, { once: true });
        check();
      });
    }
    const text = fresh();
    const lost = Math.max(0, s.total - s.readPos - text.length);
    s.readPos = s.total;
    s.lastActiveAt = this.now();
    return { info: this.info(s), text, dropped: lost, matched };
  }

  /** Ctrl-C: interrupts what the shell is running (its children), never the shell itself. POSIX: SIGINT to the shell's children. */
  interrupt(owner: string, id: string): { sent: boolean; note: string } {
    const s = this.mine(owner, id);
    if (s.status !== "running") throw new Error(`terminal: session ${id} has ${s.status}`);
    s.lastActiveAt = this.now();
    return s.handle.interrupt();
  }

  close(owner: string, id: string): TermInfo {
    const s = this.mine(owner, id);
    this.kill(s, false);
    this.sessions.delete(s.id);
    return this.info(s);
  }

  /** Closes sessions idle longer than idleMs (30 min by default). Returns the ids reaped. */
  reap(): string[] {
    const out: string[] = [];
    const t = this.now();
    for (const s of [...this.sessions.values()]) {
      const gone = s.status !== "running" && t - s.lastActiveAt > 5 * 60_000; // exited records linger 5 min so a late read still sees the exit
      if (gone || (s.status === "running" && t - s.lastActiveAt > this.idleMs)) { this.kill(s, false); this.sessions.delete(s.id); out.push(s.id); }
    }
    return out;
  }

  killAll(): void { for (const s of this.sessions.values()) this.kill(s, true); this.sessions.clear(); if (this.timer) clearInterval(this.timer); }

  private kill(s: Session, sync: boolean): void {
    const becameClosed = s.status === "running";
    if (becameClosed) s.status = "closed";
    try { s.handle.kill(sync); } catch { /* already gone */ }
    if (becameClosed) this.wake(s); // the pane learns the session closed; the session is still in the map until the caller deletes it
  }
}

let shared: TerminalRegistry | undefined;
let exitHooked = false;
function defaultRegistry(): TerminalRegistry {
  if (!shared) shared = new TerminalRegistry();
  if (!exitHooked) { exitHooked = true; process.on("exit", () => shared?.killAll()); } // sessions never outlive the gateway
  return shared;
}

/** The process-wide registry. The `terminal` tool and the local gateway pane both use this, so a peek sees the shell the agent opened. */
export function terminalRegistry(): TerminalRegistry {
  return defaultRegistry();
}

const fmt = (i: TermInfo): string => `${i.id} ${i.shell} pid=${i.pid ?? "?"} ${i.status}${i.status !== "running" ? ` exit=${i.exitCode ?? "?"}` : ""} cwd=${JSON.stringify(i.cwd)}`;

export function createTerminalTool(registry?: TerminalRegistry): Tool {
  const reg = () => registry ?? terminalRegistry();
  return {
    class: "write",
    // read/list only show what the shell already printed. A destructive send is irreversible and needs the user's go.
    classFor: (a): ToolClass => {
      if (a.action === "read" || a.action === "list") return "read";
      if (a.action === "send" && typeof a.text === "string" && isIrreversibleShell(a.text)) return "irreversible";
      return "write";
    },
    receipt: "surface",
    spec: {
      name: "terminal",
      description: "An interactive shell session on this machine that you type into and read back. On the desktop app this is a real PTY: the user can type in the pane, and full-screen programs (vim, top, less) work. On a gateway-only install it is pipes with no window, and those full-screen programs do not work; use python3 -iu for a Python REPL and ssh -tt for a remote tty. Use it when a job needs a back-and-forth: answering a y/n or password-style prompt, an ssh session, a Python or node REPL, a dev server whose output you tail, a shell where cd and exported variables must persist. " +
        "Actions: open {shell?, cwd?} returns a session id; send {session, text, enter?, wait_ms?, until?} types text (enter defaults to true) and, with wait_ms, returns the new output; read {session, wait_ms?, until?} returns only the output since the last read; signal {session} sends Ctrl-C to what is running; close {session}; list. " +
        `read waits up to wait_ms (max ${MAX_WAIT_MS / 1000}s) for output to arrive and settle, or for the regex in until to match. Every command you send goes through the same permission rules as bash. Destructive commands (rm -rf, a forced git push, deploy, terraform destroy) need the user's explicit go. ` +
        "Sessions belong to this chat, are closed after 30 minutes idle and when Daebot quits. Output you read is ANSI-stripped. " +
        "One-shot commands go to bash; a long background job you only poll goes to process; terminal is for interactive sessions.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["open", "send", "read", "signal", "close", "list"] },
          shell: { type: "string", enum: ["bash", "pwsh", "powershell", "cmd"], description: "open: default bash (PowerShell on Windows without bash). powershell and cmd are Windows only." },
          cwd: { type: "string", description: "open: working directory (default: the chat's)" },
          session: { type: "string", description: "send/read/signal/close: the id open returned" },
          text: { type: "string", description: "send: what to type" },
          enter: { type: "boolean", description: "send: press Enter after the text (default true). false for a single keystroke answer such as y at a raw prompt." },
          wait_ms: { type: "number", description: `send/read: wait up to this long for output to settle (default ${DEFAULT_WAIT_MS} on read, none on send, max ${MAX_WAIT_MS})` },
          until: { type: "string", description: "send/read: a regular expression; return as soon as the new output matches it (or wait_ms passes)" },
        },
        required: ["action"],
      },
    },
    async run(args, ctx) {
      const action = args.action;
      const owner = ctx.sessionId || "";
      const id = typeof args.session === "string" ? args.session : typeof args.id === "string" ? args.id : "";
      try {
        if (action === "open") {
          const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : ctx.cwd;
          const info = await reg().openSession(owner, cwd, typeof args.shell === "string" ? args.shell : undefined);
          return ok(`opened ${fmt(info)}`, { session: info.id, pid: info.pid, shell: info.shell });
        }
        if (!["list", "send", "read", "signal", "close"].includes(String(action))) return fail("terminal: action must be open, send, read, signal, close or list");
        if (action === "list") {
          const all = reg().list(owner);
          return ok(all.length ? all.map(fmt).join("\n") : "no terminal sessions");
        }
        if (!id) return fail(`terminal: session is required for ${String(action)}`);
        let until: RegExp | undefined;
        if (typeof args.until === "string" && args.until !== "") {
          if (args.until.length > 300) return fail("terminal: until is too long (max 300 chars)");
          try { until = new RegExp(args.until); } catch { return fail(`terminal: until is not a valid regular expression: ${args.until.slice(0, 80)}`); }
        }
        const finishRead = async (waitMs: number | undefined) => {
          const r = await reg().read(owner, id, { waitMs, until, signal: ctx.signal });
          const note = r.dropped > 0 ? `[${r.dropped} earlier chars dropped]\n` : "";
          const state = r.info.status !== "running" ? `[session ${r.info.status}, exit ${r.info.exitCode ?? "?"}]\n` : "";
          const body = r.text === "" ? "[no new output]" : cap(r.text, READ_CAP);
          return ok(`${state}${note}${body}`, { status: r.info.status, exitCode: r.info.exitCode, matched: r.matched });
        };
        if (action === "send") {
          if (typeof args.text !== "string") return fail("terminal: text is required for send");
          if (args.text.length > MAX_TEXT) return fail(`terminal: text is too long (max ${MAX_TEXT} chars)`);
          reg().send(owner, id, args.text, args.enter !== false);
          const w = Number(args.wait_ms);
          return Number.isFinite(w) && w > 0 || until ? await finishRead(Number.isFinite(w) && w > 0 ? w : DEFAULT_WAIT_MS) : ok("sent. Call read to see the output.");
        }
        if (action === "read") {
          const w = Number(args.wait_ms);
          return await finishRead(Number.isFinite(w) && w >= 0 && args.wait_ms !== undefined ? w : DEFAULT_WAIT_MS);
        }
        if (action === "signal") {
          const r = reg().interrupt(owner, id);
          return r.sent ? ok(r.note) : fail(`terminal: ${r.note}`);
        }
        if (action === "close") return ok(`closed ${fmt(reg().close(owner, id))}`);
        return fail("terminal: action must be open, send, read, signal, close or list");
      } catch (e) {
        return fail(String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300));
      }
    },
  };
}

export const terminalTool: Tool = createTerminalTool();
