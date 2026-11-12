// start_voice_agent: a bot (or the main Daebot) opens a live VOICE CHAT with the user, in the Daebot window they are using. It never calls anyone: the
// voice agent is the same bot, talking to the user through their own browser or app microphone. The web client sees this tool's toolStart event in the
// turn and opens the voice chat with the prompt as the conversation's brief. Class "read": it changes nothing; spend is the user's own voice call, capped
// by their account and bot spend caps in MIND.
import type { Tool } from "../types.ts";

export const START_VOICE_AGENT = "start_voice_agent";

export function createStartVoiceAgentTool(): Tool {
  return {
    spec: {
      name: START_VOICE_AGENT,
      description:
        "Open a live voice chat with the user in their Daebot window (their own microphone and speaker; nothing calls any phone). Pass `prompt`: what the voice conversation is for and what you want from it (one to three sentences). " +
        "The voice agent has your voice, your instructions and can read the user's Daebot chats. Use it when talking is better than typing: a long back-and-forth, a decision to talk through, a walkthrough. The conversation's transcript is saved in your thread.",
      parameters: { type: "object", properties: { prompt: { type: "string", description: "What this voice conversation is for, and how it should open." } }, required: ["prompt"], additionalProperties: false },
    },
    class: "read",
    async run(args) {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim().slice(0, 3000) : "";
      if (!prompt) return { ok: false, output: "start_voice_agent: prompt is required" };
      return { ok: true, output: "Voice chat is opening on the user's screen (if a Daebot window is open and they allow the microphone). Their conversation will be saved to this thread when it ends. Do not repeat yourself in text; say one short line that the voice chat is ready." };
    },
  };
}
