// A Windows or Linux desktop (or the web) does not run the Simulator. When the owner has a paired Mac
// registered on the remote hub, a simulator request becomes a job for that Mac. The Mac runs it; this file only routes.
import type { DeviceInfo, RemoteHub, RemoteJob } from "../remote/hub.ts";
import type { DeviceSupport } from "./index.ts";
import { MSG_UNAVAILABLE } from "./simulator-mac.ts";

export interface PairedMac { id: string; name: string; online: boolean }

/** A Mac desktop this owner has registered. Online first, then the most recently seen (the hub list is already sorted that way). */
export function pairedMac(devices: (Pick<DeviceInfo, "id" | "name" | "os" | "kind"> & { online: boolean })[]): PairedMac | undefined {
  const macs = devices.filter((d) => d.os === "mac" && d.kind !== "server");
  const hit = macs.find((d) => d.online) ?? macs[0];
  return hit ? { id: hit.id, name: hit.name, online: hit.online } : undefined;
}

/** Appends the paired-Mac sentence to the Windows/Linux reason. A Mac that can run the Simulator locally is unchanged. */
export function withPairedMac(support: DeviceSupport, mac: { name: string; online: boolean } | undefined): DeviceSupport {
  if (!mac || support.ios_simulator.available) return support;
  const state = mac.online ? "online" : "offline";
  const extra = ` Paired Mac "${mac.name}" is registered (${state}); simulator requests are sent to it.`;
  return { ...support, ios_simulator: { ...support.ios_simulator, note: support.ios_simulator.note + extra } };
}

/** Actions a remote job may carry. Erase stays on the Mac: it is irreversible and the danger gate has to see it there. */
export const REMOTE_SIM_ACTIONS = ["list", "boot", "shutdown", "install", "launch", "terminate", "openurl", "screenshot", "record", "tap", "type", "swipe", "describe"] as const;

export function routeSimulatorRequest(
  hub: RemoteHub,
  owner: string,
  req: { sessionId: string; action: string; args?: Record<string, unknown>; surface?: string },
): { ok: true; job: RemoteJob; deviceName: string } | { ok: false; status: number; error: string } {
  const action = req.action;
  if (action === "erase") return { ok: false, status: 409, error: "Erasing a simulator is irreversible. Confirm it on the paired Mac, in a chat that runs there." };
  if (!REMOTE_SIM_ACTIONS.includes(action as (typeof REMOTE_SIM_ACTIONS)[number])) return { ok: false, status: 400, error: `unknown simulator action: ${String(action).slice(0, 40)}` };
  if (!req.sessionId || req.sessionId.length > 200) return { ok: false, status: 400, error: "sessionId required" };
  const mac = pairedMac(hub.devices(owner));
  if (!mac) return { ok: false, status: 409, error: MSG_UNAVAILABLE };
  const args = req.args && typeof req.args === "object" ? req.args : {};
  const job = hub.enqueue(owner, {
    deviceId: mac.id,
    sessionId: req.sessionId,
    botSlug: "",
    surface: req.surface ?? "web",
    title: "iOS Simulator",
    text: `simulator ${action}`,
    simulator: { action, args },
  });
  return { ok: true, job, deviceName: mac.name };
}
