// Per-bot voice settings (the Voice section of a bot's settings drawer). The settings ride the bot record (PATCH /bots/:id {voice}) so they sync to
// every device; spoken replies of that bot use them (voice.js sends the bot slug with /voice/tts and the gateway looks the settings up).
// Voices and models come from ElevenLabs through MIND (/voice/voices, /voice/models); a preview speaks a short line with the form's CURRENT values,
// saved or not. No innerHTML.

export const DEFAULTS = { speed: 1, stability: 0.5, similarityBoost: 0.75, style: 0, useSpeakerBoost: true };
export const DEFAULT_MODEL_NOTE = "Default (Flash v2.5)";
export const SLIDERS = [
  { key: "speed", id: "bv-speed", min: 0.7, max: 1.2, step: 0.05 },
  { key: "stability", id: "bv-stab", min: 0, max: 1, step: 0.05 },
  { key: "similarityBoost", id: "bv-sim", min: 0, max: 1, step: 0.05 },
  { key: "style", id: "bv-style", min: 0, max: 1, step: 0.05 },
];

/** "Rachel · american, female" for the pick list. */
export function voiceLabel(v) {
  const l = v.labels || {};
  const bits = [l.accent, l.gender, l.age, l.use_case].filter(Boolean).slice(0, 3);
  return bits.length ? `${v.name} · ${bits.join(", ")}` : v.name;
}

/** Only the fields the person actually set; null when there is nothing (clears the bot's voice). */
export function voiceToSave(draft) {
  const o = {};
  for (const k of ["voiceId", "voiceName", "model", "speed", "stability", "similarityBoost", "style", "useSpeakerBoost", "language", "outputFormat", "agentLlm", "agentFirstMessage", "agentPrompt"]) if (draft[k] !== undefined && draft[k] !== "") o[k] = draft[k];
  return Object.keys(o).length ? o : null;
}

export function voiceSummary(v) {
  if (!v) return "Default voice";
  const bits = [v.voiceName || (v.voiceId ? "Custom voice" : "Default voice")];
  if (v.speed && v.speed !== 1) bits.push(`${v.speed}x`);
  return bits.join(" · ");
}

export function initBotVoice({ api, botOf, drawerBot, onSaved, notify }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    sec: $("bd-voice-sec"), search: $("bv-search"), scope: $("bv-scope"), voice: $("bv-voice"), model: $("bv-model"), boost: $("bv-boost"),
    allm: $("bv-allm"), first: $("bv-first"), aprompt: $("bv-aprompt"), lang: $("bv-lang"), fmt: $("bv-format"), preview: $("bv-preview"), save: $("bv-save"), reset: $("bv-reset"), state: $("bv-state"), summary: $("bv-summary"),
  };
  if (!el.sec || !el.voice) return { paint() {} };
  let draft = {};
  let models = [], modelsLoaded = false, voices = [], searchTimer = 0, seq = 0, audio = null, dirty = false;

  const say = (t, warn) => { el.state.textContent = t || ""; el.state.classList.toggle("warn", !!warn); };
  const option = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; return o; };
  const setDirty = (d) => { dirty = d; el.save.disabled = !d; if (d) say("Unsaved changes"); };

  function paintSliders() {
    for (const s of SLIDERS) {
      const input = $(s.id), out = $(`${s.id}-out`);
      const v = draft[s.key] !== undefined ? draft[s.key] : DEFAULTS[s.key];
      input.value = String(v); if (out) out.textContent = String(v);
    }
    el.boost.checked = draft.useSpeakerBoost !== undefined ? !!draft.useSpeakerBoost : DEFAULTS.useSpeakerBoost;
  }
  const modelRow = () => models.find((m) => m.model_id === (draft.model || "eleven_flash_v2_5"));
  function paintModelDependent() {
    const m = modelRow();
    el.lang.replaceChildren(option("", "Auto-detect"));
    for (const l of (m && m.languages) || []) el.lang.append(option(l.language_id, l.name));
    el.lang.value = draft.language && [...el.lang.options].some((o) => o.value === draft.language) ? draft.language : "";
    const style = $("bv-style");
    style.disabled = !!m && !m.can_use_style;
    el.boost.disabled = !!m && !m.can_use_speaker_boost;
  }
  function paintVoicePick() {
    el.voice.replaceChildren();
    el.voice.append(option("", "Default voice"));
    const seen = new Set([""]);
    if (draft.voiceId) { el.voice.append(option(draft.voiceId, draft.voiceName || "Chosen voice")); seen.add(draft.voiceId); }
    for (const v of voices) if (!seen.has(v.voice_id)) { el.voice.append(option(v.voice_id, voiceLabel(v))); seen.add(v.voice_id); }
    el.voice.value = draft.voiceId || "";
  }
  function paintForm() {
    paintVoicePick(); paintSliders();
    el.model.value = draft.model || "";
    paintModelDependent();
    el.fmt.value = draft.outputFormat || "";
    el.allm.value = draft.agentLlm && [...el.allm.options].some((o) => o.value === draft.agentLlm) ? draft.agentLlm : "";
    el.first.value = draft.agentFirstMessage || ""; el.aprompt.value = draft.agentPrompt || "";
    el.summary.textContent = voiceSummary(voiceToSave(draft));
    el.reset.disabled = !voiceToSave(draft);
  }

  async function loadModels() {
    if (modelsLoaded) return;
    try {
      const res = await api("/voice/models");
      if (!res.ok) { say("Voice settings are not available right now.", true); return; }
      const j = await res.json();
      models = Array.isArray(j.models) ? j.models : [];
      modelsLoaded = true;
      el.model.replaceChildren(option("", DEFAULT_MODEL_NOTE));
      for (const m of models) if (m.model_id !== "eleven_flash_v2_5") el.model.append(option(m.model_id, m.name));
      el.fmt.replaceChildren(option("", "Default (mp3 44.1 kHz 64 kbps)"));
      for (const f of j.output_formats || []) el.fmt.append(option(f, f.replace("mp3_", "mp3 ").replace(/_/g, " ")));
      paintForm();
    } catch (e) { if (e.message !== "unauthorized") say("Could not load the voice models.", true); }
  }
  let llmsLoaded = false;
  async function loadLlms() {
    if (llmsLoaded) return;
    try {
      const res = await api("/voice/agent/llms");
      if (!res.ok) return;
      for (const m of (await res.json()).llms || []) if (!m.deprecated) el.allm.append(option(m.llm, m.llm));
      llmsLoaded = true; paintForm();
    } catch { /* the default model still works */ }
  }
  async function searchVoices() {
    const mine = ++seq;
    try {
      const res = await api(`/voice/voices?scope=${encodeURIComponent(el.scope.value)}&q=${encodeURIComponent(el.search.value.trim())}`);
      if (mine !== seq) return;
      if (!res.ok) { say("Could not load voices.", true); return; }
      voices = (await res.json()).voices || [];
      paintVoicePick();
      if (!voices.length) say(el.search.value.trim() ? "No voices match that search." : "No voices found.");
      else say(dirty ? "Unsaved changes" : "");
    } catch (e) { if (e.message !== "unauthorized") say("Could not load voices.", true); }
  }

  el.search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchVoices, 350); });
  el.scope.addEventListener("change", searchVoices);
  el.voice.addEventListener("change", () => {
    const v = voices.find((x) => x.voice_id === el.voice.value);
    if (!el.voice.value) { delete draft.voiceId; delete draft.voiceName; }
    else { draft.voiceId = el.voice.value; draft.voiceName = v ? v.name : draft.voiceName || "Chosen voice"; }
    setDirty(true); el.summary.textContent = voiceSummary(voiceToSave(draft));
  });
  el.model.addEventListener("change", () => { if (el.model.value) draft.model = el.model.value; else delete draft.model; paintModelDependent(); if (draft.language && el.lang.value !== draft.language) delete draft.language; setDirty(true); });
  el.lang.addEventListener("change", () => { if (el.lang.value) draft.language = el.lang.value; else delete draft.language; setDirty(true); });
  el.allm.addEventListener("change", () => { if (el.allm.value) draft.agentLlm = el.allm.value; else delete draft.agentLlm; setDirty(true); });
  el.first.addEventListener("input", () => { if (el.first.value.trim()) draft.agentFirstMessage = el.first.value; else delete draft.agentFirstMessage; setDirty(true); });
  el.aprompt.addEventListener("input", () => { if (el.aprompt.value.trim()) draft.agentPrompt = el.aprompt.value; else delete draft.agentPrompt; setDirty(true); });
  el.fmt.addEventListener("change", () => { if (el.fmt.value) draft.outputFormat = el.fmt.value; else delete draft.outputFormat; setDirty(true); });
  el.boost.addEventListener("change", () => { draft.useSpeakerBoost = el.boost.checked; setDirty(true); });
  for (const s of SLIDERS) {
    const input = $(s.id), out = $(`${s.id}-out`);
    input.min = String(s.min); input.max = String(s.max); input.step = String(s.step);
    input.addEventListener("input", () => { const v = Math.round(Number(input.value) * 100) / 100; draft[s.key] = v; if (out) out.textContent = String(v); setDirty(true); });
  }

  el.preview.addEventListener("click", async () => {
    const bot = botOf(drawerBot());
    el.preview.disabled = true; say("Preparing a preview…");
    try {
      const res = await api("/voice/tts", { method: "POST", body: JSON.stringify({ text: `Hi, I'm ${bot ? bot.name : "your bot"}. This is how I sound.`, voice: voiceToSave(draft) || {} }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); say(j.message || "Could not make the preview.", true); return; }
      const blob = await res.blob();
      if (audio) { audio.pause(); URL.revokeObjectURL(audio.src); }
      audio = new Audio(URL.createObjectURL(blob));
      audio.onended = () => { say(dirty ? "Unsaved changes" : ""); };
      await audio.play(); say("Playing…");
    } catch (e) { if (e.message !== "unauthorized") say("Could not play the preview.", true); }
    finally { el.preview.disabled = false; }
  });

  async function patch(voice, doneText) {
    const id = drawerBot(); const bot = botOf(id);
    if (!bot) return;
    el.save.disabled = true; el.reset.disabled = true; say("Saving…");
    try {
      const res = await api(`/bots/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ voice }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { say(body.message || "Could not save the voice.", true); el.save.disabled = !dirty; return; }
      onSaved(id, body.bot || body);
      draft = { ...((body.bot || body).voice || {}) };
      dirty = false; paintForm(); say(doneText);
    } catch (e) { if (e.message !== "unauthorized") { say("Could not save the voice. Try again.", true); el.save.disabled = !dirty; } }
  }
  el.save.addEventListener("click", () => patch(voiceToSave(draft), "Voice saved. This bot speaks with it from its next reply, on every device."));
  el.reset.addEventListener("click", () => patch(null, "Voice cleared. This bot uses the default voice."));

  return {
    /** Called when the drawer shows a bot. */
    paint(bot) {
      draft = { ...((bot && bot.voice) || {}) };
      dirty = false; el.save.disabled = true; say("");
      paintForm();
      void loadModels(); void loadLlms();
      if (!voices.length) void searchVoices();
    },
  };
}
