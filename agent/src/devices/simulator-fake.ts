// Dev-only stand-in for the shots harness. It never spawns xcrun, idb or osascript.
// It turns on only when all three flags are set and the gateway is not hosted, and only the
// smoke launch sets them. A normal desktop run never sees fixture devices or this picture.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../types.ts";
import { fail, ok } from "../tools/util.ts";
import type { SimDevice } from "./simulator-mac.ts";
import type { SimulatorService, SimulatorStatus } from "./simulator-service.ts";

/** 8x8 JPEG used when the harness did not pass a picture. Not a screenshot of anything. */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgGBgcGBwgICAgICAkJCQoKCgkJCQkKCgoKCgoMDAwKCgoKCgoKDAwMDA0ODQ0NDA0ODg8PDxISEREVFRUZGR//xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAAAAEQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAIAAgDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCNgKP/2Q==",
  "base64",
);

const PHONE = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const SE = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";

export function simulatorFakeEnabled(env: NodeJS.ProcessEnv = process.env, hosted = false): boolean {
  return !hosted
    && env.DAEBOT_SIMULATOR_FAKE === "1"
    && env.DAEBOT_DEV_SHOTS === "1"
    && env.MINDCLAW_DESKTOP_FAKE === "1";
}

function jpegFrom(env: NodeJS.ProcessEnv): Buffer {
  const p = env.DAEBOT_SIMULATOR_FIXTURE_JPEG;
  if (p) {
    try {
      const b = readFileSync(p);
      if (b.length) return b;
    } catch { /* the tiny picture still labels the pane as a fixture */ }
  }
  return TINY_JPEG;
}

export function createFakeSimulatorService(opts: { env?: NodeJS.ProcessEnv; now?: () => number; mediaDir?: string } = {}): SimulatorService {
  const env = opts.env ?? process.env;
  const jpeg = jpegFrom(env);
  const now = opts.now ?? Date.now;
  const mediaDir = opts.mediaDir ?? join(tmpdir(), "daebot-sim-fixture");
  const devices: SimDevice[] = [
    { udid: PHONE, name: "iPhone 16", state: "Booted", runtime: "iOS 18.5", available: true },
    { udid: SE, name: "iPhone SE (3rd generation)", state: "Shutdown", runtime: "iOS 18.5", available: true },
  ];
  let selected: string | null = PHONE;
  let recording: { udid: string; path: string } | null = null;

  const pick = (sel: { udid?: string; name?: string }): SimDevice | undefined => {
    if (sel.udid) return devices.find((d) => d.udid === sel.udid);
    if (sel.name) return devices.find((d) => d.name === sel.name);
    return devices.find((d) => d.udid === selected) ?? devices.find((d) => d.state === "Booted");
  };

  const status = async (): Promise<SimulatorStatus> => ({
    available: true,
    fixture: true,
    note: "Fixture. This picture is not a live simulator.",
    idb: false,
    devices: devices.map((d) => ({ ...d })),
    selected,
    recording: !!recording,
    ...(recording ? { recordingPath: recording.path } : {}),
  });

  const svc: SimulatorService = {
    status,
    stopRecording() { recording = null; },
    async boot(sel) {
      const d = pick(sel);
      if (!d) return { ok: false, error: "No fixture simulator by that name." };
      d.state = "Booted";
      selected = d.udid;
      return { ok: true, udid: d.udid, output: `Booted ${d.name} (fixture).` };
    },
    async shutdown(sel) {
      const d = pick(sel);
      if (!d) return { ok: false, error: "No fixture simulator by that name." };
      d.state = "Shutdown";
      return { ok: true, udid: d.udid, output: `Shut down ${d.name} (fixture).` };
    },
    async screenshot(sel = {}) {
      const d = pick(sel);
      if (!d) return { ok: false, error: "No fixture simulator." };
      if (d.state !== "Booted") return { ok: false, error: `${d.name} is not booted.` };
      return { ok: true, udid: d.udid, jpeg };
    },
    async record(op, sel = {}) {
      const d = pick(sel);
      if (op === "stop") {
        if (!recording) return { ok: false, error: "No simulator recording is in progress." };
        const path = recording.path;
        const udid = recording.udid;
        recording = null;
        return { ok: true, udid, path, output: `Stopped recording. Saved ${path}` };
      }
      if (!d) return { ok: false, error: "No fixture simulator." };
      if (d.state !== "Booted") return { ok: false, error: `${d.name} is not booted. Boot it before recording.` };
      if (recording) return { ok: false, error: `Already recording to ${recording.path}.` };
      const path = join(mediaDir, `simulator-${d.udid.slice(0, 8)}-${now()}.mov`);
      recording = { udid: d.udid, path };
      return { ok: true, udid: d.udid, path, output: `Recording ${d.name} to ${path} (fixture).` };
    },
    async run(args): Promise<ToolResult> {
      const action = typeof args.action === "string" ? args.action : "";
      const sel = { udid: typeof args.udid === "string" ? args.udid : undefined, name: typeof args.name === "string" ? args.name : undefined };
      if (action === "list") {
        const st = await status();
        return ok(st.devices.map((d) => `${d.udid}  ${d.state}  ${d.name}`).join("\n"), { fixture: true });
      }
      if (action === "boot") { const r = await svc.boot(sel); return r.ok ? ok(r.output, { udid: r.udid }) : fail(r.error); }
      if (action === "shutdown") { const r = await svc.shutdown(sel); return r.ok ? ok(r.output, { udid: r.udid }) : fail(r.error); }
      if (action === "screenshot") {
        const r = await svc.screenshot(sel);
        return r.ok ? { ok: true, output: "Fixture screenshot.", images: [`data:image/jpeg;base64,${r.jpeg.toString("base64")}`], meta: { udid: r.udid, fixture: true } } : fail(r.error);
      }
      if (action === "record") {
        const op = args.op === "stop" || args.record === "stop" ? "stop" : args.op === "start" || args.record === "start" ? "start" : "";
        if (op !== "start" && op !== "stop") return fail("simulator record: op must be start or stop");
        const r = await svc.record(op, sel);
        return r.ok ? ok(r.output, { udid: r.udid }) : fail(r.error);
      }
      return fail("This is a fixture simulator for the shots harness. It does not run that action.");
    },
  };
  return svc;
}
