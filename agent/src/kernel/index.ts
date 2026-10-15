import type { Gate, GateVerdict, Kernel, Tool, ToolCall, TurnState, Violation } from "../types.ts";
import { allowedBeforeBoot, bootGate } from "./boot.ts";
import { dangerGate, grantIfAffirmed } from "./danger.ts";
import { feedGate, publicAllowed } from "./feed.ts";
import { hostedGate } from "./hosted.ts";
import { hostedToolAllowed } from "../hosted.ts";
import { createIsolationGate } from "./isolation.ts";
import type { IsolationOptions } from "./isolation.ts";
import { createOwnerGate } from "./owner.ts";
import { receiptGate } from "./receipt.ts";
import { createTierGate, tierAllows } from "./tier.ts";
import type { Tier } from "./tier.ts";

export { findClaims, validReceipts } from "./receipt.ts";
export { grantIfAffirmed } from "./danger.ts";
export { callSignature } from "./util.ts";
export { parseTier } from "./tier.ts";
export type { Tier } from "./tier.ts";

const CAP = 1000;

export function createKernel(opts: {
  shadow: boolean;
  enabled: boolean;
  onViolation?: (v: Violation) => void;
  isolation?: IsolationOptions;
  clientNames?: string[];            // optional client registry for the semantic owner check
  tier?: Tier;                       // identity tier; default admin (unrestricted)
  hosted?: boolean;                  // public deployment: only web_fetch and mind_* tools may run
}): Kernel {
  const log: Violation[] = [];
  const tier: Tier = opts.tier ?? "admin";
  // dangerGate is evaluated last (and only when nothing else refused the call) so a single-use approval is
  // never consumed by a call another gate stops.
  const preGates: Gate[] = [...(opts.hosted ? [hostedGate] : []), createTierGate(tier), bootGate, feedGate, createOwnerGate({ clientNames: opts.clientNames }), createIsolationGate(opts.isolation)];
  const turnGates: Gate[] = [...preGates, dangerGate];
  const answerGates: Gate[] = [receiptGate];
  const enabled = opts.enabled;

  function record(s: TurnState, v: GateVerdict, enforced: boolean): void {
    const viol: Violation = { at: Date.now(), sessionId: s.sessionId, gate: v.gate, action: v.action, reason: v.reason, enforced };
    log.push(viol);
    if (log.length > CAP) log.splice(0, log.length - CAP);
    opts.onViolation?.(viol);
  }

  // Non-allow verdicts are logged; in shadow (state or option) they are returned as "allow".
  function process(s: TurnState, verdicts: (GateVerdict | undefined)[]): GateVerdict[] {
    const out: GateVerdict[] = [];
    const shadow = opts.shadow || s.shadow;
    for (const v of verdicts) {
      if (!v || v.action === "allow") continue;
      if (shadow) {
        record(s, v, false);
        out.push({ gate: v.gate, action: "allow", reason: `[shadow] would ${v.action}: ${v.reason}` });
      } else {
        record(s, v, true);
        out.push(v);
      }
    }
    return out;
  }

  return {
    allowedTools(s: TurnState, all: Tool[]): Tool[] {
      if (!enabled || opts.shadow || s.shadow) return all;
      let tools = all;
      if (opts.hosted) tools = tools.filter((t) => hostedToolAllowed(t.spec.name));
      if (!s.booted) tools = allowedBeforeBoot(tools);
      if (!publicAllowed(s)) tools = tools.filter((t) => t.class !== "public");
      if (tier !== "admin") tools = tools.filter((t) => tierAllows(tier, t));
      return tools;
    },
    preTurn(s) {
      if (!enabled) return [];
      return process(s, turnGates.map((g) => g.preTurn?.(s)));
    },
    preTool(s, call: ToolCall, tool: Tool) {
      if (!enabled) return [];
      const first = preGates.map((g) => g.preTool?.(s, call, tool));
      const refused = !(opts.shadow || s.shadow) && first.some((v) => v && v.action !== "allow");
      return process(s, refused ? first : [...first, dangerGate.preTool?.(s, call, tool)]);
    },
    preAnswer(s, draft) {
      if (!enabled) return [];
      return process(s, answerGates.map((g) => g.preAnswer?.(s, draft)));
    },
    postTurn(s, finalAnswer) {
      if (!enabled) return;
      for (const g of [...turnGates, ...answerGates]) g.postTurn?.(s, finalAnswer);
    },
    onUserMessage(s, msg) {
      if (!enabled) return;
      grantIfAffirmed(s, msg);
    },
    violations() {
      return log.slice();
    },
  };
}
