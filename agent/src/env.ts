// Home environments. Every session and bot has ONE home: where it runs. Three kinds:
//   cloud   - hosted MIND Cloud (daebot.live)
//   machine - a user's computer running the Daebot desktop app (its local gateway)
//   server  - a headless server (a droplet) where a Daebot gateway is deployed
// The tag is recorded server-side when a session or bot is created and travels with the record through device sync, so every device
// shows the same grouping. The id of a machine or server is its device id (the same id it uses for Remote), so the online dot is real.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname as osHostname, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { daebotHome } from "./home.ts";

export type EnvKind = "cloud" | "machine" | "server";
export interface EnvTag { id: string; kind: EnvKind; name: string }
/** A tag as shown in the sidebar: the tag plus whether that place is reachable right now. */
export interface EnvView extends EnvTag { online: boolean; current: boolean }

export const CLOUD_ID = "cloud";
export const CLOUD_ENV: EnvTag = { id: CLOUD_ID, kind: "cloud", name: "MIND Cloud" };

const KINDS: ReadonlySet<string> = new Set(["cloud", "machine", "server"]);

/** "Anthonys-MacBook-Pro.local" -> "Anthonys MacBook Pro". A name we are willing to show. */
export function prettyHost(raw: string): string {
  const t = String(raw ?? "").replace(/\.(local|lan|home|localdomain|internal)$/i, "").replace(/[-_]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return t.slice(0, 60) || "This computer";
}

/** Validates a tag that arrived over the wire or from disk. Anything malformed is dropped (never trusted into the UI). */
export function normalizeEnv(v: unknown): EnvTag | undefined {
  const r = v as Partial<EnvTag> | null;
  if (!r || typeof r !== "object") return undefined;
  if (typeof r.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.id)) return undefined;
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return undefined;
  if (r.kind === "cloud" && r.id !== CLOUD_ID) return undefined;
  if (typeof r.name !== "string") return undefined;
  const name = r.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) return undefined;
  return { id: r.id, kind: r.kind as EnvKind, name };
}

export interface DetectOpts {
  hosted?: boolean;
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  platform?: string;
  /** Read the install's device id from disk. false = derive from the hostname (nothing is read or written). */
  deviceId?: string;
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
  const name = (env.DAEBOT_ENV_NAME ?? "").trim() ? prettyName(env.DAEBOT_ENV_NAME!) : kind === "server" ? host.slice(0, 60) || "Server" : prettyHost(host);
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

export interface EnvReach { cloudOnline: boolean; devices: ReadonlyMap<string, boolean> }

/** The environments to show: every one a row points at, plus the known devices, each with its online state. The current one is marked. */
export function envViews(tags: Iterable<EnvTag>, current: EnvTag, reach: EnvReach): EnvView[] {
  const by = new Map<string, EnvTag>();
  by.set(current.id, current);
  for (const t of tags) if (!by.has(t.id)) by.set(t.id, t);
  const online = (t: EnvTag): boolean => (t.id === current.id ? true : t.kind === "cloud" ? reach.cloudOnline : reach.devices.get(t.id) === true);
  return [...by.values()].map((t) => ({ ...t, online: online(t), current: t.id === current.id }));
}
