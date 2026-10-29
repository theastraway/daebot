import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Tool, ToolClass } from "../types.ts";
import { cap, fail, ok } from "./util.ts";
import { shellCommand, shellEnv } from "./bash.ts";

// Interactive shell sessions for the owner's own machine (desktop / CLI only: hostedToolAllowed never lets `terminal` through).
// A session is a long-lived hidden shell child of the gateway. It has NO window and never touches the screen: Daebot types into it
// with `send` and reads what came back with `read`. Pipes, not a PTY (a PTY needs a native module per Electron ABI and the 4-platform
// release has none), so full-screen programs (vim, top, less, htop) do not work; line-oriented programs do: prompts that print their
// own text, Python / node REPLs (python3 -iu), ssh with keys (ssh -tt host for a remote tty), dev servers, installers that ask y/n.
// Isolation: a session belongs to the chat session that opened it (ctx.sessionId); no other session can see, read, type into or close it.
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
export interface TermInfo { id: string; shell: string; cwd: string; pid: number | undefined; status: TermStatus; exitCode: number | null; startedAt: number; lastActiveAt: number }
type SpawnFn = (file: string, args: string[], opts: SpawnOptions) => ChildProcess;
export interface TerminalOpts { spawn?: SpawnFn; platform?: string; now?: () => number; env?: () => NodeJS.ProcessEnv; idleMs?: number; reapEveryMs?: number | false }

interface Session extends TermInfo { owner: string; child: ChildProcess; buf: string; dropped: number; total: number; readPos: number; lastDataAt: number; listeners: Set<() => void> }

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r(?!\n)/g, "\n");

export type ShellName = "bash" | "pwsh" | "powershell" | "cmd";
/** The shell to run for a name. Default: bash everywhere but a Windows machine without bash (then Windows PowerShell). */
export function shellSpec(shell: string | undefined, platform: string = process.platform): { name: ShellName; file: string; args: string[]; eol: string } | { error: string } {
  const win = platform === "win32";
  let name = shell;
  if (!name) name = win ? (shellCommand("exit 0", platform).label === "bash" ? "bash" : "powershell") : "bash";
  switch (name) {
    case "bash": return { name, file: "bash", args: ["--noprofile", "--norc"], eol: "\n" };
    case "pwsh": return { name, file: "pwsh", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], eol: "\n" };
    case "powershell":
      return win ? { name, file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], eol: "\r\n" } : { error: "terminal: shell powershell exists on Windows only; use bash or pwsh here" };
    case "cmd":
      return win ? { name, file: "cmd.exe", args: ["/Q", "/D"], eol: "\r\n" } : { error: "terminal: shell cmd exists on Windows only; use bash or pwsh here" };
    default: return { error: `terminal: unknown shell ${JSON.stringify(name)}; use bash, pwsh${win ? ", powershell or cmd" : ""}` };
  }
}

export class TerminalRegistry {
  private sessions = new Map<string, Session>();
  private seq = 0;
  private spawnFn: SpawnFn;
  private platform: string;
  private now: () => number;
  private envFn: () => NodeJS.ProcessEnv;
  private idleMs: number;
  private timer: NodeJS.Timeout | undefined;
  constructor(o: TerminalOpts = {}) {
    this.spawnFn = o.spawn ?? ((f, a, op) => nodeSpawn(f, a, op));
    this.platform = o.platform ?? process.platform;
    this.now = o.now ?? Date.now;
    this.envFn = o.env ?? (() => shellEnv(process.env, this.platform));
    this.idleMs = o.idleMs ?? IDLE_MS;
    if (o.reapEveryMs !== false) {
      this.timer = setInterval(() => this.reap(), o.reapEveryMs ?? 60_000);
      this.timer.unref();
    }
  }

  open(owner: string, cwd: string, shell?: string): TermInfo {
    this.reap();
    const mine = [...this.sessions.values()].filter((s) => s.owner === owner && s.status === "running").length;
    if (mine >= MAX_PER_OWNER) throw new Error(`terminal: ${MAX_PER_OWNER} sessions already open in this chat; close one first`);
    if ([...this.sessions.values()].filter((s) => s.status === "running").length >= MAX_TOTAL) throw new Error(`terminal: ${MAX_TOTAL} sessions already open on this machine; close one first`);
    const sp = shellSpec(shell, this.platform);
    if ("error" in sp) throw new Error(sp.error);
    // detached: its own process group on POSIX (so close takes the tree). windowsHide: no console window on Windows. stdin is a pipe we write to.
    const child = this.spawnFn(sp.file, sp.args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: this.platform !== "win32", windowsHide: true, env: this.envFn() });
    if (child.pid === undefined) { child.on?.("error", () => { /* spawn failed: reported below */ }); throw new Error(`terminal: could not start ${sp.name} (is it installed?)`); }
    const t = this.now();
    const s: Session = { id: `t${++this.seq}`, owner, shell: sp.name, cwd, pid: child.pid, status: "running", exitCode: null, startedAt: t, lastActiveAt: t, child, buf: "", dropped: 0, total: 0, readPos: 0, lastDataAt: t, listeners: new Set() };
    this.sessions.set(s.id, s);
    const onData = (d: Buffer | string) => {
      const text = stripAnsi(d.toString());
      s.buf += text;
      s.total += text.length;
      if (s.buf.length > BUF_CAP) { const cut = s.buf.length - BUF_CAP; s.buf = s.buf.slice(cut); s.dropped += cut; }
      s.lastDataAt = Date.now();
      this.wake(s);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdin?.on("error", () => { /* shell already gone: the close handler records it */ });
    child.on("error", (err) => { onData(`[spawn error: ${err.message}]\n`); if (s.status === "running") s.status = "exited"; this.wake(s); });
    child.on("close", (code) => { if (s.status === "running") s.status = "exited"; s.exitCode = code; this.wake(s); });
    return this.info(s);
  }

  private info(s: Session): TermInfo {
    return { id: s.id, shell: s.shell, cwd: s.cwd, pid: s.pid, status: s.status, exitCode: s.exitCode, startedAt: s.startedAt, lastActiveAt: s.lastActiveAt };
  }
  private wake(s: Session): void { for (const l of [...s.listeners]) l(); }
  private mine(owner: string, id: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner) throw new Error(`terminal: unknown session ${id || "(none)"}; open one first`);
    return s;
  }

  list(owner: string): TermInfo[] { this.reap(); return [...this.sessions.values()].filter((s) => s.owner === owner).map((s) => this.info(s)); }
  status(owner: string, id: string): TermInfo { return this.info(this.mine(owner, id)); }

  /** Write text to the shell's stdin. `enter` (default true) appends the shell's line ending. */
  send(owner: string, id: string, text: string, enter = true): TermInfo {
    const s = this.mine(owner, id);
    if (s.status !== "running") throw new Error(`terminal: session ${id} has ${s.status}${s.exitCode !== null ? ` (exit ${s.exitCode})` : ""}; open a new one`);
    const eol = s.shell === "cmd" || s.shell === "powershell" ? "\r\n" : "\n";
    const body = enter ? (text.endsWith("\n") ? text : text + eol) : text;
    s.child.stdin?.write(body);
    s.lastActiveAt = this.now();
    return this.info(s);
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
    const pid = s.child.pid;
    if (!pid) return { sent: false, note: "no pid" };
    if (this.platform === "win32") {
      // Windows has no console to deliver Ctrl-C to for a hidden pipe session: stop the shell's child processes instead.
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$k=0; Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Number(pid)}' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $k++ }; exit ($(if($k){0}else{1}))`], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
      return r.status === 0 ? { sent: true, note: "stopped the shell's running program" } : { sent: false, note: "nothing is running in the shell" };
    }
    const r = spawnSync("pkill", ["-INT", "-P", String(pid)], { stdio: "ignore", timeout: 5000 });
    return r.status === 0 ? { sent: true, note: "sent Ctrl-C (SIGINT) to what the shell is running" } : { sent: false, note: "nothing is running in the shell" };
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
    if (s.status === "running") s.status = "closed";
    const pid = s.child.pid;
    try { s.child.stdin?.end(); } catch { /* gone */ }
    if (this.platform === "win32") {
      try {
        if (!pid) s.child.kill();
        else if (sync) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        else nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => { /* taskkill missing: the shell is already gone */ });
      } catch { try { s.child.kill(); } catch { /* gone */ } }
      return;
    }
    try { if (pid) process.kill(-pid, "SIGKILL"); else s.child.kill("SIGKILL"); } catch { try { s.child.kill("SIGKILL"); } catch { /* gone */ } }
  }
}

let shared: TerminalRegistry | undefined;
let exitHooked = false;
function defaultRegistry(): TerminalRegistry {
  if (!shared) shared = new TerminalRegistry();
  if (!exitHooked) { exitHooked = true; process.on("exit", () => shared?.killAll()); } // sessions never outlive the gateway
  return shared;
}

const fmt = (i: TermInfo): string => `${i.id} ${i.shell} pid=${i.pid ?? "?"} ${i.status}${i.status !== "running" ? ` exit=${i.exitCode ?? "?"}` : ""} cwd=${JSON.stringify(i.cwd)}`;

export function createTerminalTool(registry?: TerminalRegistry): Tool {
  const reg = () => registry ?? defaultRegistry();
  return {
    class: "write",
    // read/list only show what the shell already printed; open/send/signal/close change the machine.
    classFor: (a): ToolClass => (a.action === "read" || a.action === "list" ? "read" : "write"),
    receipt: "surface",
    spec: {
      name: "terminal",
      description: "An interactive shell session on this machine that you type into and read back, with no window and never on the screen. Use it when a job needs a back-and-forth: answering a y/n or password-style prompt, an ssh session, a Python or node REPL, a dev server whose output you tail, a shell where cd and exported variables must persist. " +
        "Actions: open {shell?, cwd?} returns a session id; send {session, text, enter?, wait_ms?, until?} types text (enter defaults to true) and, with wait_ms, returns the new output; read {session, wait_ms?, until?} returns only the output since the last read; signal {session} sends Ctrl-C to what is running; close {session}; list. " +
        `read waits up to wait_ms (max ${MAX_WAIT_MS / 1000}s) for output to arrive and settle, or for the regex in until to match. Every command you send goes through the same permission rules as bash. ` +
        "Sessions are hidden, belong to this chat, are closed after 30 minutes idle and when Daebot quits. Pipes, not a real PTY: vim, top, less and other full-screen programs do not work; use python3 -iu for a Python REPL and ssh -tt for a remote tty. " +
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
          const info = reg().open(owner, cwd, typeof args.shell === "string" ? args.shell : undefined);
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
