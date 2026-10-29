import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Tool, ToolClass } from "../types.ts";
import { cap, fail, ok } from "./util.ts";
import { shellCommand, shellEnv } from "./bash.ts";

// Background processes for the owner's own machine (desktop / CLI only: hostedToolAllowed never lets `process` through).
// A started process is a plain child of the gateway: it needs no window, no focus and no interactive desktop, so it keeps
// running while the chat window is hidden or the screen is locked. It does NOT survive the gateway itself exiting.
const TAIL_BYTES = 64 * 1024;
const MAX_RUNNING = 16;
const MAX_KEPT = 64; // exited records kept for later status/tail calls
const OUTPUT_CAP = 30_000;

export type ProcStatus = "running" | "exited" | "killed";
export interface ProcInfo { id: string; command: string; cwd: string; pid: number | undefined; status: ProcStatus; exitCode: number | null; signal: string | null; startedAt: number; endedAt: number | null }

interface Entry extends ProcInfo { child: ChildProcess; tail: string; droppedBytes: number }
type SpawnFn = (file: string, args: string[], opts: SpawnOptions) => ChildProcess;

export interface RegistryOpts { spawn?: SpawnFn; platform?: string; now?: () => number; env?: () => NodeJS.ProcessEnv }

export class ProcessRegistry {
  private entries = new Map<string, Entry>();
  private seq = 0;
  private spawnFn: SpawnFn;
  private platform: string;
  private now: () => number;
  private envFn: () => NodeJS.ProcessEnv;
  constructor(o: RegistryOpts = {}) {
    this.spawnFn = o.spawn ?? ((f, a, op) => nodeSpawn(f, a, op));
    this.platform = o.platform ?? process.platform;
    this.now = o.now ?? Date.now;
    this.envFn = o.env ?? (() => shellEnv(process.env, this.platform));
  }

  start(command: string, cwd: string): ProcInfo {
    const running = [...this.entries.values()].filter((e) => e.status === "running").length;
    if (running >= MAX_RUNNING) throw new Error(`process: ${MAX_RUNNING} already running; kill one first`);
    const sh = shellCommand(command, this.platform);
    // detached: its own process group on POSIX (so kill takes the whole tree). windowsHide: no console window on Windows.
    const child = this.spawnFn(sh.file, sh.args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true, env: this.envFn() });
    const id = `p${++this.seq}`;
    const e: Entry = { id, command, cwd, pid: child.pid, status: "running", exitCode: null, signal: null, startedAt: this.now(), endedAt: null, child, tail: "", droppedBytes: 0 };
    this.entries.set(id, e);
    const onData = (d: Buffer | string) => {
      e.tail += d.toString();
      if (e.tail.length > TAIL_BYTES) { e.droppedBytes += e.tail.length - TAIL_BYTES; e.tail = e.tail.slice(e.tail.length - TAIL_BYTES); }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => { onData(`[spawn error: ${err.message}]\n`); if (e.status === "running") { e.status = "exited"; e.exitCode = null; e.endedAt = this.now(); } });
    child.on("close", (code, signal) => {
      if (e.status === "running") e.status = "exited";
      e.exitCode = code;
      e.signal = signal ?? null;
      e.endedAt = this.now();
      this.prune();
    });
    return this.info(e);
  }

  private info(e: Entry): ProcInfo {
    const { child: _c, tail: _t, droppedBytes: _d, ...pub } = e;
    return pub;
  }
  private prune(): void {
    const done = [...this.entries.values()].filter((e) => e.status !== "running");
    for (const e of done.slice(0, Math.max(0, done.length - MAX_KEPT))) this.entries.delete(e.id);
  }

  list(): ProcInfo[] { return [...this.entries.values()].map((e) => this.info(e)); }
  status(id: string): ProcInfo | undefined { const e = this.entries.get(id); return e ? this.info(e) : undefined; }
  tail(id: string, lines?: number): { info: ProcInfo; text: string; dropped: number } | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    let text = e.tail;
    if (lines && lines > 0) text = text.split("\n").slice(-(lines + (text.endsWith("\n") ? 1 : 0))).join("\n");
    return { info: this.info(e), text, dropped: e.droppedBytes };
  }
  kill(id: string): ProcInfo | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (e.status === "running") { e.status = "killed"; this.killTree(e); }
    return this.info(e);
  }
  killAll(): void { for (const e of this.entries.values()) if (e.status === "running") { e.status = "killed"; this.killTree(e, true); } }

  private killTree(e: Entry, sync = false): void {
    const pid = e.child.pid;
    if (this.platform === "win32") {
      try {
        if (pid) (sync ? spawnSync : nodeSpawn)("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        else e.child.kill();
      } catch { try { e.child.kill(); } catch { /* gone */ } }
      return;
    }
    try { if (pid) process.kill(-pid, "SIGKILL"); else e.child.kill("SIGKILL"); } catch { try { e.child.kill("SIGKILL"); } catch { /* gone */ } }
  }
}

let shared: ProcessRegistry | undefined;
let exitHooked = false;
function defaultRegistry(): ProcessRegistry {
  if (!shared) shared = new ProcessRegistry();
  if (!exitHooked) { exitHooked = true; process.on("exit", () => shared?.killAll()); } // children never outlive the gateway
  return shared;
}

const fmt = (i: ProcInfo): string =>
  `${i.id} pid=${i.pid ?? "?"} ${i.status}${i.status !== "running" ? ` exit=${i.exitCode ?? i.signal ?? "?"}` : ""} cmd=${JSON.stringify(i.command.length > 120 ? i.command.slice(0, 117) + "..." : i.command)}`;

export function createProcessTool(registry?: ProcessRegistry): Tool {
  const reg = () => registry ?? defaultRegistry();
  return {
    class: "write",
    // start/kill change the machine; status/tail only read what a process already printed.
    classFor: (a): ToolClass => (a.action === "status" || a.action === "tail" ? "read" : "write"),
    receipt: "surface",
    spec: {
      name: "process",
      description: "Run a long job in the background and poll it, on this machine: builds, test suites, downloads, watchers, long conversions, dev servers. Use it instead of a foreground bash or a screen session for anything over about a minute, or when the user says watch, keep going, tell me when done. Start it, tell the user it is running, then check status/tail on later turns. Actions: start {command, cwd?} returns an id at once; " +
        "status {id?} (no id lists all); tail {id, lines?} shows recent stdout/stderr; kill {id} stops it and its children. " +
        "Background processes keep running while the chat window is hidden or the screen is locked, and stop when Daebot's gateway quits. Use bash for short one-shot commands.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "status", "tail", "kill"] },
          command: { type: "string", description: "start: the shell command (bash, or PowerShell on Windows without bash)" },
          cwd: { type: "string", description: "start: working directory (default: the session's)" },
          id: { type: "string", description: "status/tail/kill: the id start returned" },
          lines: { type: "number", description: "tail: only the last N lines" },
        },
        required: ["action"],
      },
    },
    async run(args, ctx) {
      const action = args.action;
      const id = typeof args.id === "string" ? args.id : "";
      try {
        if (action === "start") {
          if (typeof args.command !== "string" || args.command.trim() === "") return fail("process: command is required for start");
          const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : ctx.cwd;
          const info = reg().start(args.command, cwd);
          return ok(`started ${fmt(info)}`, { id: info.id, pid: info.pid });
        }
        if (action === "status") {
          if (!id) { const all = reg().list(); return ok(all.length ? all.map(fmt).join("\n") : "no background processes"); }
          const s = reg().status(id);
          return s ? ok(fmt(s), { status: s.status, exitCode: s.exitCode }) : fail(`process: unknown id ${id}`);
        }
        if (action === "tail") {
          if (!id) return fail("process: id is required for tail");
          const t = reg().tail(id, Number.isFinite(Number(args.lines)) ? Math.floor(Number(args.lines)) : undefined);
          if (!t) return fail(`process: unknown id ${id}`);
          const note = t.dropped > 0 ? `[${t.dropped} earlier bytes dropped]\n` : "";
          return ok(`${fmt(t.info)}\n${note}${cap(t.text, OUTPUT_CAP)}`, { status: t.info.status, exitCode: t.info.exitCode });
        }
        if (action === "kill") {
          if (!id) return fail("process: id is required for kill");
          const k = reg().kill(id);
          return k ? ok(`killed ${fmt(k)}`) : fail(`process: unknown id ${id}`);
        }
        return fail("process: action must be start, status, tail or kill");
      } catch (e) {
        return fail(String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300));
      }
    },
  };
}

export const processTool: Tool = createProcessTool();
