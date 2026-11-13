// Voice chat (web): a live ElevenLabs Conversational AI agent per bot. The gateway asks MIND for a session (MIND holds the ElevenLabs key, checks the spend caps and bills
// the call) and hands back a SIGNED wss URL; the browser talks to ElevenLabs directly over it (microphone as 16 kHz PCM up, the agent's voice as 16 kHz PCM down).
// When it ends the gateway saves the transcript into the bot's thread. No third-party code, no innerHTML; the key never reaches the browser.
//
// TODO(live-chat): forward new messages of the bound chat into the open socket. There is no session-wide event hook.
// Live events exist only inside a turn: web/app.js sendMessage (~the local user item, before the SSE read) and attachRun's
// handle() when ev.type === "user". Idle updates arrive as a whole-transcript replace in reconcile/syncCurrent (web/sync.js),
// which has no per-message callback. When one of those runs for voiceChat.chatId(), call voiceChat.onChatEvent(ev) with
// { type: "user", text, interrupt } for a person typing, and do not call it for this agent's own posts (type "text" / assistant):
// onChatEvent sends contextual_update or user_message and stops playback on an interrupt. See web/voicechat-bridge.js.

import { forwardChatEvent } from "./voicechat-bridge.js";

export const RATE = 16000;

/** Float samples (-1..1) -> little-endian 16-bit PCM bytes, base64. */
export function floatToPcm16Base64(f32) {
  const out = new Uint8Array(f32.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); v.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  let bin = ""; for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  return btoa(bin);
}
/** base64 little-endian 16-bit PCM -> float samples. */
export function pcm16Base64ToFloat(b64) {
  const bin = atob(b64); const n = bin.length >> 1; const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8); if (s & 0x8000) s -= 0x10000; out[i] = s / 0x8000; }
  return out;
}
/** What one ElevenLabs socket message means for the UI. Unknown or malformed messages are ignored (undefined). */
export function parseEvent(raw) {
  let m; try { m = JSON.parse(raw); } catch { return undefined; }
  if (!m || typeof m !== "object") return undefined;
  switch (m.type) {
    case "conversation_initiation_metadata": { const e = m.conversation_initiation_metadata_event || {}; return { kind: "start", conversationId: typeof e.conversation_id === "string" ? e.conversation_id : "" }; }
    case "audio": { const a = m.audio_event && m.audio_event.audio_base_64; return typeof a === "string" ? { kind: "audio", audio: a } : undefined; }
    case "user_transcript": { const t = m.user_transcription_event && m.user_transcription_event.user_transcript; return typeof t === "string" && t ? { kind: "user", text: t } : undefined; }
    case "agent_response": { const t = m.agent_response_event && m.agent_response_event.agent_response; return typeof t === "string" && t ? { kind: "agent", text: t } : undefined; }
    case "interruption": return { kind: "interrupt" };
    case "ping": return { kind: "ping", id: m.ping_event && m.ping_event.event_id, ms: (m.ping_event && m.ping_event.ping_ms) || 0 };
    default: return undefined;
  }
}

/** opts: { api(path, init), els: { dock, status, stop, bars }, notify(text), botSlug(), chatId()? , onSaved(sessionId) } */
export function initVoiceAgent(o) {
  const { els } = o;
  let live = null;     // { ws, ctx, stream, node, play, sources:Set, conversationId, slug, startedAt, ended }
  const say = (t) => { if (els.status) els.status.textContent = t; };
  const show = (on) => { if (els.dock) els.dock.hidden = !on; };
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && AC && globalThis.WebSocket && globalThis.AudioWorkletNode);

  function stopPlayback(l) { for (const s of l.sources) { try { s.stop(); } catch { /* already ended */ } } l.sources.clear(); l.playAt = 0; }
  function playChunk(l, b64) {
    const f = pcm16Base64ToFloat(b64);
    const buf = l.play.createBuffer(1, f.length, RATE);
    buf.copyToChannel(f, 0);
    const src = l.play.createBufferSource(); src.buffer = buf; src.connect(l.play.destination);
    const at = Math.max(l.play.currentTime + 0.02, l.playAt || 0);
    src.start(at); l.playAt = at + buf.duration;
    l.sources.add(src); src.onended = () => { l.sources.delete(src); if (!l.sources.size && !l.ended) say("Listening…"); };
    say("Speaking…");
  }

  async function start(prompt) {
    if (live) return { ok: false, reason: "busy" };
    if (!supported) { o.notify("Voice chat needs a browser with microphone access."); return { ok: false, reason: "unsupported" }; }
    const slug = o.botSlug();
    const chat = typeof o.chatId === "function" ? o.chatId() : undefined;
    show(true); say("Starting voice chat…");
    let sess;
    try {
      const res = await o.api("/voice/agent/session", { method: "POST", body: JSON.stringify({ bot: slug, ...(prompt ? { prompt } : {}), ...(chat ? { chat } : {}) }) });
      sess = await res.json().catch(() => ({}));
      if (!res.ok) { show(false); o.notify(sess.message || "Voice chat could not start."); return { ok: false, reason: sess.error || "failed" }; }
    } catch (e) { show(false); if (e.message !== "unauthorized") o.notify("Voice chat could not start."); return { ok: false, reason: "failed" }; }
    let stream, ctx, play;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      ctx = new AC({ sampleRate: RATE }); play = new AC({ sampleRate: RATE });
      await ctx.audioWorklet.addModule("/voiceagent-worklet.js");
      await ctx.resume(); await play.resume();
    } catch (e) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      show(false); o.notify("Voice chat needs the microphone. Allow it for this site and try again.");
      void finish({ slug, conversationId: "", ctx: null, play: null, sources: new Set(), ended: true }, true);
      return { ok: false, reason: "mic" };
    }
    const ws = new WebSocket(sess.signedUrl);
    const l = { ws, ctx, play, stream, sources: new Set(), playAt: 0, conversationId: "", slug, startedAt: Date.now(), ended: false, node: null, botName: sess.botName || "", chatId: typeof sess.chatId === "string" ? sess.chatId : (chat || "") };
    live = l;
    const src = ctx.createMediaStreamSource(stream);
    l.node = new AudioWorkletNode(ctx, "daebot-capture");
    src.connect(l.node);
    l.node.port.onmessage = (ev) => { if (ws.readyState === 1 && !l.ended) ws.send(JSON.stringify({ user_audio_chunk: floatToPcm16Base64(ev.data) })); };
    ws.onopen = () => { ws.send(JSON.stringify({ type: "conversation_initiation_client_data" })); say("Listening…"); };
    ws.onmessage = (ev) => {
      const e = parseEvent(typeof ev.data === "string" ? ev.data : "");
      if (!e) return;
      if (e.kind === "start") l.conversationId = e.conversationId;
      else if (e.kind === "audio") playChunk(l, e.audio);
      else if (e.kind === "interrupt") { stopPlayback(l); say("Listening…"); }
      else if (e.kind === "ping") setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "pong", event_id: e.id })); }, e.ms || 0);
      else if (e.kind === "user") say(`You: ${e.text.slice(0, 120)}`);
      else if (e.kind === "agent") say(`${l.botName || "Bot"}: ${e.text.slice(0, 120)}`);
    };
    ws.onclose = () => { if (live === l) void finish(l, false); };
    ws.onerror = () => { if (live === l) say("Connection problem."); };
    const cap = setTimeout(() => { if (live === l) void finish(l, false); }, (sess.maxSeconds || 900) * 1000 + 5000);
    l.cap = cap;
    return { ok: true };
  }

  async function finish(l, silent) {
    if (l.finishing) return; l.finishing = true;
    l.ended = true; clearTimeout(l.cap);
    if (live === l) live = null;
    try { l.ws && l.ws.close(); } catch { /* closed */ }
    try { l.node && l.node.disconnect(); } catch { /* gone */ }
    if (l.stream) l.stream.getTracks().forEach((t) => t.stop());
    if (l.sources) stopPlayback(l);
    try { l.ctx && l.ctx.close(); } catch { /* closed */ }
    try { l.play && l.play.close(); } catch { /* closed */ }
    say("Saving the conversation…");
    let saved = null;
    for (let i = 0; i < 4 && !saved; i++) {
      try {
        const res = await o.api("/voice/agent/finish", { method: "POST", body: JSON.stringify({ bot: l.slug, conversationId: l.conversationId || undefined }) });
        if (res.status === 202) { await new Promise((r) => setTimeout(r, 3000)); continue; }
        const j = await res.json().catch(() => ({}));
        if (res.ok) saved = j; else break;
      } catch (e) { if (e.message === "unauthorized") break; }
    }
    show(false); say("");
    if (!silent && saved && saved.sessionId) { o.notify("Voice chat saved to this bot's threads."); if (o.onSaved) o.onSaved(saved.sessionId); }
    else if (!silent && saved && !saved.lines) o.notify("Voice chat ended. Nothing was said.");
  }

  // A chat event for the bound session. Not called yet: see the TODO at the top of this file.
  function onChatEvent(ev) {
    const l = live;
    if (!l || l.ended || !l.ws || l.ws.readyState !== 1) return false;
    return forwardChatEvent(ev, {
      speaking: l.sources.size > 0,
      send: (m) => l.ws.send(JSON.stringify(m)),
      stopPlayback: () => { stopPlayback(l); say("Listening…"); },
    });
  }

  els.stop && els.stop.addEventListener("click", () => { if (live) void finish(live, false); });
  addEventListener("pagehide", () => { if (live) { try { live.ws.close(); } catch { /* closed */ } } });
  return { start, stop: () => { if (live) void finish(live, false); }, active: () => !!live, supported, onChatEvent, chatId: () => (live && live.chatId) || "" };
}
