// Chat events → ElevenLabs client messages for a live voice call. Pure: no DOM, no network.
// A typed user message is silent context. A leading "!" or send-with-interrupt while the agent is speaking
// is a real turn (user_message) and the caller stops playback. The agent's own chat_post is assistant text
// and must not be sent back into the call.

const AGENT_KINDS = new Set(["assistant", "agent", "text"]);
const MAX_DONE_CHARS = 2500;
/** Prefix of a request the voice agent itself handed Daebot (src/gateway/voiceagent.ts VOICE_MARK). Never echoed back into the call. */
export const VOICE_MARK = "🎙️ ";
export const fromVoice = (text) => typeof text === "string" && text.startsWith(VOICE_MARK.trim());

/**
 * @param {{ type?: string, kind?: string, role?: string, text?: string, delta?: string, interrupt?: boolean, fromAgent?: boolean }} ev
 * @param {{ speaking?: boolean }} [opts]
 * A { type: "daebot_done", text } event (Daebot finished a reply in the bound chat) becomes a contextual_update tagged [Daebot finished].
 * @returns {{ type: "contextual_update" | "user_message", text: string, stopPlayback?: boolean } | null}
 */
export function chatEventToCall(ev, opts) {
  if (!ev || typeof ev !== "object") return null;
  if (ev.fromAgent === true) return null;
  const kind = typeof ev.type === "string" ? ev.type : (typeof ev.kind === "string" ? ev.kind : (typeof ev.role === "string" ? ev.role : ""));
  // Daebot (the work brain) finished a reply in the call's chat: the voice agent gets it as silent context, to tell the user in its own words.
  if (kind === "daebot_done") {
    if (ev.viaVoice === true) return null; // the agent asked for it: the answer reaches it through ask_daebot / check_daebot
    const done = typeof ev.text === "string" ? ev.text.trim() : "";
    return done ? { type: "contextual_update", text: "[Daebot finished] " + (done.length > MAX_DONE_CHARS ? done.slice(0, MAX_DONE_CHARS) + " …(the rest is in the chat)" : done) } : null;
  }
  if (AGENT_KINDS.has(kind)) return null;
  if (kind !== "user") return null;
  const text = typeof ev.text === "string" ? ev.text.trim() : "";
  if (!text || fromVoice(text)) return null; // the agent's own ask_daebot request, replayed into the chat
  const speaking = !!(opts && opts.speaking);
  // "!" is the typed barge-in. The interrupt flag only barges in while audio is playing (the send button during speech).
  if (text.startsWith("!") || (ev.interrupt === true && speaking)) return { type: "user_message", text, stopPlayback: true };
  return { type: "contextual_update", text: "User typed in chat: " + text };
}

/** Hand one chat event to an open call. `send` receives only the ElevenLabs message. Returns false when the event is ignored. */
export function forwardChatEvent(ev, opts) {
  const msg = chatEventToCall(ev, opts);
  if (!msg || !opts || typeof opts.send !== "function") return false;
  opts.send({ type: msg.type, text: msg.text });
  if (msg.stopPlayback && typeof opts.stopPlayback === "function") opts.stopPlayback();
  return true;
}
