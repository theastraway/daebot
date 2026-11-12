// Home environments. Every session and bot has ONE home: where it runs. Three kinds:
//   cloud   - hosted MIND Cloud (daebot.live)
//   machine - a user's computer running the Daebot desktop app (its local gateway)
//   server  - a headless server (a droplet) where a Daebot gateway is deployed
// The tag is recorded server-side when a session or bot is created and travels with the record through device sync, so every device
// shows the same grouping. The id of a machine or server is its device id (the same id it uses for Remote), so the online dot is real.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname as osHostname, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { daebotHome } from "./home.ts";

export type EnvKind = "cloud" | "machine" | "server";
export interface EnvTag { id: string; kind: EnvKind; name: string }
/** A tag as shown in the sidebar: the tag plus whether that place is reachable right now. */
export interface EnvView extends EnvTag {
  online: boolean;
  /** True for the place this client is running on right now (the computer you are on); everything else is remote. */
  current: boolean;
  /** When the device last checked in (ms). Absent for MIND Cloud and for places no device has reported. */
  lastSeen?: number;
  /** What the device said about itself: "mac", "windows" or "linux", and the hardware model when the OS has one ("Legion 5 15ITH6"). */
  os?: string;
  model?: string;
  host?: string;
}

export const CLOUD_ID = "cloud";
export const CLOUD_ENV: EnvTag = { id: CLOUD_ID, kind: "cloud", name: "MIND Cloud" };

/**
 * Who decided a home. "default" = nobody did: the standard (MIND Cloud). "user" = the person turned "Run on a computer" on or off (the only way a
 * session or bot comes to run on a computer). "auto" = the system moved it (the migration that put auto-stamped computers back on MIND Cloud).
 * `envAt` (ms) says when, so every device settles on the latest decision.
 */
export type EnvBy = "user" | "auto" | "default";
export const isEnvBy = (v: unknown): v is EnvBy => v === "user" || v === "auto" || v === "default";

/** True for a home that is a computer or a server (anything but MIND Cloud). */
export const isLocalHome = (e: { kind?: string } | undefined | null): boolean => !!e && e.kind !== "cloud";

/**
 * Where a NEW session or bot starts. MIND Cloud, everywhere (desktop, web, phone): a computer is only ever chosen by the person (a toggle).
 * A headless server (a droplet's gateway) is the one exception: deploying a gateway there IS the choice, and nothing else can run its threads.
 */
export function defaultHome(own: EnvTag): EnvTag { return own.kind === "server" ? own : CLOUD_ENV; }

const KINDS: ReadonlySet<string> = new Set(["cloud", "machine", "server"]);

/** "Anthonys-MacBook-Pro.local" -> "Anthonys MacBook Pro". A name we are willing to show. */
export function prettyHost(raw: string): string {
  // macOS makes "Anthonys-MacBook-Pro-7" when another machine on the network already has the name: the "-7" is not part of what a person would say.
  const t = tidyName(String(raw ?? ""), "machine").replace(/^(.*\b(?:MacBook(?:[- ](?:Pro|Air))?|iMac|Mac[- ](?:mini|Studio|Pro)))[- ]\d{1,2}$/i, "$1").replace(/[-_]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return t.slice(0, 60) || "This computer";
}

/**
 * The name of a computer as a person would say it. Drops a network domain ("Anthonys MBP 7.mynetworksettings.com" -> "Anthonys MBP 7",
 * "Macs-MacBook-Air.local" -> "Macs MacBook Air"). A raw hostname (no spaces) also loses its dashes, except on a server, where the hostname IS its name.
 */
export function tidyName(raw: string, kind: EnvKind = "machine"): string {
  let t = String(raw ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
  const dot = t.indexOf(".");
  if (dot > 0 && /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/i.test(t.slice(dot + 1))) t = t.slice(0, dot);
  if (kind !== "server" && !t.includes(" ")) t = t.replace(/[-_]+/g, " ").trim();
  return t.slice(0, 60);
}

/** What two registrations of the same computer have in common: the tidy name, lower case, letters and digits only. */
export function deviceKey(raw: string): string {
  return tidyName(raw, "machine").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Validates a tag that arrived over the wire or from disk. Anything malformed is dropped (never trusted into the UI). */
export function normalizeEnv(v: unknown): EnvTag | undefined {
  const r = v as Partial<EnvTag> | null;
  if (!r || typeof r !== "object") return undefined;
  if (typeof r.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.id)) return undefined;
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return undefined;
  if (r.kind === "cloud" && r.id !== CLOUD_ID) return undefined;
  if (typeof r.name !== "string") return undefined;
  const name = r.kind === "cloud" ? r.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) : tidyName(r.name, r.kind as EnvKind);
  if (!name) return undefined;
  return { id: r.id, kind: r.kind as EnvKind, name };
}

export interface DetectOpts {
  hosted?: boolean;
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  platform?: string;
  /** The device id of this install (from disk). Absent = derived from the hostname (nothing is read or written). */
  deviceId?: string;
  /** The name the person gave this computer (macOS "Computer Name", the Windows device name). Absent = looked up on a real run, hostname in tests. */
  computerName?: string;
}

/** The friendly name of this computer, when the OS has one: macOS ComputerName (System Settings > General > About), the Windows device name. */
export function readComputerName(platform: string = osPlatform(), env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    if (platform === "darwin") { const t = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim(); return t || undefined; }
    if (platform === "win32") return (env.COMPUTERNAME ?? "").trim() || undefined;
  } catch { /* no friendly name: the hostname stands in */ }
  return undefined;
}

let modelCache: { key: string; v: string | undefined } | undefined;
/** The hardware model of this computer, when the OS gives a readable one (Windows: the product name, e.g. "Legion 5 15ITH6"). Cached. Shown beside the name, never used as the name. */
export function readHardwareModel(platform: string = osPlatform()): string | undefined {
  if (modelCache?.key === platform) return modelCache.v;
  let v: string | undefined;
  try {
    if (platform === "win32") {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$p=Get-CimInstance Win32_ComputerSystemProduct; $m=Get-CimInstance Win32_ComputerSystem; ($p.Version, $m.Manufacturer, $m.Model) -join '|'"], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
      const [ver, man, mod] = out.split("|").map((x) => x.trim());
      const clean = (x: string | undefined): string => (x && !/^(none|to be filled|default string|system product name|system version|not applicable|o\.e\.m)/i.test(x) ? x : "");
      v = clean(ver) || [clean(man), clean(mod)].filter(Boolean).join(" ") || undefined;
    }
  } catch { /* no model: the name stands alone */ }
  v = v ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || undefined : undefined;
  modelCache = { key: platform, v };
  return v;
}

/** The short OS word a device reports about itself. */
export function osLabel(platform: string = osPlatform()): "mac" | "windows" | "linux" | undefined {
  return platform === "darwin" ? "mac" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : undefined;
}

/** This process's own home environment. */
export function detectEnv(o: DetectOpts = {}): EnvTag {
  if (o.hosted) return CLOUD_ENV;
  const env = o.env ?? process.env;
  const host = (o.hostname ?? osHostname() ?? "").trim();
  const plat = o.platform ?? osPlatform();
  const forced = (env.DAEBOT_ENV_KIND ?? "").trim().toLowerCase();
  const headless = plat === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
  const kind: EnvKind = forced === "server" || forced === "machine" ? forced : headless ? "server" : "machine";
  const forcedId = (env.DAEBOT_ENV_ID ?? "").trim();
  const id = o.deviceId && /^d_[0-9a-f]{16}$/.test(o.deviceId) ? o.deviceId : /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(forcedId) ? forcedId : "d_" + createHash("sha256").update(host || "unknown").digest("hex").slice(0, 16);
  const real = o.hostname === undefined && o.platform === undefined;
  const friendly = o.computerName ?? (real && kind === "machine" ? readComputerName(plat, env) : undefined);
  const name = (env.DAEBOT_ENV_NAME ?? "").trim() ? prettyName(env.DAEBOT_ENV_NAME!) : kind === "server" ? tidyName(host, "server") || "Server" : friendly ? tidyName(friendly, "machine") || prettyHost(host) : prettyHost(tidyName(host, "machine"));
  return { id, kind, name };
}

const prettyName = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);

/** The install's device id if it exists on disk (it is written by the Remote agent on first run); undefined otherwise. Never writes. */
export function readDeviceId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try { const t = readFileSync(join(daebotHome(env), "device-id"), "utf8").trim(); return /^d_[0-9a-f]{16}$/.test(t) ? t : undefined; } catch { return undefined; }
}

/** detectEnv for the running process, reading the real device id when there is one. */
export function localEnv(o: { hosted?: boolean; env?: NodeJS.ProcessEnv } = {}): EnvTag {
  return detectEnv({ hosted: o.hosted, env: o.env, deviceId: o.hosted ? undefined : readDeviceId(o.env) });
}

/** The environment a record belongs to. A record with no tag (made before environments existed) belongs to `fallback`. */
export function envOf(rec: { env?: unknown } | undefined, fallback: EnvTag): EnvTag {
  return normalizeEnv(rec?.env) ?? fallback;
}

export interface EnvReach {
  cloudOnline: boolean;
  devices: ReadonlyMap<string, boolean>;
  /** What each device (by environment id) last reported: when it was seen, its OS, model and hostname. */
  info?: ReadonlyMap<string, { lastSeen?: number; os?: string; model?: string; host?: string }>;
}

/** The environments to show: every one a row points at, plus the known devices, each with its online state. The current one is marked. */
export function envViews(tags: Iterable<EnvTag>, current: EnvTag, reach: EnvReach): EnvView[] {
  const by = new Map<string, EnvTag>();
  by.set(current.id, current);
  for (const t of tags) if (!by.has(t.id)) by.set(t.id, t);
  const online = (t: EnvTag): boolean => (t.id === current.id ? true : t.kind === "cloud" ? reach.cloudOnline : reach.devices.get(t.id) === true);
  return [...by.values()].map((t) => {
    const i = t.kind === "cloud" ? undefined : reach.info?.get(t.id);
    return { ...t, online: online(t), current: t.id === current.id, ...(i?.lastSeen ? { lastSeen: i.lastSeen } : {}), ...(i?.os ? { os: i.os } : {}), ...(i?.model ? { model: i.model } : {}), ...(i?.host ? { host: i.host } : {}) };
  });
}

// ---------- one place per computer ----------
// A computer can be registered several times (a reinstall or a second profile makes a new device id; an older build registered the
// network hostname, a newer one the name the person gave it). Devices that share a tidy name or a hostname are ONE environment.

/** A name a person typed: kept as typed (control characters out, one space between words, 60 characters). */
export const cleanLabel = (s: string): string => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);

export interface DeviceLike { id: string; name: string; host?: string; kind?: "machine" | "server"; os?: string; model?: string; lastSeen: number; online: boolean }
export interface EnvGroup extends EnvTag { members: string[]; keys: string[]; online: boolean; lastSeen: number; os?: string; model?: string; host?: string }

/** Merges devices that are the same computer into one group each. The name shown is the person's rename, else the friendliest recent name. */
export function groupDevices(devs: readonly DeviceLike[], renames: Readonly<Record<string, string>> = {}): EnvGroup[] {
  const list = devs.filter((d) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(d.id));
  const parent = new Map<string, string>(list.map((d) => [d.id, d.id]));
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let c = x; while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; } return r; };
  const owner = new Map<string, string>();
  const keysOf = (d: DeviceLike): string[] => [d.name, d.host ?? ""].map((n) => deviceKey(n)).filter((k) => k.length >= 2).map((k) => `${d.kind ?? "machine"}:${k}`);
  for (const d of list) for (const k of keysOf(d)) { const o = owner.get(k); if (o === undefined) owner.set(k, d.id); else parent.set(find(d.id), find(o)); }
  const by = new Map<string, DeviceLike[]>();
  for (const d of list) { const r = find(d.id); by.set(r, [...(by.get(r) ?? []), d]); }
  const out: EnvGroup[] = [];
  for (const ms of by.values()) {
    const sorted = [...ms].sort((a, b) => b.lastSeen - a.lastSeen);
    const rep = sorted.find((d) => d.online) ?? sorted[0];
    const kind: EnvKind = rep.kind === "server" ? "server" : "machine";
    const renamed = sorted.map((d) => renames[d.id]).find((n) => typeof n === "string" && n.trim());
    const spaced = sorted.find((d) => tidyName(d.name, kind).includes(" "));
    const name = (renamed ? cleanLabel(renamed) : "") || tidyName((spaced ?? rep).name, kind) || (kind === "server" ? "Server" : "This computer");
    const os = sorted.find((d) => d.os)?.os, model = sorted.find((d) => d.model)?.model, host = sorted.find((d) => d.host)?.host;
    out.push({ id: rep.id, kind, name, members: sorted.map((d) => d.id), keys: [...new Set(sorted.flatMap(keysOf))], online: sorted.some((d) => d.online), lastSeen: sorted[0].lastSeen, ...(os ? { os } : {}), ...(model ? { model } : {}), ...(host ? { host } : {}) });
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen);
}

/** The environment a stored tag points at once duplicate registrations are merged and renames are applied. Cloud keeps its own (renamable) name. */
export function canonEnv(tag: unknown, groups: readonly EnvGroup[], cloudName?: string): EnvTag | undefined {
  const t = normalizeEnv(tag);
  if (!t) return undefined;
  if (t.kind === "cloud") return cloudName ? { ...CLOUD_ENV, name: cloudName } : CLOUD_ENV;
  const g = groups.find((x) => x.kind === t.kind && x.members.includes(t.id)) ?? groups.find((x) => x.kind === t.kind && x.keys.includes(`${t.kind}:${deviceKey(t.name)}`));
  return g ? { id: g.id, kind: g.kind, name: g.name } : t;
}
