// The Simulator on this machine: simctl for the device, idb for touch when it is installed, otherwise a JXA click
// into the Simulator window (that moves the mouse and needs Accessibility — the result says so). Never a physical device,
// and never a silent fall-through to screen control when Xcode is missing.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daebotHome } from "../home.ts";
import type { ToolResult } from "../types.ts";
import { fail, ok } from "../tools/util.ts";
import { quoteUntrusted } from "../tools/untrusted.ts";
import { typeArgs } from "../tools/computer-mac.ts";
import {
  MSG_IDB, MSG_INSTALL_RUNTIME, MSG_JXA, MSG_UNAVAILABLE, SIM_SPAWN_OPTIONS,
  activateSimulatorArgs, accessibilityNodes, checkAppBundle, checkBundleId, checkOpenUrl, clickArgs,
  detectXcode, idbDescribeArgs, idbSwipeArgs, idbTapArgs, idbTextArgs, jpegSize, mapDeviceToWindow,
  nodeByLabel, parseSimctlList, parseWindowBounds, point, resolveSimulator, windowQueryArgs,
} from "./simulator-mac.ts";
import type { SimDevice, SimExec, XcodeReport } from "./simulator-mac.ts";

export interface SimProc {
  pid?: number;
  kill(signal?: NodeJS.Signals): void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
export type SimSpawn = (cmd: string, args: string[]) => SimProc;

export const runSimExec: SimExec = (cmd, args, o = {}) => new Promise((resolve) => {
  let stdout = "", stderr = "";
  let child;
  try { child = spawn(cmd, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
  catch (e) { return resolve({ code: null, stdout, stderr: (e as Error).message }); }
  child.stdout.on("data", (d: Buffer) => { if (stdout.length < 2_000_000) stdout += d.toString("utf8"); });
  child.stderr.on("data", (d: Buffer) => { if (stderr.length < 8000) stderr += d.toString("utf8"); });
  const kill = () => { try { child.kill(); } catch { /* gone */ } };
  const timer = setTimeout(kill, o.timeoutMs ?? 30_000);
  o.signal?.addEventListener("abort", kill, { once: true });
  child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: e.message }); });
  child.on("close", (code) => { clearTimeout(timer); o.signal?.removeEventListener("abort", kill); resolve({ code, stdout, stderr }); });
});

/** A new process group so SIGINT reaches simctl recordVideo, not a shell. */
export const spawnSim: SimSpawn = (cmd, args) => {
  const child = spawn(cmd, args, { ...SIM_SPAWN_OPTIONS, detached: true, windowsHide: true });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", () => resolve({ code: null, signal: null }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    pid: child.pid,
    kill(signal: NodeJS.Signals = "SIGINT") {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* gone */ }
      }
    },
    exited,
  };
};

export interface SimulatorStatus {
  available: boolean;
  note: string;
  /** Dev shots only. A real Simulator never sets this. */
  fixture?: boolean;
  idb: boolean;
  devices: SimDevice[];
  selected: string | null;
  recording: boolean;
  recordingPath?: string;
}

export interface SimulatorService {
  status(): Promise<SimulatorStatus>;
  boot(sel: { udid?: string; name?: string }): Promise<{ ok: true; udid: string; output: string } | { ok: false; error: string }>;
  shutdown(sel: { udid?: string; name?: string }): Promise<{ ok: true; udid: string; output: string } | { ok: false; error: string }>;
  screenshot(sel?: { udid?: string; name?: string }): Promise<{ ok: true; udid: string; jpeg: Buffer } | { ok: false; error: string }>;
  record(op: "start" | "stop", sel?: { udid?: string; name?: string }): Promise<{ ok: true; udid: string; path?: string; output: string } | { ok: false; error: string }>;
  run(args: Record<string, unknown>, ctx: { cwd?: string; signal?: AbortSignal }): Promise<ToolResult>;
  /** Best-effort SIGINT of a recording as the process exits. */
  stopRecording(): void;
}

export interface SimulatorDeps {
  platform?: string;
  exec?: SimExec;
  spawn?: SimSpawn;
  home?: string;
  tmp?: string;
  mediaDir?: string;
  now?: () => number;
  stat?: (p: string) => { isDirectory(): boolean } | undefined;
  realpath?: (p: string) => string;
}

interface Ready { idb: boolean; idbNote?: string; devices: SimDevice[] }

const MAX_TEXT = 2000;
const clip = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);
const already = (stderr: string, state: string): boolean => new RegExp(`current state: ${state}`, "i").test(stderr);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function createSimulatorService(deps: SimulatorDeps = {}): SimulatorService {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? runSimExec;
  const spawnProc = deps.spawn ?? spawnSim;
  const home = deps.home ?? daebotHome();
  const tmp = deps.tmp ?? tmpdir();
  const mediaDir = deps.mediaDir ?? join(daebotHome(), "media", "simulator");
  const now = deps.now ?? Date.now;
  const stat = deps.stat ?? ((p: string) => { try { return statSync(p); } catch { return undefined; } });
  const realpath = deps.realpath ?? ((p: string) => realpathSync(p));

  let snap: Ready | { error: string } | undefined;
  let dirty = false;
  let selected: string | null = null;
  const sizes = new Map<string, { w: number; h: number }>();
  let recording: { proc: SimProc; path: string; udid: string } | null = null;

  async function load(): Promise<Ready | { error: string }> {
    if (snap && "error" in snap) return snap;
    if (platform !== "darwin") { snap = { error: MSG_UNAVAILABLE }; return snap; }
    if (!snap) {
      let report: XcodeReport;
      try { report = await detectXcode(exec); } catch (e) { snap = { error: clip(String((e as Error)?.message ?? e)) || MSG_UNAVAILABLE }; return snap; }
      if (!report.ok) { snap = { error: report.message }; return snap; }
      snap = { idb: report.idb, idbNote: report.idbNote, devices: report.devices };
      dirty = false;
      return snap;
    }
    if (!dirty) return snap;
    const list = await exec("xcrun", ["simctl", "list", "-j", "devices", "runtimes"], { timeoutMs: 20_000 });
    if (list.code !== 0) return snap;
    try {
      const parsed = parseSimctlList(list.stdout ?? "");
      if (!parsed.iosRuntime) { snap = { error: MSG_INSTALL_RUNTIME }; return snap; }
      snap = { ...snap, devices: parsed.devices };
      dirty = false;
    } catch { /* keep the list we have */ }
    return snap;
  }

  async function pick(sel: { udid?: string; name?: string }): Promise<{ ok: true; device: SimDevice; ready: Ready } | { ok: false; error: string }> {
    const ready = await load();
    if ("error" in ready) return { ok: false, error: ready.error };
    const found = resolveSimulator(ready.devices, sel);
    if (!found.ok) return found;
    return { ok: true, device: found.device, ready };
  }

  async function shotFile(udid: string, signal?: AbortSignal): Promise<{ ok: true; jpeg: Buffer } | { ok: false; error: string }> {
    const dir = await mkdtemp(join(tmp, "daebot-sim-"));
    const file = join(dir, "shot.jpg");
    try {
      const r = await exec("xcrun", ["simctl", "io", udid, "screenshot", "--type=jpeg", file], { signal, timeoutMs: 30_000 });
      if (r.code !== 0) return { ok: false, error: `screenshot failed (${clip(r.stderr || r.stdout || `exit ${r.code}`)})` };
      const jpeg = await readFile(file);
      if (!jpeg.length) return { ok: false, error: "screenshot file was empty" };
      const dim = jpegSize(jpeg);
      if (dim) sizes.set(udid, dim);
      return { ok: true, jpeg };
    } catch (e) {
      return { ok: false, error: clip((e as Error).message) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function windowPoint(udid: string, x: number, y: number, signal?: AbortSignal): Promise<{ x: number; y: number } | { error: string }> {
    const q = await exec("osascript", windowQueryArgs(), { signal, timeoutMs: 10_000 });
    const bounds = q.code === 0 ? parseWindowBounds(q.stdout) : undefined;
    if (!bounds) return { error: `The Simulator window is not open. ${MSG_JXA} ${MSG_IDB}` };
    let size = sizes.get(udid);
    if (!size) {
      const shot = await shotFile(udid, signal);
      if (!shot.ok) return { error: shot.error };
      size = sizes.get(udid) ?? jpegSize(shot.jpeg);
    }
    if (!size) return { error: `Could not read the simulator's screen size. ${MSG_JXA}` };
    return mapDeviceToWindow({ x, y }, size, bounds);
  }

  const svc: SimulatorService = {
    stopRecording() {
      if (!recording) return;
      try { recording.proc.kill("SIGINT"); } catch { /* gone */ }
      recording = null;
    },
    async status() {
      const ready = await load();
      if ("error" in ready) return { available: false, note: ready.error, idb: false, devices: [], selected: null, recording: !!recording };
      const booted = ready.devices.find((d) => d.available && d.state === "Booted");
      const sel = booted?.udid ?? (selected && ready.devices.some((d) => d.udid === selected) ? selected : null);
      const note = ready.idbNote ? `Simulators on this Mac. ${ready.idbNote}` : "Simulators on this Mac.";
      return {
        available: true, note, idb: ready.idb, devices: ready.devices, selected: sel, recording: !!recording,
        ...(recording ? { recordingPath: recording.path } : {}),
      };
    },
    async boot(sel) {
      const hit = await pick(sel);
      if (!hit.ok) return hit;
      const r = await exec("xcrun", ["simctl", "boot", hit.device.udid], { timeoutMs: 90_000 });
      if (r.code !== 0 && !already(r.stderr + r.stdout, "Booted")) return { ok: false, error: `boot failed (${clip(r.stderr || r.stdout || `exit ${r.code}`)})` };
      selected = hit.device.udid;
      dirty = true;
      return { ok: true, udid: hit.device.udid, output: `Booted ${hit.device.name} (${hit.device.udid}).` };
    },
    async shutdown(sel) {
      const hit = await pick(sel);
      if (!hit.ok) return hit;
      const r = await exec("xcrun", ["simctl", "shutdown", hit.device.udid], { timeoutMs: 60_000 });
      if (r.code !== 0 && !already(r.stderr + r.stdout, "Shutdown")) return { ok: false, error: `shutdown failed (${clip(r.stderr || r.stdout || `exit ${r.code}`)})` };
      dirty = true;
      return { ok: true, udid: hit.device.udid, output: `Shut down ${hit.device.name} (${hit.device.udid}).` };
    },
    async screenshot(sel = {}) {
      const hit = await pick(sel);
      if (!hit.ok) return hit;
      if (hit.device.state !== "Booted") return { ok: false, error: `${hit.device.name} is not booted. Boot it before taking a screenshot.` };
      const shot = await shotFile(hit.device.udid);
      if (!shot.ok) return shot;
      return { ok: true, udid: hit.device.udid, jpeg: shot.jpeg };
    },
    async record(op, sel = {}) {
      if (op === "stop") {
        if (!recording) return { ok: false, error: "No simulator recording is in progress." };
        const cur = recording;
        recording = null;
        try { cur.proc.kill("SIGINT"); } catch { /* already gone */ }
        await Promise.race([cur.proc.exited, new Promise((r) => setTimeout(r, 8000))]);
        return { ok: true, udid: cur.udid, path: cur.path, output: `Stopped recording. Saved ${cur.path}` };
      }
      if (recording) return { ok: false, error: `Already recording to ${recording.path}. Stop it before starting another.` };
      const hit = await pick(sel);
      if (!hit.ok) return hit;
      if (hit.device.state !== "Booted") return { ok: false, error: `${hit.device.name} is not booted. Boot it before recording.` };
      await mkdir(mediaDir, { recursive: true });
      const path = join(mediaDir, `simulator-${hit.device.udid.slice(0, 8)}-${now()}.mov`);
      let proc: SimProc;
      try { proc = spawnProc("xcrun", ["simctl", "io", hit.device.udid, "recordVideo", "--codec=h264", path]); }
      catch (e) { return { ok: false, error: clip((e as Error).message) }; }
      recording = { proc, path, udid: hit.device.udid };
      return { ok: true, udid: hit.device.udid, path, output: `Recording ${hit.device.name} to ${path}. Stop it with record op:stop.` };
    },
    async run(args, ctx) {
      const action = str(args.action) ?? "";
      const signal = ctx.signal;
      const sel = { udid: str(args.udid), name: str(args.name) };
      try {
        if (action === "list") {
          const st = await svc.status();
          if (!st.available) return fail(st.note);
          const lines = st.devices.map((d) => `${d.udid}  ${d.state.padEnd(8)}  ${d.name}  ${d.runtime}`);
          return ok((lines.join("\n") || "No simulators.") + (st.note.includes(MSG_IDB) ? `\n${MSG_IDB}` : ""), { devices: st.devices.length, idb: st.idb });
        }
        if (action === "boot") {
          const r = await svc.boot(sel);
          return r.ok ? ok(r.output, { udid: r.udid }) : fail(r.error);
        }
        if (action === "shutdown") {
          const r = await svc.shutdown(sel);
          return r.ok ? ok(r.output, { udid: r.udid }) : fail(r.error);
        }
        if (action === "screenshot") {
          const r = await svc.screenshot(sel);
          if (!r.ok) return fail(r.error);
          const dim = jpegSize(r.jpeg);
          return {
            ok: true,
            output: `Screenshot of ${r.udid}${dim ? ` (${dim.w}x${dim.h})` : ""}.`,
            images: [`data:image/jpeg;base64,${r.jpeg.toString("base64")}`],
            meta: { udid: r.udid, ...(dim ? { width: dim.w, height: dim.h } : {}) },
          };
        }
        if (action === "record") {
          const op = str(args.op) ?? str(args.record);
          if (op !== "start" && op !== "stop") return fail("simulator record: op must be start or stop");
          const r = await svc.record(op, sel);
          return r.ok ? ok(r.output, { udid: r.udid, ...(r.path ? { path: r.path } : {}) }) : fail(r.error);
        }
        if (action === "install") {
          const hit = await pick(sel);
          if (!hit.ok) return fail(hit.error);
          const app = str(args.app) ?? str(args.path);
          if (!app) return fail("simulator install: app path is required (a local .app bundle).");
          const checked = checkAppBundle(app, {
            home, cwd: ctx.cwd || home, tmp, stat, realpath,
          });
          if (!checked.ok) return fail(checked.error);
          const r = await exec("xcrun", ["simctl", "install", hit.device.udid, checked.path], { signal, timeoutMs: 120_000 });
          if (r.code !== 0) return fail(`install failed (${clip(r.stderr || r.stdout || `exit ${r.code}`)})`);
          return ok(`Installed ${checked.path} on ${hit.device.name} (${hit.device.udid}).`, { udid: hit.device.udid });
        }
        if (action === "launch" || action === "terminate") {
          const hit = await pick(sel);
          if (!hit.ok) return fail(hit.error);
          const bid = checkBundleId(str(args.bundle_id) ?? str(args.bundle) ?? args.bundle_id);
          if (typeof bid !== "string") return fail(bid.error);
          const r = await exec("xcrun", ["simctl", action, hit.device.udid, bid], { signal, timeoutMs: 60_000 });
          if (r.code !== 0) return fail(`${action} failed (${clip(r.stderr || r.stdout || `exit ${r.code}`)})`);
          return ok(`${action === "launch" ? "Launched" : "Terminated"} ${bid} on ${hit.device.name}.`, { udid: hit.device.udid, bundle_id: bid });
        }
        if (action === "openurl") {
          const hit = await pick(sel);
          if (!hit.ok) return fail(hit.error);
          const url = checkOpenUrl(args.url);
          if (typeof url !== "string") return fail(url.error);
          const r = await exec("xcrun", ["simctl", "openurl", hit.device.udid, url], { signal, timeoutMs: 20_000 });
          if (r.code !== 0) return fail(`openurl failed (${clip(r.stderr || r.stdout || `exit ${r.code}`)})`);
          return ok(`Opened ${url} on ${hit.device.name}.`, { udid: hit.device.udid });
        }
        if (action === "erase") {
          const hit = await pick(sel);
          if (!hit.ok) return fail(hit.error);
          const r = await exec("xcrun", ["simctl", "erase", hit.device.udid], { signal, timeoutMs: 120_000 });
          if (r.code !== 0) return fail(`erase failed (${clip(r.stderr || r.stdout || `exit ${r.code}`)})`);
          dirty = true;
          return ok(`Erased ${hit.device.name} (${hit.device.udid}). The simulator's data is gone.`, { udid: hit.device.udid });
        }
        if (action === "describe") {
          const hit = await pick(sel);
          if (!hit.ok) return fail(hit.error);
          if (!hit.ready.idb) return fail(MSG_IDB);
          const r = await exec("idb", idbDescribeArgs(hit.device.udid), { signal, timeoutMs: 30_000 });
          if (r.code !== 0) return fail(`describe failed (${clip(r.stderr || r.stdout || `exit ${r.code}`)})`);
          const text = (r.stdout || "").slice(0, 30_000);
          return ok(quoteUntrusted("iOS Simulator accessibility tree", text), { udid: hit.device.udid });
        }
        if (action === "swipe") {
          const hit = await pick(sel);
          if (!hit.ok) return fail(hit.error);
          if (!hit.ready.idb) return fail(`${MSG_IDB} Swipe is not done by moving the mouse.`);
          const x = point(args.x), y = point(args.y), toX = point(args.to_x), toY = point(args.to_y);
          if ([x, y, toX, toY].some((n) => n === undefined || n < 0 || n > 20000)) return fail("simulator swipe: x, y, to_x and to_y are required (simulator points)");
          const r = await exec("idb", idbSwipeArgs(hit.device.udid, x!, y!, toX!, toY!), { signal, timeoutMs: 20_000 });
          if (r.code !== 0) return fail(`swipe failed (${clip(r.stderr || r.stdout || `exit ${r.code}`)})`);
          return ok(`Swiped ${x},${y} to ${toX},${toY} on ${hit.device.name}.`, { udid: hit.device.udid });
        }
        if (action === "tap") {
          const hit = await pick(sel);
          if (!hit.ok) return fail(hit.error);
          const label = str(args.label);
          let x = point(args.x), y = point(args.y);
          if (hit.ready.idb) {
            if (label && (x === undefined || y === undefined)) {
              const desc = await exec("idb", idbDescribeArgs(hit.device.udid), { signal, timeoutMs: 30_000 });
              if (desc.code !== 0) return fail(`tap failed (${clip(desc.stderr || desc.stdout || `exit ${desc.code}`)})`);
              const node = nodeByLabel(accessibilityNodes(desc.stdout || ""), label);
              if (!node) return fail(`No control labeled "${label.slice(0, 80)}" on ${hit.device.name}.`);
              x = Math.round(node.x + node.w / 2);
              y = Math.round(node.y + node.h / 2);
            }
            if (x === undefined || y === undefined || x < 0 || y < 0 || x > 20000 || y > 20000) return fail("simulator tap: pass x and y, or a label idb can see");
            const r = await exec("idb", idbTapArgs(hit.device.udid, x, y), { signal, timeoutMs: 20_000 });
            if (r.code !== 0) return fail(`tap failed (${clip(r.stderr || r.stdout || `exit ${r.code}`)})`);
            return ok(`Tapped ${label ? `"${label}" at ` : ""}${x},${y} on ${hit.device.name} with idb.`, { udid: hit.device.udid });
          }
          if (label) return fail(`${MSG_IDB} A label needs idb. Pass x and y to tap through the Simulator window.`);
          if (x === undefined || y === undefined || x < 0 || y < 0 || x > 20000 || y > 20000) return fail("simulator tap: x and y are required (simulator points)");
          const mapped = await windowPoint(hit.device.udid, x, y, signal);
          if ("error" in mapped) return fail(mapped.error);
          await exec("osascript", activateSimulatorArgs(), { signal, timeoutMs: 10_000 });
          const click = await exec("osascript", clickArgs(mapped.x, mapped.y), { signal, timeoutMs: 10_000 });
          if (click.code !== 0) return fail(`tap failed (${clip(click.stderr || click.stdout || `exit ${click.code}`)}). ${MSG_JXA}`);
          return ok(`Tapped ${x},${y} on ${hit.device.name} through the Simulator window (screen ${mapped.x},${mapped.y}). ${MSG_JXA} ${MSG_IDB}`, { udid: hit.device.udid });
        }
        if (action === "type") {
          const hit = await pick(sel);
          if (!hit.ok) return fail(hit.error);
          const text = typeof args.text === "string" ? args.text : "";
          if (!text) return fail("simulator type: text is required");
          if (text.length > MAX_TEXT) return fail(`simulator type: text is over ${MAX_TEXT} characters; send it in parts`);
          if (hit.ready.idb) {
            const r = await exec("idb", idbTextArgs(hit.device.udid, text), { signal, timeoutMs: 20_000 });
            if (r.code !== 0) return fail(`type failed (${clip(r.stderr || r.stdout || `exit ${r.code}`)})`);
            return ok(`Typed ${text.length} characters on ${hit.device.name} with idb.`, { udid: hit.device.udid });
          }
          const x = point(args.x), y = point(args.y);
          if (x !== undefined && y !== undefined) {
            const mapped = await windowPoint(hit.device.udid, x, y, signal);
            if ("error" in mapped) return fail(mapped.error);
            await exec("osascript", clickArgs(mapped.x, mapped.y), { signal, timeoutMs: 10_000 });
          } else {
            const q = await exec("osascript", windowQueryArgs(), { signal, timeoutMs: 10_000 });
            if (q.code !== 0 || !parseWindowBounds(q.stdout)) return fail(`The Simulator window is not open. ${MSG_JXA} ${MSG_IDB}`);
          }
          await exec("osascript", activateSimulatorArgs(), { signal, timeoutMs: 10_000 });
          const typed = await exec("osascript", typeArgs(text), { signal, timeoutMs: 20_000 });
          if (typed.code !== 0) return fail(`type failed (${clip(typed.stderr || typed.stdout || `exit ${typed.code}`)}). ${MSG_JXA}`);
          return ok(`Typed ${text.length} characters into the Simulator window. ${MSG_JXA} ${MSG_IDB}`, { udid: hit.device.udid });
        }
        return fail("simulator: action must be list, boot, shutdown, install, launch, terminate, openurl, screenshot, record, tap, type, swipe, describe or erase");
      } catch (e) {
        return fail(clip((e as Error)?.message ?? String(e)));
      }
    },
  };
  return svc;
}

let shared: SimulatorService | undefined;
let exitHooked = false;

export function useSimulatorService(s: SimulatorService): void {
  shared = s;
}

/** The process-wide service. The tool and the local pane share it, so a boot from one shows in the other. */
export function simulatorService(): SimulatorService {
  if (!shared) {
    shared = createSimulatorService();
    if (!exitHooked) {
      exitHooked = true;
      process.on("exit", () => shared?.stopRecording());
    }
  }
  return shared;
}
