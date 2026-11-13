// The `simulator` tool. Offered on a Mac desktop only. Windows and Linux do not get it:
// a request from there is a hub job for the paired Mac (see devices/simulator-remote.ts).
import type { AgentEvent, Tool, ToolClass } from "../types.ts";
import { daebotHome } from "../home.ts";
import { MSG_UNAVAILABLE } from "../devices/simulator-mac.ts";
import { simulatorService } from "../devices/simulator-service.ts";
import type { SimulatorService } from "../devices/simulator-service.ts";
import { fail } from "./util.ts";

export function simulatorToolSupported(platform: string = process.platform): boolean {
  return platform === "darwin";
}

export function createSimulatorTool(opts: { service?: SimulatorService; platform?: string } = {}): Tool {
  const platform = opts.platform ?? process.platform;
  const service = () => opts.service ?? simulatorService();
  return {
    class: "write",
    // list, screenshot and describe only look. erase wipes the simulator and needs the user's go.
    classFor: (a): ToolClass => {
      const action = String(a.action ?? "");
      if (action === "erase") return "irreversible";
      if (action === "list" || action === "screenshot" || action === "describe") return "read";
      return "write";
    },
    receipt: "surface",
    spec: {
      name: "simulator",
      description: "Drive an iOS Simulator on this Mac with Xcode's simctl. Never a physical device. " +
        "Actions: list; boot {udid|name}; shutdown {udid|name}; install {udid|name, app} a local .app bundle only (an .ipa or a download is refused); " +
        "launch {udid|name, bundle_id}; terminate {udid|name, bundle_id}; openurl {udid|name, url} (the simulator can reach this Mac's localhost); " +
        "screenshot {udid|name}; record {udid|name, op:start|stop} saves a clip under Daebot's media folder; " +
        "tap {udid|name, x, y | label}; type {udid|name, text}; swipe {udid|name, x, y, to_x, to_y}; describe {udid|name}. " +
        "Tap, type, swipe and describe use idb when it is installed. Without idb, a coordinate tap or type clicks the Simulator window, which moves the mouse and needs Accessibility permission, and the result says so. " +
        "erase {udid|name} deletes the simulator's data and is irreversible. " +
        "If Xcode or an iOS runtime is missing, the result is the install step. Do not use the computer tool on the Simulator instead.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "boot", "shutdown", "install", "launch", "terminate", "openurl", "screenshot", "record", "tap", "type", "swipe", "describe", "erase"] },
          udid: { type: "string", description: "The simulator's udid from list. Required when more than one device matches the name." },
          name: { type: "string", description: "The simulator's name from list, such as iPhone 16." },
          app: { type: "string", description: "install: a local .app bundle inside your home directory or this chat's folder" },
          bundle_id: { type: "string", description: "launch/terminate: a bundle id such as com.example.app" },
          url: { type: "string", description: "openurl: http(s) or a custom scheme. file: is refused." },
          op: { type: "string", enum: ["start", "stop"], description: "record: start or stop" },
          x: { type: "number", description: "tap/swipe: device x" },
          y: { type: "number", description: "tap/swipe: device y" },
          to_x: { type: "number", description: "swipe: end x" },
          to_y: { type: "number", description: "swipe: end y" },
          label: { type: "string", description: "tap: an accessibility label, when idb is installed" },
          text: { type: "string", description: "type: the characters to enter" },
        },
        required: ["action"],
      },
    },
    async run(args, ctx) {
      if (platform !== "darwin" && !opts.service) return fail(MSG_UNAVAILABLE);
      return service().run(args, { cwd: ctx.cwd, signal: ctx.signal });
    },
  };
}

/** The paired Mac runs one simulator job and streams the tool events back. Erase is never queued. */
export async function runSimulatorJob(
  job: { sessionId: string; simulator?: { action: string; args: Record<string, unknown> } },
  emit: (ev: AgentEvent) => void,
  signal: AbortSignal,
  tool?: Tool,
): Promise<void> {
  const sim = job.simulator;
  if (!sim) throw new Error("not a simulator job");
  if (!tool && !simulatorToolSupported()) throw new Error(MSG_UNAVAILABLE);
  const t = tool ?? createSimulatorTool();
  const args = { action: sim.action, ...(sim.args ?? {}) };
  emit({ type: "toolStart", receiptId: "sim", tool: "simulator", args });
  const r = await t.run(args, { cwd: daebotHome(), sessionId: job.sessionId, signal });
  emit({ type: "toolEnd", receiptId: "sim", tool: "simulator", ok: r.ok, preview: r.output.slice(0, 240) });
  if (!r.ok) throw new Error(r.output.slice(0, 300));
  emit({ type: "notice", level: "info", text: r.output.slice(0, 500) });
}
