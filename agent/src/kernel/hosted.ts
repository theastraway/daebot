import type { Gate } from "../types.ts";
import { hostedCallAllowed, hostedToolAllowed } from "../hosted.ts";

// Hosted deployments never run host-level tools (shell, files). Defense in depth: the runtime already
// removes them from the tool list; this gate refuses a call to any other name even if one slipped through.
export const hostedGate: Gate = {
  name: "hosted",
  preTool(_s, call) {
    if (hostedCallAllowed(call.name, call.args)) return undefined;
    if (hostedToolAllowed(call.name)) return { gate: "hosted", action: "block", reason: "loop runs in write mode only on the hosted deployment (build mode needs the desktop app: a shell and a git worktree)" };
    return { gate: "hosted", action: "block", reason: `${call.name} is not available on the hosted deployment (only web_fetch, decide, view_photo and mind_* tools run here)` };
  },
};
