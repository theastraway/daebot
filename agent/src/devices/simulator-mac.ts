// iOS Simulator on a Mac: Xcode detection and the argv for `xcrun simctl` / `idb`. Nothing here spawns a process.
// Callers pass an exec that uses an argv array and no shell. A physical device is never addressed: a udid has to be
// in `simctl list`, which only contains simulators.
import { isAbsolute, resolve, sep } from "node:path";
import { mouseJxa, typeArgs } from "../tools/computer-mac.ts";

export const MSG_XCODE_SELECT = "Xcode is not selected: run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` (needs your Mac password)";
export const MSG_INSTALL_XCODE = "Install Xcode from the App Store";
export const MSG_INSTALL_RUNTIME = "Install an iOS Simulator runtime in Xcode > Settings > Platforms";
export const MSG_IDB = "brew install idb-companion && pip3 install fb-idb for taps (optional)";
/** The reason GET /devices gives on Windows and Linux. Kept verbatim. */
export const MSG_NEEDS_MAC = "needs a Mac with Xcode; on Windows/Linux ask Daebot on your paired Mac (remote hub)";
export const MSG_UNAVAILABLE = `iOS Simulator is not available on this platform. It ${MSG_NEEDS_MAC}.`;
export const MSG_NOT_A_SIMULATOR = "That is not an iOS Simulator on this Mac. Daebot never controls a physical device.";
export const MSG_JXA = "This uses the Simulator window: it moves the mouse and needs Accessibility permission (System Settings, Privacy & Security, Accessibility).";

export interface SimExecResult { code: number | null; stdout: string; stderr: string }
export type SimExec = (cmd: string, args: string[], o?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<SimExecResult>;

/** spawn() options for every simulator child. `shell: false` is the whole point. */
export const SIM_SPAWN_OPTIONS = { shell: false as const, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  available: boolean;
}

export interface SimRuntime {
  identifier: string;
  name: string;
  platform: string;
  version: string;
  available: boolean;
}

export type XcodeReport =
  | { ok: true; developerDir: string; simctl: string; runtimes: SimRuntime[]; devices: SimDevice[]; idb: boolean; idbNote?: string }
  | { ok: false; message: string };

const UDID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export function isIosRuntime(r: Pick<SimRuntime, "platform" | "name" | "identifier">): boolean {
  return r.platform === "iOS" || /^iOS\b/.test(r.name) || r.identifier.includes(".iOS-") || r.identifier.includes("SimRuntime.iOS");
}

/** `simctl list -j devices runtimes`. Throws on invalid JSON so the caller can show the runtime message. */
export function parseSimctlList(raw: string): { devices: SimDevice[]; runtimes: SimRuntime[]; iosRuntime: boolean } {
  const j = JSON.parse(raw) as { devices?: unknown; runtimes?: unknown };
  const runtimes: SimRuntime[] = [];
  if (Array.isArray(j.runtimes)) {
    for (const r of j.runtimes) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "";
      const identifier = typeof o.identifier === "string" ? o.identifier : "";
      const platform = typeof o.platform === "string" ? o.platform : (/^iOS\b/.test(name) ? "iOS" : "");
      const available = o.isAvailable !== false && o.available !== false;
      runtimes.push({ identifier, name, platform, version: typeof o.version === "string" ? o.version : "", available });
    }
  }
  const devices: SimDevice[] = [];
  const groups = j.devices && typeof j.devices === "object" ? j.devices as Record<string, unknown> : {};
  for (const [runtime, list] of Object.entries(groups)) {
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      if (!d || typeof d !== "object") continue;
      const o = d as Record<string, unknown>;
      if (typeof o.udid !== "string" || !UDID_RE.test(o.udid)) continue;
      devices.push({
        udid: o.udid,
        name: typeof o.name === "string" && o.name ? o.name : o.udid,
        state: typeof o.state === "string" ? o.state : "Shutdown",
        runtime,
        available: o.isAvailable !== false,
      });
    }
  }
  return { devices, runtimes, iosRuntime: runtimes.some((r) => r.available && isIosRuntime(r)) };
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

/**
 * xcode-select -p, then xcrun --find simctl, then an available iOS runtime.
 * Each failure is one of the exact fix messages. idb is optional and never hides a missing Xcode.
 */
export async function detectXcode(exec: SimExec, o: { signal?: AbortSignal } = {}): Promise<XcodeReport> {
  const sel = await exec("xcode-select", ["-p"], { signal: o.signal, timeoutMs: 8000 });
  const dir = firstLine(sel.stdout ?? "");
  if (sel.code !== 0 || !dir) return { ok: false, message: MSG_INSTALL_XCODE };
  if (dir.includes("CommandLineTools") || !dir.includes("Xcode.app")) return { ok: false, message: MSG_XCODE_SELECT };
  const found = await exec("xcrun", ["--find", "simctl"], { signal: o.signal, timeoutMs: 8000 });
  const simctl = firstLine(found.stdout ?? "");
  if (found.code !== 0 || !simctl) return { ok: false, message: MSG_INSTALL_XCODE };
  const list = await exec("xcrun", ["simctl", "list", "-j", "devices", "runtimes"], { signal: o.signal, timeoutMs: 20_000 });
  if (list.code !== 0) return { ok: false, message: MSG_INSTALL_XCODE };
  let parsed: ReturnType<typeof parseSimctlList>;
  try { parsed = parseSimctlList(list.stdout ?? ""); } catch { return { ok: false, message: MSG_INSTALL_RUNTIME }; }
  if (!parsed.iosRuntime) return { ok: false, message: MSG_INSTALL_RUNTIME };
  const idb = await exec("which", ["idb"], { signal: o.signal, timeoutMs: 4000 });
  const idbOk = idb.code === 0 && firstLine(idb.stdout ?? "").length > 0;
  return {
    ok: true, developerDir: dir, simctl, runtimes: parsed.runtimes, devices: parsed.devices, idb: idbOk,
    ...(idbOk ? {} : { idbNote: MSG_IDB }),
  };
}

export function resolveSimulator(devices: SimDevice[], sel: { udid?: string; name?: string }): { ok: true; device: SimDevice } | { ok: false; error: string } {
  const udid = sel.udid?.trim();
  const name = sel.name?.trim();
  if (udid) {
    if (!UDID_RE.test(udid)) return { ok: false, error: MSG_NOT_A_SIMULATOR };
    const hit = devices.find((d) => d.udid.toLowerCase() === udid.toLowerCase());
    if (!hit) return { ok: false, error: MSG_NOT_A_SIMULATOR };
    if (!hit.available) return { ok: false, error: `${hit.name} is not an available simulator. ${MSG_INSTALL_RUNTIME}` };
    return { ok: true, device: hit };
  }
  if (name) {
    const exact = devices.filter((d) => d.name === name);
    const hits = exact.length ? exact : devices.filter((d) => d.name.toLowerCase() === name.toLowerCase());
    if (!hits.length) return { ok: false, error: `No iOS Simulator named "${name.slice(0, 80)}". ${MSG_NOT_A_SIMULATOR}` };
    const usable = hits.filter((d) => d.available);
    if (usable.length !== 1) {
      if (!usable.length) return { ok: false, error: `${name.slice(0, 80)} is not an available simulator. ${MSG_INSTALL_RUNTIME}` };
      return { ok: false, error: `"${name.slice(0, 80)}" matches ${usable.length} simulators. Pass a udid.` };
    }
    return { ok: true, device: usable[0] };
  }
  const booted = devices.filter((d) => d.available && d.state === "Booted");
  if (booted.length === 1) return { ok: true, device: booted[0] };
  if (booted.length > 1) return { ok: false, error: "More than one simulator is booted. Pass a udid." };
  return { ok: false, error: "No simulator is booted. Pass a udid or a name." };
}

export function mapDeviceToWindow(
  pt: { x: number; y: number },
  device: { w: number; h: number },
  win: { x: number; y: number; w: number; h: number },
  chromeTop = 28,
): { x: number; y: number } {
  const contentW = Math.max(1, win.w);
  const contentH = Math.max(1, win.h - chromeTop);
  const s = Math.min(contentW / Math.max(1, device.w), contentH / Math.max(1, device.h));
  const drawnW = device.w * s;
  const drawnH = device.h * s;
  const ox = win.x + (contentW - drawnW) / 2;
  const oy = win.y + chromeTop + (contentH - drawnH) / 2;
  return { x: Math.round(ox + pt.x * s), y: Math.round(oy + pt.y * s) };
}

/** System Events `{position, size}` of the Simulator window, as four numbers. */
export function parseWindowBounds(stdout: string): { x: number; y: number; w: number; h: number } | undefined {
  const n = (stdout.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (n.length < 4 || n.slice(0, 4).some((v) => !Number.isFinite(v))) return undefined;
  const [x, y, w, h] = n;
  if (!(w > 0) || !(h > 0)) return undefined;
  return { x, y, w, h };
}

export function windowQueryArgs(): string[] {
  return ["-e", 'tell application "System Events" to tell process "Simulator" to get {position, size} of window 1'];
}

export function activateSimulatorArgs(): string[] {
  return ["-e", 'tell application "Simulator" to activate'];
}

export function clickArgs(x: number, y: number): string[] {
  return ["-l", "JavaScript", "-e", mouseJxa({ op: "click", x, y })];
}

/** SOF marker width/height. Undefined when the buffer is not a JPEG we can read. */
export function jpegSize(buf: Buffer): { w: number; h: number } | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    if (i + 4 > buf.length) return undefined;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return undefined;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (i + 9 > buf.length) return undefined;
      const h = buf.readUInt16BE(i + 5);
      const w = buf.readUInt16BE(i + 7);
      if (w > 0 && h > 0) return { w, h };
      return undefined;
    }
    i += 2 + len;
  }
  return undefined;
}

export interface A11yNode { label: string; x: number; y: number; w: number; h: number }

/** idb `ui describe-all` JSON, flattened to labeled frames. Non-JSON is no nodes (the caller shows the raw text). */
export function accessibilityNodes(raw: string): A11yNode[] {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return []; }
  const out: A11yNode[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    const o = n as Record<string, unknown>;
    const label = [o.AXLabel, o.label, o.name, o.title].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    const frame = (o.frame && typeof o.frame === "object" ? o.frame : o.rect && typeof o.rect === "object" ? o.rect : undefined) as Record<string, unknown> | undefined;
    if (label && frame) {
      const x = Number(frame.x), y = Number(frame.y), w = Number(frame.width ?? frame.w), h = Number(frame.height ?? frame.h);
      if ([x, y, w, h].every((v) => Number.isFinite(v)) && w >= 0 && h >= 0) out.push({ label: label.trim(), x, y, w, h });
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(j);
  return out;
}

export function nodeByLabel(nodes: A11yNode[], label: string): A11yNode | undefined {
  const want = label.trim().toLowerCase();
  if (!want) return undefined;
  return nodes.find((n) => n.label.toLowerCase() === want) ?? nodes.find((n) => n.label.toLowerCase().includes(want));
}

function within(p: string, root: string): boolean {
  const a = resolve(p);
  const b = resolve(root);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

export interface BundleCheckOpts {
  home: string;
  cwd: string;
  tmp: string;
  stat?: (p: string) => { isDirectory(): boolean } | undefined;
  realpath?: (p: string) => string;
}

/** A local .app bundle inside the user's folders. .ipa and anything from the internet is refused. */
export function checkAppBundle(raw: string, o: BundleCheckOpts): { ok: true; path: string } | { ok: false; error: string } {
  let t = raw.trim();
  if (!t || t.includes("\0")) return { ok: false, error: "simulator install: app path is required (a local .app bundle)." };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return { ok: false, error: "simulator install: only a local .app bundle is accepted. An app from the internet is refused." };
  if (t.split(/[/\\]/).some((seg) => /\.ipa$/i.test(seg))) return { ok: false, error: "simulator install: an .ipa is refused, including one from the internet. Pass a local .app bundle." };
  if (t.startsWith("~/")) t = resolve(o.home, t.slice(2));
  if (!/\.app$/i.test(t)) return { ok: false, error: "simulator install: only a local .app bundle is accepted." };
  const abs = isAbsolute(t) ? resolve(t) : resolve(o.cwd, t);
  const roots = [o.home, o.cwd, o.tmp].filter(Boolean);
  if (!roots.some((r) => within(abs, r))) return { ok: false, error: "simulator install: that path is outside your folders. Pass a .app inside your home directory or this chat's folder." };
  let real = abs;
  if (o.realpath) {
    try { real = o.realpath(abs); } catch { return { ok: false, error: `simulator install: not found: ${abs}` }; }
  }
  if (!roots.some((r) => within(real, r))) return { ok: false, error: "simulator install: that path is outside your folders. Pass a .app inside your home directory or this chat's folder." };
  const st = o.stat?.(real);
  if (!st) return { ok: false, error: `simulator install: not found: ${real}` };
  if (!st.isDirectory()) return { ok: false, error: "simulator install: a .app bundle is a folder. That path is a file." };
  return { ok: true, path: real };
}

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,220}$/;

export function checkBundleId(v: unknown): string | { error: string } {
  if (typeof v !== "string" || !BUNDLE_ID.test(v)) return { error: "simulator: bundle id must look like com.example.app" };
  return v;
}

export function checkOpenUrl(v: unknown): string | { error: string } {
  if (typeof v !== "string" || !v.trim() || /[\r\n\0]/.test(v) || v.length > 2000) return { error: "simulator openurl: the URL is not valid" };
  let u: URL;
  try { u = new URL(v.trim()); } catch { return { error: "simulator openurl: the URL is not valid" }; }
  const proto = u.protocol.replace(/:$/, "").toLowerCase();
  if (proto === "file" || proto === "javascript" || proto === "data" || proto === "vbscript") return { error: `simulator openurl: ${proto}: URLs are refused` };
  if (!/^[a-z][a-z0-9+.-]*$/.test(proto)) return { error: "simulator openurl: the URL is not valid" };
  return u.toString();
}

export function point(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Math.round(Number(v));
  return undefined;
}

export function idbTapArgs(udid: string, x: number, y: number): string[] {
  return ["ui", "tap", String(x), String(y), "--udid", udid];
}

export function idbTextArgs(udid: string, text: string): string[] {
  return ["ui", "text", text, "--udid", udid];
}

export function idbSwipeArgs(udid: string, x: number, y: number, toX: number, toY: number): string[] {
  return ["ui", "swipe", String(x), String(y), String(toX), String(toY), "--udid", udid];
}

export function idbDescribeArgs(udid: string): string[] {
  return ["ui", "describe-all", "--udid", udid];
}

export { typeArgs };
