// bot_talk: one bot (or a session) asks another bot something. Class "write" (it changes another thread's state, but never
// reaches a third party), no receipt: the reply is a claim, not evidence. All the limits live in the bus (bus.ts).
import type { Tool } from "../types.ts";
import type { BotBusRef } from "./types.ts";

export function createBotTalkTool(o: { bus: BotBusRef; owner: string; selfBot?: string }): Tool {
  return {
    spec: {
      name: "bot_talk",
      description:
        "Ask another bot (by slug) something that is in its area. Say what you need and why. Its reply is a CLAIM, not a receipt: verify load-bearing facts in its MIND (mind_query with mind:\"<slug>\"). " +
        "One question per call; do not ping-pong. Limits apply (depth, no loops, a budget per user message). See mind_tenants for the bots.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Slug of the bot to ask" },
          message: { type: "string", description: "What you need from it, and why" },
        },
        required: ["to", "message"],
        additionalProperties: false,
      },
    },
    class: "write",
    async run(args, ctx) {
      const to = typeof args.to === "string" ? args.to.trim().toLowerCase() : "";
      const message = typeof args.message === "string" ? args.message.trim() : "";
      if (!to) return { ok: false, output: "bot_talk needs `to` (a bot slug; see mind_tenants)" };
      if (!message) return { ok: false, output: "bot_talk needs a `message`" };
      if (message.length > 8000) return { ok: false, output: "bot_talk message is too long (8000 characters max)" };
      const bus = o.bus.current;
      if (!bus) return { ok: false, output: "bot_talk is not available here (no bot bus is running)" };
      const r = await bus.talk({ owner: o.owner, fromSession: ctx.sessionId, selfBot: o.selfBot, to, message, signal: ctx.signal });
      return { ok: r.ok, output: r.output }; // deliberately no meta.costUsd: the recipient turn is already counted in its own session
    },
  };
}
