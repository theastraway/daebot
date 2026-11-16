// bot_talk: the main Daebot or a bot messages another bot (or the main Daebot) by slug / "main". Class "write" (it changes another thread's state, but never
// reaches a third party), no receipt: the reply is a claim, not evidence. All the limits live in the bus (bus.ts).
import type { HandoffCard, ModelTier, Tool } from "../types.ts";
import type { BotBusRef } from "./types.ts";

const TIERS = new Set(["local", "reflex", "light", "coder", "reasoner", "frontier"]);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 300)).slice(0, 12) : []);

/** The card as the model wrote it, checked field by field; undefined when it is not a usable card. */
export function parseCard(v: unknown): HandoffCard | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const c = v as Record<string, unknown>;
  const objective = typeof c.objective === "string" ? c.objective.trim().slice(0, 400) : "";
  const next = typeof c.next === "string" ? c.next.trim().slice(0, 400) : "";
  if (!objective || !next) return undefined;
  const tier = typeof c.tier === "string" && TIERS.has(c.tier.trim().toLowerCase()) ? (c.tier.trim().toLowerCase() as ModelTier) : undefined;
  const verify = typeof c.verify === "string" && c.verify.trim() ? c.verify.trim().slice(0, 400) : undefined;
  return { objective, evidence: strs(c.evidence), left: strs(c.left), next, ...(verify ? { verify } : {}), ...(tier ? { tier } : {}), at: Date.now() };
}

export function createBotTalkTool(o: { bus: BotBusRef; owner: string; selfBot?: string }): Tool {
  return {
    spec: {
      name: "bot_talk",
      description:
        "Message another agent: any of the user's bots (by slug) or the main Daebot (to: \"main\"). Say what you need and why. The reply is a CLAIM, not a receipt: verify load-bearing facts in its MIND (mind_query with mind:\"<slug>\"). " +
        "Every pair of agents has one running exchange the user can open and read from the card this call leaves in the chat. wait_for_reply (default true) waits for the answer; false delivers and returns, the answer lands in the exchange. " +
        "A question or info ask needs nothing more. A REQUEST for the other agent to DO something (send, change, post, spend, delete, anything with an effect) is never a blind job: think first with the Decision Protocol (decide, then mind_decision_record in this same turn), then call bot_talk with request:true and decision_receipt:<the id mind_decision_record returned>; without it the call is refused. The agent you ask does its own OOC/EMR before it acts and may decline; a decline is a valid answer. " +
        "One question per call; do not ping-pong, and do not ask again for an answer you already have (even if you must rewrite your reply: reuse it). Limits apply (depth, no loops, no messaging yourself, a budget per user message, 10 messages per exchange until the user speaks). See mind_tenants for the bots.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Slug of the bot to message, or \"main\" for the main Daebot" },
          message: { type: "string", description: "What you need from it, and why" },
          request: { type: "boolean", description: "true when you are asking the other agent to DO something (a task or action), false/omitted for a question or info ask. A request needs decision_receipt." },
          decision_receipt: { type: "string", description: "For request:true: the receipt id returned by mind_decision_record when you filed the decision (why this job, to whom, expected outcome) in THIS turn. Earlier turns' receipts are refused." },
          wait_for_reply: { type: "boolean", description: "Wait for the answer (default true). false = deliver and return; the answer is recorded in the exchange." },
          card: {
            type: "object",
            description: "Delegation: a handoff card for a bounded piece of work. The recipient gets it as five labelled lines and runs on the tier you name (its router floor). Use it whenever you hand a worker bot a piece of a build.",
            properties: {
              objective: { type: "string", description: "What the piece must achieve, one or two sentences" },
              evidence: { type: "array", items: { type: "string" }, description: "Facts and receipts so far: paths, ids, what already works" },
              left: { type: "array", items: { type: "string" }, description: "What is still to do" },
              next: { type: "string", description: "The one thing to do next" },
              verify: { type: "string", description: "How the result is proven (the test, the command, the check)" },
              tier: { type: "string", enum: ["local", "reflex", "light", "coder", "reasoner", "frontier"], description: "The model tier this piece belongs on (build-protocol: trivial/small coder, standard reasoner, large plan frontier)" },
            },
            required: ["objective", "next"],
            additionalProperties: false,
          },
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
      // No blind job issued: a request to DO something carries the receipt of a decision this agent filed in this very turn.
      let decisionReceipt: string | undefined;
      if (args.request === true) {
        const given = typeof args.decision_receipt === "string" ? args.decision_receipt.trim() : "";
        const mine = (ctx.decisions ?? []).filter((d) => !d.declined);
        if (!given) return { ok: false, output: "bot_talk refused: a request for another agent to do something needs a decision receipt. No agent issues a blind job. Run `decide`, file mind_decision_record (why this job, to whom, expected outcome; stance \"act\"), then call bot_talk again with request:true and decision_receipt:<the id it returned>. If you only have a question, send it without request." };
        if (!mine.some((d) => d.id === given)) return { ok: false, output: `bot_talk refused: decision_receipt "${given.slice(0, 80)}" is not a decision you filed in THIS turn (receipts do not carry over between turns, and a declined decision does not count). Run \`decide\`, file mind_decision_record now with stance "act", then retry with the id it returns.` };
        decisionReceipt = given;
      }
      const card = parseCard(args.card);
      if (args.card !== undefined && !card) return { ok: false, output: "bot_talk card needs at least objective and next (strings); evidence and left are lists of strings; tier is one of local, reflex, light, coder, reasoner, frontier" };
      const r = await bus.talk({ owner: o.owner, fromSession: ctx.sessionId, selfBot: o.selfBot, to, message, ...(decisionReceipt ? { decisionReceipt } : {}), ...(card ? { card } : {}), waitForReply: args.wait_for_reply === false ? false : true, signal: ctx.signal });
      return { ok: r.ok, output: r.output, ...(r.exchange ? { meta: { exchange: r.exchange } } : {}) }; // deliberately no meta.costUsd: the recipient turn is already counted in its own session
    },
  };
}
