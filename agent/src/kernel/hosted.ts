import type { Gate } from "../types.ts";
import { hostedToolAllowed } from "../hosted.ts";

// Hosted deployments never run host-level tools (shell, files). Defense in depth: the runtime already
// removes them from the tool list; this gate refuses a call to any other name even if one slipped through.
export const hostedGate: Gate = {
  name: "hosted",
  preTool(_s, call) {
    if (hostedToolAllowed(call.name)) return undefined;
    return { gate: "hosted", action: "block", reason: `${call.name} is not available on the hosted deployment (only web_fetch, decide and mind_* tools run here)` };
  },
};
