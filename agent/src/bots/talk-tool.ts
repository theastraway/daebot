// bot_talk: the main Daebot or a bot messages another bot (or the main Daebot) by slug / "main". Class "write" (it changes another thread's state, but never
// reaches a third party), no receipt: the reply is a claim, not evidence. All the limits live in the bus (bus.ts).
import type { Tool } from "../types.ts";
import type { BotBusRef } from "./types.ts";

export function createBotTalkTool(o: { bus: BotBusRef; owner: string; selfBot?: string }): Tool {
  return {
    spec: {
      name: "bot_talk",
      description:
        "Message another agent: any of the user's bots (by slug) or the main Daebot (to: \"main\"). Say what you need and why. The reply is a CLAIM, not a receipt: verify load-bearing facts in its MIND (mind_query with mind:\"<slug>\"). " +
        "Every pair of agents has one running exchange the user can open and read from the card this call leaves in the chat. wait_for_reply (default true) waits for the answer; false delivers and returns, the answer lands in the exchange. " +
        "One question per call; do not ping-pong, and do not ask again for an answer you already have (even if you must rewrite your reply: reuse it). Limits apply (depth, no loops, no messaging yourself, a budget per user message, 10 messages per exchange until the user speaks). See mind_tenants for the bots.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Slug of the bot to message, or \"main\" for the main Daebot" },
          message: { type: "string", description: "What you need from it, and why" },
          wait_for_reply: { type: "boolean", description: "Wait for the answer (default true). false = deliver and return; the answer is recorded in the exchange." },
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
      const r = await bus.talk({ owner: o.owner, fromSession: ctx.sessionId, selfBot: o.selfBot, to, message, waitForReply: args.wait_for_reply === false ? false : true, signal: ctx.signal });
      return { ok: r.ok, output: r.output, ...(r.exchange ? { meta: { exchange: r.exchange } } : {}) }; // deliberately no meta.costUsd: the recipient turn is already counted in its own session
    },
  };
}
