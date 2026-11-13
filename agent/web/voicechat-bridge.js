// Chat events → ElevenLabs client messages for a live voice call. Pure: no DOM, no network.
// A typed user message is silent context. A leading "!" or send-with-interrupt while the agent is speaking
// is a real turn (user_message) and the caller stops playback. The agent's own chat_post is assistant text
// and must not be sent back into the call.

const AGENT_KINDS = new Set(["assistant", "agent", "text"]);

/**
 * @param {{ type?: string, kind?: string, role?: string, text?: string, delta?: string, interrupt?: boolean, fromAgent?: boolean }} ev
 * @param {{ speaking?: boolean }} [opts]
 * @returns {{ type: "contextual_update" | "user_message", text: string, stopPlayback?: boolean } | null}
 */
export function chatEventToCall(ev, opts) {
  if (!ev || typeof ev !== "object") return null;
  if (ev.fromAgent === true) return null;
  const kind = typeof ev.type === "string" ? ev.type : (typeof ev.kind === "string" ? ev.kind : (typeof ev.role === "string" ? ev.role : ""));
  if (AGENT_KINDS.has(kind)) return null;
  if (kind !== "user") return null;
  const text = typeof ev.text === "string" ? ev.text.trim() : "";
  if (!text) return null;
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
