// MIND Voice for Daebot (web). Mic button (hold, or click to start and click to stop), spoken answers, and a hands-free
// conversation mode. Speech to text and text to speech both go through the gateway (/voice/stt, /voice/tts), which bills the
// signed-in user's own MIND credits. The mascot (m-bot) shows what voice is doing: eyes wide while listening, spinning while
// transcribing, mouth moving with the audio while speaking. No innerHTML; no third-party code; audio never leaves this
// origin except through the gateway.

const REC_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]; // Chrome/Firefox, then iOS/macOS Safari
const MAX_REC_MS = 60_000;          // one utterance
const HOLD_MS = 380;                // press longer than this = hold-to-talk
const SILENCE_MS = 1500;            // click/hands-free: stop this long after speech ends
const NO_SPEECH_MS = 9000;          // nothing said at all: give up listening
const MIN_RMS = 0.02;               // speech floor (also scaled by measured room noise)
const MAX_SPOKEN_CHARS = 1200;      // never read a whole essay aloud (bounds credits too)

export const MOOD = { idle: "idle", listening: "wow", transcribing: "think", thinking: "think", speaking: "talk" };

/** Markdown answer -> plain text to read aloud: no code, no URLs, no list/heading marks, capped at a sentence. */
export function speakable(md, max = MAX_SPOKEN_CHARS) {
  let t = String(md || "")
    .replace(/```[\s\S]*?(```|$)/g, " (code omitted) ")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]\n]+)\]\((?:https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\.\s*\./g, ".")
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = (end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "")).trim();
  }
  return t;
}

export function pickRecorderType(MR = globalThis.MediaRecorder) {
  if (!MR) return "";
  if (typeof MR.isTypeSupported !== "function") return "";
  return REC_TYPES.find((t) => { try { return MR.isTypeSupported(t); } catch { return false; } }) || "";
}

/** 0.2s of silence as a WAV blob: played inside a tap to unlock audio on iOS (data: URIs are not allowed by our CSP). */
function silentWav() {
  const n = 1600, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  return new Blob([buf], { type: "audio/wav" });
}

const rms = (buf) => { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };

/**
 * opts: { els: {mic, speak, convo, dock, status, bars, stop, composer, input}, authHeaders(), onUnauthorized(),
 *         isBusy(), notify(text), creditsChanged(), bots(): HTMLElement[] }
 * returns { turnStart(), turnDone(text), cancel(), state() }
 */
export function initVoice(o) {
  const { els } = o;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const recType = pickRecorderType();
  const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && globalThis.MediaRecorder && AC);
  const prefs = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  let state = "idle";               // idle | listening | transcribing | thinking | speaking
  let unavailable = "";             // set once MIND says voice is off / key rejected: stops retrying
  let speakOn = prefs.get("daebot:speak") === "1";
  let convo = false;                // hands-free conversation mode
  let rec = null;                   // active recording { mr, stream, ctx, chunks, timer, ... }
  let abortFetch = null;            // in-flight stt/tts fetch
  let pendingTurn = false;          // a voice message is out; its answer should be spoken
  const audio = new Audio();
  audio.preload = "auto";
  let playCtx = null, playAn = null, playBuf = null, playSrc = null, playUrl = "", unlocked = false;
  let ticker = 0;

  // ---------- ui ----------
  function bots() { try { return o.bots(); } catch { return []; } }
  function paint() {
    const live = state !== "idle" || convo;
    els.dock.hidden = !live;
    els.mic.setAttribute("aria-pressed", String(state === "listening"));
    els.mic.classList.toggle("on", state === "listening");
    els.speak.setAttribute("aria-pressed", String(speakOn));
    els.speak.classList.toggle("on", speakOn);
    els.speak.querySelector("use").setAttribute("href", speakOn ? "#i-speaker" : "#i-speaker-off");
    els.speak.setAttribute("aria-label", speakOn ? "Spoken answers on" : "Spoken answers off");
    els.speak.title = speakOn ? "Spoken answers on (uses MIND credits)" : "Read answers aloud (uses MIND credits)";
    els.convo.setAttribute("aria-pressed", String(convo));
    els.convo.classList.toggle("on", convo);
    els.convo.title = convo ? "End conversation (Esc)" : "Hands-free conversation (uses MIND credits)";
    els.dock.dataset.state = state;
    const text = {
      idle: convo ? "Your turn. Say something." : "",
      listening: convo ? "Listening… just talk" : "Listening… release or tap to send",
      transcribing: "Transcribing…",
      thinking: "Thinking…",
      speaking: "Speaking… Esc to stop",
    }[state];
    els.status.textContent = text;
    const mood = MOOD[state];
    for (const b of bots()) if (b.mood !== mood && (live || b.mood === "wow")) b.mood = mood;
    const dockEl = document.querySelector(".bot-dock");
    if (dockEl) dockEl.classList.toggle("voice-live", live && !document.querySelector(".hero-bot")); // the empty screen already has a big bot
    document.documentElement.classList.toggle("voice-active", live);
    if (!live) setBars(0);
  }
  function setState(s) { state = s; paint(); }
  function setBars(level) {
    els.bars.forEach((b, i) => {
      const k = Math.max(0.2, Math.min(1, level * (1 + Math.sin((i + 1) * 1.7 + performance.now() / 120) * 0.35)));
      b.style.setProperty("transform", `scaleY(${k.toFixed(2)})`);
    });
  }
  if (!canRecord) {
    els.mic.disabled = true;
    els.mic.title = "Voice input is not supported in this browser";
    els.convo.disabled = true;
    els.convo.title = "Hands-free needs microphone support";
  }

  // ---------- audio unlock (iOS needs playback to start inside a tap) ----------
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    try {
      const url = URL.createObjectURL(silentWav());
      audio.src = url;
      const p = audio.play();
      const done = () => { audio.pause(); URL.revokeObjectURL(url); };
      if (p && p.then) p.then(done, done); else done();
    } catch { /* playback will retry on its own */ }
    try { if (AC) { playCtx = playCtx || new AC(); playCtx.resume?.(); } } catch { /* analyser is optional */ }
  }

  // ---------- recording ----------
  function stopTracks(r) {
    try { r.stream.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
    try { r.ctx.close(); } catch { /* gone */ }
    clearInterval(r.timer);
  }

  async function startListening(how) {
    if (!canRecord || unavailable || state === "listening" || state === "transcribing") return;
    stopSpeaking();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      convo = false; setState("idle");
      return o.notify(e && (e.name === "NotAllowedError" || e.name === "SecurityError")
        ? "Microphone access is blocked. Allow it for this site in your browser settings, then try again."
        : "No microphone was found.");
    }
    if (state === "listening") { stream.getTracks().forEach((t) => t.stop()); return; }
    const ctx = new AC();
    ctx.resume?.();
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let mr;
    try { mr = recType ? new MediaRecorder(stream, { mimeType: recType }) : new MediaRecorder(stream); }
    catch { stream.getTracks().forEach((t) => t.stop()); ctx.close?.(); convo = false; setState("idle"); return o.notify("This browser could not start recording."); }
    const r = { mr, stream, ctx, chunks: [], how, t0: performance.now(), heard: false, lastVoice: 0, floor: 0, samples: 0, discard: false, timer: 0 };
    rec = r;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
    mr.onstop = () => { stopTracks(r); if (rec === r) rec = null; finish(r); };
    mr.start(250);
    setState("listening");
    if (how === "hold" && !press.down) { if (press.upT - press.t >= HOLD_MS) setTimeout(() => stopListening(), 0); else r.how = "click"; } // released while the mic was opening
    r.timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      const lvl = rms(buf), now = performance.now();
      setBars(Math.min(1, lvl * 16));
      if (now - r.t0 < 350) { r.floor = Math.max(r.floor, lvl); return; } // measure the room first
      const gate = Math.max(MIN_RMS, r.floor * 2.5);
      if (lvl > gate) { r.heard = true; r.lastVoice = now; }
      if (now - r.t0 > MAX_REC_MS) return stopListening();
      if (r.how !== "hold") {
        if (r.heard && now - r.lastVoice > SILENCE_MS) return stopListening();
        if (!r.heard && now - r.t0 > NO_SPEECH_MS) { r.discard = true; if (convo) { convo = false; o.notify("Hands-free paused: I did not hear anything. Tap the wave button to continue."); } return stopListening(); }
      }
    }, 60);
  }

  function stopListening(discard = false) {
    const r = rec;
    if (!r) return;
    if (discard) r.discard = true;
    if (r.mr.state !== "inactive") { try { r.mr.stop(); } catch { stopTracks(r); rec = null; setState("idle"); } }
  }

  async function finish(r) {
    if (r.discard || !r.chunks.length) { if (!r.discard && !r.heard) o.notify("I did not hear anything."); return setState("idle"); }
    const blob = new Blob(r.chunks, { type: r.mr.mimeType || recType || "audio/webm" });
    if (blob.size < 1500) { setState("idle"); return o.notify("That was too short to transcribe."); }
    setState("transcribing");
    const ac = new AbortController(); abortFetch = ac;
    try {
      const lang = (navigator.language || "").split("-")[0];
      const res = await fetch(`/voice/stt${/^[a-z]{2,3}$/.test(lang) ? `?lang=${lang}` : ""}`, {
        method: "POST", credentials: "same-origin", signal: ac.signal,
        headers: { ...o.authHeaders(), "content-type": blob.type },
        body: blob,
      });
      abortFetch = null;
      if (!(await okOrExplain(res))) return setState("idle");
      const j = await res.json().catch(() => ({}));
      o.creditsChanged();
      const text = (j.text || "").trim();
      if (!text) { setState("idle"); bots().forEach((b) => b.flash?.("sad", 1400)); o.notify("I could not make out any words. Try again a little closer to the mic."); return convoNext(); }
      submit(text);
    } catch (e) {
      abortFetch = null;
      if (e && e.name === "AbortError") return setState("idle");
      setState("idle");
      o.notify("Voice lost its connection. Try again.");
    }
  }

  /** Turns a non-2xx voice response into one clear line for the user. */
  async function okOrExplain(res) {
    if (res.ok) return true;
    if (res.status === 401) { o.onUnauthorized(); return false; }
    const j = await res.json().catch(() => ({}));
    if (res.status === 402) {
      convo = false;
      o.notify(`${j.message || "Not enough MIND credits for voice."}${j.upgradeUrl ? ` Top up: ${j.upgradeUrl}` : ""}`);
    } else if (res.status === 503 || res.status === 404) {
      unavailable = j.message || "MIND voice is not available right now.";
      convo = false; speakOn = false;
      els.mic.title = els.speak.title = unavailable;
      o.notify(unavailable);
    } else if (res.status === 429) {
      o.notify(j.message || "Slow down a little: too many voice requests.");
    } else {
      o.notify(j.message || "Voice could not finish that request.");
    }
    return false;
  }

  function submit(text) {
    if (o.isBusy()) { setState("idle"); els.input.value = text; els.input.dispatchEvent(new Event("input")); return o.notify("Daebot is still answering. Your words are in the box; press Enter to send when it finishes."); }
    els.input.value = text;
    els.input.dispatchEvent(new Event("input"));
    pendingTurn = true;
    setState("thinking");
    els.composer.requestSubmit();
  }

  // ---------- speaking ----------
  function stopSpeaking() {
    if (abortFetch && state === "speaking") { abortFetch.abort(); abortFetch = null; }
    try { audio.pause(); } catch { /* idle */ }
    if (playUrl) { URL.revokeObjectURL(playUrl); playUrl = ""; }
    clearInterval(ticker);
    if (state === "speaking") setState("idle");
  }

  function wireAnalyser() {
    if (playSrc || !playCtx || playCtx.state !== "running") return; // suspended context would mute the audio on iOS: use pulses instead
    try {
      playSrc = playCtx.createMediaElementSource(audio);
      playAn = playCtx.createAnalyser(); playAn.fftSize = 512; playBuf = new Float32Array(playAn.fftSize);
      playSrc.connect(playAn); playAn.connect(playCtx.destination);
    } catch { playSrc = null; playAn = null; }
  }

  async function speak(text) {
    const t = speakable(text);
    if (!t || unavailable) return convoNext();
    setState("speaking");
    const ac = new AbortController(); abortFetch = ac;
    let blob;
    try {
      const res = await fetch("/voice/tts", { method: "POST", credentials: "same-origin", signal: ac.signal, headers: { ...o.authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ text: t }) });
      if (!(await okOrExplain(res))) { abortFetch = null; return setState("idle"); }
      blob = await res.blob();
      o.creditsChanged();
    } catch (e) {
      abortFetch = null;
      if (e && e.name === "AbortError") return;
      setState("idle"); return o.notify("Could not fetch the spoken answer.");
    }
    abortFetch = null;
    if (state !== "speaking") return; // cancelled while downloading
    if (playUrl) URL.revokeObjectURL(playUrl);
    playUrl = URL.createObjectURL(blob);
    audio.src = playUrl;
    wireAnalyser();
    audio.onended = () => { clearInterval(ticker); if (playUrl) { URL.revokeObjectURL(playUrl); playUrl = ""; } setState("idle"); convoNext(); };
    audio.onerror = () => { clearInterval(ticker); setState("idle"); };
    try { await audio.play(); } catch { setState("idle"); return o.notify("The browser blocked audio playback. Tap the speaker button once, then try again."); }
    ticker = setInterval(() => {
      // mouth follows the actual sound when we can read it, else a steady pulse while playing
      let lvl = 0.5;
      if (playAn) { playAn.getFloatTimeDomainData(playBuf); lvl = Math.min(1, rms(playBuf) * 6); if (lvl > 0.06) bots().forEach((b) => b.say?.(160)); }
      else if (!audio.paused) bots().forEach((b) => b.say?.(160));
      setBars(lvl);
      const mood = MOOD.speaking;
      bots().forEach((b) => { if (b.mood !== mood) b.mood = mood; });
    }, 70);
  }

  function convoNext() { if (convo && state === "idle") setTimeout(() => { if (convo && state === "idle" && !o.isBusy()) startListening("convo"); }, 350); }

  // ---------- controls ----------
  // Mic: press and hold to talk (release sends); tap to start, silence or a second tap ends it. Keyboard: Enter/Space toggles.
  const press = { down: false, t: 0, upT: 0, swallow: false };
  els.mic.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || els.mic.disabled) return;
    unlock();
    if (state === "listening") { press.swallow = true; return stopListening(); } // second tap: send now
    press.down = true; press.t = performance.now(); press.swallow = false;
    startListening("hold");
  });
  const release = () => {
    if (!press.down) return;
    press.down = false; press.upT = performance.now();
    if (rec && rec.how === "hold") { if (press.upT - press.t >= HOLD_MS) stopListening(); else rec.how = "click"; }
  };
  els.mic.addEventListener("pointerup", release);
  els.mic.addEventListener("pointercancel", release);
  els.mic.addEventListener("click", (e) => {
    if (e.detail !== 0) return; // pointer clicks are handled above
    unlock();
    if (state === "listening") stopListening(); else startListening("click");
  });

  els.speak.addEventListener("click", () => {
    unlock();
    speakOn = !speakOn; prefs.set("daebot:speak", speakOn ? "1" : "0");
    if (!speakOn) { stopSpeaking(); if (convo) endConvo(); }
    paint();
  });
  els.convo.addEventListener("click", () => {
    unlock();
    if (convo) return endConvo();
    convo = true; speakOn = true; prefs.set("daebot:speak", "1");
    paint();
    startListening("convo");
  });
  els.stop.addEventListener("click", () => cancel());

  function endConvo() { convo = false; cancel(); }
  function cancel() {
    pendingTurn = false;
    if (abortFetch) { abortFetch.abort(); abortFetch = null; }
    stopListening(true);
    stopSpeaking();
    if (state !== "idle") setState("idle"); else paint();
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state === "idle" && !convo) return;
    if (state === "thinking") { /* Esc also aborts the turn (app.js handles it); leave voice mode */ convo = false; pendingTurn = false; setState("idle"); return; }
    e.preventDefault(); e.stopImmediatePropagation();
    convo = false;
    cancel();
  }, true);
  addEventListener("pagehide", () => cancel());

  paint();

  return {
    /** A typed message was sent: do not read it back as a voice turn. */
    turnStart(viaVoice) { if (!viaVoice && !pendingTurn) { stopSpeaking(); if (convo) { convo = false; cancel(); } } },
    /** The answer finished streaming. Speak it when spoken answers are on (or this turn came from the mic in a convo). */
    turnDone(text) {
      const wasVoice = pendingTurn; pendingTurn = false;
      if (state === "thinking") setState("idle");
      if (!(speakOn || convo) || unavailable) { if (convo) convoNext(); return; }
      if (!wasVoice && !speakOn) return;
      if (text && text.trim()) speak(text); else convoNext();
    },
    cancel,
    state: () => state,
    isConvo: () => convo,
  };
}
