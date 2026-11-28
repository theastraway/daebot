// MIND Voice for Daebot (web). Two distinct ways to talk, never mixed up:
//   DICTATION  (mic button / Right Option): speech to text only. The words are typed into the message box at the cursor.
//              Nothing is sent and nothing is read aloud.
//   VOICE      (wave-in-bubble button / Right Command, and the hands-free wave button): you talk to Daebot. The words are
//              SENT when you let go (or stop talking) and the answer is read aloud.
// Each is hold-to-talk, or click to start and click to stop. Also: spoken answers, and a hands-free conversation mode. Spoken answers are
// never the screen text read out: the gateway's speech writer (src/voice/speech.ts) says the gist like a person on a call, details stay on screen. Speech to text and text to speech both go through the gateway (/voice/stt, /voice/tts), which bills the
// signed-in user's own MIND credits. The mascot (m-bot) shows what voice is doing: eyes wide while listening, spinning while
// transcribing, mouth moving with the audio while speaking. No innerHTML; no third-party code; audio never leaves this
// origin except through the gateway.

const REC_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]; // Chrome/Firefox, then iOS/macOS Safari
const MAX_REC_MS = 60_000;          // one utterance
const HOLD_MS = 380;                // press longer than this = hold-to-talk
const SILENCE_MS = 1500;            // click/hands-free: stop this long after speech ends
const NO_SPEECH_MS = 9000;          // nothing said at all: give up listening
const CONVO_NO_SPEECH_MS = 30_000;  // in a call: wait longer before pausing (people think before they talk)
const FILLER_AFTER_MS = 2800;       // a spoken answer not started by then: say "one sec" so the call is never dead air
const FILLERS = ["One sec.", "Let me check.", "On it."];
const END_CALL = /^(?:ok(?:ay)?[, ]+)?(?:bye|goodbye|bye bye|stop|hang up|end (?:the )?call|that'?s all|that'?s it|thanks,? that'?s all)[.!]?$/i;
const MIN_RMS = 0.02;               // speech floor (also scaled by measured room noise)
const MAX_SPOKEN_CHARS = 1200;      // never read a whole essay aloud (bounds credits too)
const BARGE_MS = 420;                // hands-free: this much talking over an answer interrupts it
const BARGE_CALIBRATE_MS = 600;     // ...after measuring the room and speaker echo for this long
const BARGE_MIN_RMS = 0.045;        // a louder floor than listening: speakers leak into the mic
const MAX_REWRITE_CHARS = 40_000;   // the written answer the gateway's speech writer turns into words

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

/** Text of a box after typing `text` at the cursor (or over the selection), with a space on either side only where one is needed. */
export function insertAt(value, start, end, text) {
  const v = String(value || "");
  const a = Math.max(0, Math.min(Number.isInteger(start) ? start : v.length, v.length));
  const b = Math.max(a, Math.min(Number.isInteger(end) ? end : a, v.length));
  const t = String(text || "").trim();
  if (!t) return { value: v, caret: a };
  const before = v.slice(0, a), after = v.slice(b);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const ins = lead + t + trail;
  return { value: before + ins + after, caret: before.length + lead.length + t.length };
}

/**
 * The ONE place a transcript is routed. Dictation inserts and never sends; voice sends. Anything else is treated as dictation
 * (the safe side: words in a box, nothing leaves).
 */
export function deliverTranscript(mode, text, { insert, send }) {
  if (mode === "voice") { send(text); return "sent"; }
  insert(text);
  return "inserted";
}

const rms = (buf) => { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };

/**
 * opts: { els: {mic, speak, convo, dock, status, bars, stop, composer, input}, authHeaders(), onUnauthorized(),
 *         isBusy(), notify(text), creditsChanged(), bots(): HTMLElement[], botSlug(), chatId() }
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
  let voiceTurn = false;            // that message was a VOICE-mode turn: speak the answer even when spoken answers are off
  let mode = "voice";               // dictate | voice: what the mic is doing now (or did last)
  let keyHeld = false;              // a hotkey is currently held down
  const audio = new Audio();
  audio.preload = "auto";
  let playCtx = null, playAn = null, playBuf = null, playSrc = null, playUrl = "", unlocked = false;
  let ticker = 0;

  // ---------- ui ----------
  function bots() { try { return o.bots(); } catch { return []; } }
  function paint() {
    const live = state !== "idle" || convo;
    els.dock.hidden = !live;
    const dictating = live && mode === "dictate";
    els.mic.setAttribute("aria-pressed", String(state === "listening" && mode === "dictate"));
    els.mic.classList.toggle("on", state === "listening" && mode === "dictate");
    if (els.voiceBtn) {
      els.voiceBtn.setAttribute("aria-pressed", String(state === "listening" && mode === "voice"));
      els.voiceBtn.classList.toggle("on", (state === "listening" && mode === "voice") || convo);
    }
    els.dock.dataset.mode = live ? mode : "";
    if (els.pill) {
      els.pill.hidden = !live;
      els.pill.dataset.mode = mode;
      const lab = els.pill.querySelector(".vpill-text"); if (lab) lab.textContent = dictating ? "Dictating…" : "Voice";
      const use = els.pill.querySelector("use"); if (use) use.setAttribute("href", dictating ? "#i-mic" : "#i-voice");
    }
    els.composer.classList.toggle("vm-dictate", dictating);
    els.composer.classList.toggle("vm-voice", live && mode === "voice");
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
      listening: convo ? "Listening… just talk" : mode === "dictate" ? "Listening… release to insert, nothing is sent" : "Listening… release to send",
      transcribing: mode === "dictate" ? "Typing out what you said…" : "Transcribing…",
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
    if (els.voiceBtn) { els.voiceBtn.disabled = true; els.voiceBtn.title = "Voice input is not supported in this browser"; }
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

  // Where the switch actually is: the desktop and phone apps have no "browser settings".
  function micBlockedHelp() {
    const ua = navigator.userAgent || "";
    const app = !!(globalThis.mindclawDesktop || globalThis.Capacitor || globalThis.DaebotAndroid || globalThis.DaebotApp);
    if (!app) return "Microphone access is blocked. Allow it for this site in your browser settings, then try again.";
    if (/Android/i.test(ua)) return "Microphone is off for Daebot. Turn it on in Settings > Apps > Daebot > Permissions > Microphone, then try again.";
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "Microphone is off for Daebot. Turn it on in Settings > Daebot > Microphone, then try again.";
    if (/Mac/i.test(ua)) return "Microphone is off for Daebot. Turn it on in System Settings > Privacy & Security > Microphone, then try again.";
    if (/Windows/i.test(ua)) return "Microphone is off for Daebot. Turn it on in Settings > Privacy & security > Microphone (allow desktop apps), then try again.";
    return "Microphone is off for Daebot. Allow it in your system privacy settings, then try again.";
  }

  // given (barge-in): the open mic stream and the room floor the barge watcher measured. The user is ALREADY talking, so the recorder
  // must not calibrate on their voice (it would never hear them again) and counts them as heard from the first frame.
  async function startListening(how, as = "voice", given) {
    if (!canRecord || unavailable || state === "listening" || state === "transcribing") { if (given) given.stream.getTracks().forEach((t) => t.stop()); return; }
    stopSpeaking();
    mode = as === "dictate" ? "dictate" : "voice";
    let stream = given ? given.stream : null;
    try {
      if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      convo = false; setState("idle");
      return o.notify(e && (e.name === "NotAllowedError" || e.name === "SecurityError") ? micBlockedHelp() : "No microphone was found.");
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
    const r = { mr, stream, ctx, chunks: [], how, mode, t0: performance.now(), heard: !!given, lastVoice: given ? performance.now() : 0, floor: given ? given.floor : 0, calibrated: !!given, samples: 0, discard: false, timer: 0 };
    rec = r;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
    mr.onstop = () => { stopTracks(r); if (rec === r) rec = null; finish(r); };
    mr.start(250);
    setState("listening");
    if (how === "key" && !keyHeld) setTimeout(() => stopListening(), 0); // the key was let go while the mic was opening
    if (how === "hold" && !press.down) { if (press.upT - press.t >= HOLD_MS) setTimeout(() => stopListening(), 0); else r.how = "click"; } // released while the mic was opening
    r.timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      const lvl = rms(buf), now = performance.now();
      setBars(Math.min(1, lvl * 16));
      if (!r.calibrated && now - r.t0 < 350) { r.floor = Math.max(r.floor, lvl); return; } // measure the room first (not after a barge-in)
      const gate = Math.max(MIN_RMS, r.floor * 2.5);
      if (lvl > gate) { r.heard = true; r.lastVoice = now; }
      if (now - r.t0 > MAX_REC_MS) return stopListening();
      if (r.how !== "hold" && r.how !== "key") {
        if (r.heard && now - r.lastVoice > SILENCE_MS) return stopListening();
        if (!r.heard && now - r.t0 > (convo ? CONVO_NO_SPEECH_MS : NO_SPEECH_MS)) { r.discard = true; if (convo) { convo = false; o.notify("Call paused: I did not hear anything for a while. Tap the voice button to pick it up again."); } return stopListening(); }
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
      if (!text) { setState("idle"); bots().forEach((b) => b.flash?.("sad", 1400)); o.notify("I could not make out any words. Try again a little closer to the mic."); return r.mode === "voice" ? convoNext() : undefined; }
      if (r.mode === "voice" && convo && END_CALL.test(text)) { endConvo(); return o.notify("Call ended."); }
      deliverTranscript(r.mode, text, { insert: dictateInto, send: submit });
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

  /** Dictation: type the words into the message box at the cursor. Never sends, never speaks. */
  function dictateInto(text) {
    const box = els.input;
    const r = insertAt(box.value, box.selectionStart, box.selectionEnd, text);
    box.value = r.value;
    try { box.setSelectionRange(r.caret, r.caret); } catch { /* not focusable */ }
    box.dispatchEvent(new Event("input"));
    setState("idle");
    try { box.focus({ preventScroll: true }); } catch { box.focus?.(); }
  }

  function submit(text) {
    if (o.isBusy()) { setState("idle"); els.input.value = text; els.input.dispatchEvent(new Event("input")); return o.notify("Daebot is still answering. Your words are in the box; press Enter to send when it finishes."); }
    els.input.value = text;
    els.input.dispatchEvent(new Event("input"));
    pendingTurn = true; voiceTurn = true;
    setState("thinking");
    chime(); // "got it": the call never sits in dead silence while Daebot works
    clearTimeout(fillerTimer);
    fillerTimer = setTimeout(() => { if (state === "thinking" && pendingTurn) void sayFiller(); }, FILLER_AFTER_MS);
    els.composer.requestSubmit();
  }

  // ---------- filler: "One sec." while Daebot works (fetched once per phrase, then replayed from memory) ----------
  let fillerTimer = 0, fillerN = 0;
  const fillerAudio = new Audio();
  const fillerBlobs = new Map();
  async function sayFiller() {
    const phrase = FILLERS[fillerN++ % FILLERS.length];
    try {
      let url = fillerBlobs.get(phrase);
      if (!url) {
        const res = await fetch("/voice/tts", { method: "POST", credentials: "same-origin", headers: { ...o.authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ text: phrase, ...(o.botSlug ? { bot: o.botSlug() } : {}) }) });
        if (!res.ok) return;
        url = URL.createObjectURL(await res.blob());
        fillerBlobs.set(phrase, url);
      }
      if (state !== "thinking" || !pendingTurn) return; // the answer beat us to it
      fillerAudio.src = url;
      await fillerAudio.play();
    } catch { /* a missing filler is only silence */ }
  }
  function stopFiller() { clearTimeout(fillerTimer); try { fillerAudio.pause(); } catch { /* idle */ } }

  /** A soft two-note "got it" earcon (Web Audio, no file, no credits) when a spoken message is sent. */
  function chime() {
    try {
      const ctx = playCtx && playCtx.state === "running" ? playCtx : null;
      if (!ctx) return;
      const t0 = ctx.currentTime;
      [[660, 0], [880, 0.09]].forEach(([hz, at]) => {
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.type = "sine"; osc.frequency.value = hz;
        g.gain.setValueAtTime(0, t0 + at); g.gain.linearRampToValueAtTime(0.05, t0 + at + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.16);
        osc.connect(g); g.connect(ctx.destination); osc.start(t0 + at); osc.stop(t0 + at + 0.18);
      });
    } catch { /* no audio: silent */ }
  }

  // ---------- speaking ----------
  // ---------- barge-in (hands-free) ----------
  // While an answer plays in hands-free mode, the mic listens (echo-cancelled). Talking over it for BARGE_MS stops the answer and
  // starts listening, like interrupting a person. The first BARGE_CALIBRATE_MS measure the room plus any speaker echo, so the
  // answer itself does not trigger it.
  let barge = null;
  async function startBargeWatch() {
    stopBargeWatch();
    if (!convo || !canRecord || isIOS()) return; // iOS: opening the mic mid-playback moves the audio to the earpiece and drops the volume
    const me = { stream: null, ctx: null, timer: 0, floor: 0, over: 0, t0: performance.now(), dead: false };
    barge = me;
    try { me.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } }); }
    catch { if (barge === me) barge = null; return; }
    if (me.dead || barge !== me || state !== "speaking") { me.stream.getTracks().forEach((t) => t.stop()); return; }
    me.ctx = new AC(); me.ctx.resume?.();
    const an = me.ctx.createAnalyser(); an.fftSize = 1024;
    me.ctx.createMediaStreamSource(me.stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    me.timer = setInterval(() => {
      if (state !== "speaking" || !convo) return stopBargeWatch();
      an.getFloatTimeDomainData(buf);
      const lvl = rms(buf), now = performance.now();
      if (now - me.t0 < BARGE_CALIBRATE_MS) { me.floor = Math.max(me.floor, lvl); return; }
      me.over = lvl > Math.max(BARGE_MIN_RMS, me.floor * 2.2) ? me.over + 60 : Math.max(0, me.over - 30);
      if (me.over >= BARGE_MS) {
        // Hand the open mic to the recorder: no reopen delay, no recalibration on the user's own voice.
        const stream = me.stream; me.stream = null;
        const floor = me.floor * 0.6; // the floor included speaker echo, which stops with the answer
        stopBargeWatch(); stopSpeaking();
        void startListening("convo", "voice", { stream, floor });
      }
    }, 60);
  }
  function isIOS() {
    const ua = navigator.userAgent || "";
    return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }
  function stopBargeWatch() {
    const b = barge; barge = null;
    if (!b) return;
    b.dead = true;
    clearInterval(b.timer);
    try { b.stream && b.stream.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
    try { b.ctx && b.ctx.close(); } catch { /* gone */ }
  }

  function stopSpeaking() {
    stopBargeWatch();
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
    stopFiller();
    // The gateway's speech writer turns the WRITTEN answer into what a person would say on a call (rewrite: true); speakable() is only a
    // pre-check that there is something to say. The full answer stays on screen.
    const raw = String(text || "").trim().slice(0, MAX_REWRITE_CHARS);
    if (!speakable(raw) || unavailable) return convoNext();
    setState("speaking");
    const ac = new AbortController(); abortFetch = ac;
    let blob;
    try {
      const chat = o.chatId ? o.chatId() : "";
      const res = await fetch("/voice/tts", { method: "POST", credentials: "same-origin", signal: ac.signal, headers: { ...o.authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ text: raw, rewrite: true, ...(chat ? { chat } : {}), ...(o.botSlug ? { bot: o.botSlug() } : {}) }) });
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
    audio.onended = () => { stopBargeWatch(); clearInterval(ticker); if (playUrl) { URL.revokeObjectURL(playUrl); playUrl = ""; } setState("idle"); convoNext(); };
    audio.onerror = () => { stopBargeWatch(); clearInterval(ticker); setState("idle"); };
    try { await audio.play(); } catch { setState("idle"); return o.notify("The browser blocked audio playback. Tap the speaker button once, then try again."); }
    void startBargeWatch(); // hands-free: talking over the answer interrupts it
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
  // Mic = DICTATION, voice button = VOICE. Each: press and hold to talk (release ends it); tap to start, silence or a second tap ends it.
  // Keyboard: Enter/Space toggles. The hotkeys (hotkeys.js) call holdStart(mode) / holdEnd().
  const press = { down: false, t: 0, upT: 0, swallow: false };
  function wirePress(btn, as) {
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || btn.disabled) return;
      unlock();
      if (state === "listening") { press.swallow = true; return stopListening(); } // second tap: finish now
      press.down = true; press.t = performance.now(); press.swallow = false;
      startListening("hold", as);
    });
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("click", (e) => {
      if (e.detail !== 0) return; // pointer clicks are handled above
      unlock();
      if (state === "listening") stopListening(); else { startListening("click", as); if (as === "voice") startCall(); }
    });
  }
  const release = () => {
    if (!press.down) return;
    press.down = false; press.upT = performance.now();
    if (rec && rec.how === "hold") {
      if (press.upT - press.t >= HOLD_MS) stopListening(); // held: walkie-talkie, one turn
      else { rec.how = "click"; if (rec.mode === "voice") startCall(); } // tapped: a call that keeps listening after every answer
    }
  };
  /** Phone mode: the voice button was tapped. Answers are spoken and the mic reopens after each one, until stop, Esc, "bye" or silence. */
  function startCall() {
    if (convo) return;
    convo = true; mode = "voice";
    paint();
  }
  wirePress(els.mic, "dictate");
  if (els.voiceBtn) wirePress(els.voiceBtn, "voice");

  /** Hotkey down: open the mic in `as` mode ("dictate" | "voice") until holdEnd(). */
  function holdStart(as) {
    if (!canRecord || unavailable) return;
    if (state === "speaking") stopSpeaking(); // talking over Daebot cuts it off
    else if (state !== "idle") return;       // already listening, transcribing or waiting for an answer
    unlock();
    keyHeld = true;
    startListening("key", as);
  }
  /** Hotkey up: stop and deliver (dictation inserts, voice sends). */
  function holdEnd() {
    keyHeld = false;
    if (rec && rec.how === "key") stopListening();
  }

  els.speak.addEventListener("click", () => {
    unlock();
    speakOn = !speakOn; prefs.set("daebot:speak", speakOn ? "1" : "0");
    if (!speakOn) { stopSpeaking(); if (convo) endConvo(); }
    paint();
  });
  els.convo.addEventListener("click", () => {
    unlock();
    if (convo) return endConvo();
    convo = true; speakOn = true; mode = "voice"; prefs.set("daebot:speak", "1");
    paint();
    startListening("convo");
  });
  els.stop.addEventListener("click", () => cancel());

  function endConvo() { convo = false; cancel(); }
  function cancel() {
    stopFiller();
    pendingTurn = false; voiceTurn = false; keyHeld = false;
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
    turnStart(viaVoice) { if (!viaVoice && !pendingTurn) { voiceTurn = false; stopSpeaking(); if (convo) { convo = false; cancel(); } } },
    /** The answer finished streaming. Speak it when spoken answers are on (or this turn came from the mic in a convo). */
    turnDone(text) {
      const wasVoice = pendingTurn; pendingTurn = false;
      const forced = voiceTurn && wasVoice; voiceTurn = false; // a VOICE-mode turn is always answered aloud
      if (state === "thinking") setState("idle");
      if (!(speakOn || convo || forced) || unavailable) { if (convo) convoNext(); return; }
      if (!wasVoice && !speakOn) return;
      if (text && text.trim()) speak(text); else convoNext();
    },
    cancel,
    /** This turn's answer will be read aloud (a voice send, a call, or spoken answers on): the server answers like a person on a call. */
    spokenTurn: () => pendingTurn || convo || speakOn,
    holdStart,
    holdEnd,
    mode: () => mode,
    state: () => state,
    isConvo: () => convo,
  };
}
