// A bot's own voice: which ElevenLabs voice speaks its replies and how. Plain data that rides the bot (it syncs with the look: name, colour, model).
// Every field is optional; absent = the account default voice. Nothing here is a secret (a voice id is a public catalogue id).
export interface BotVoice {
  /** ElevenLabs voice id (alphanumeric). Absent = the default voice. */
  voiceId?: string;
  /** Display name of the voice, kept so every device can show it without a lookup. */
  voiceName?: string;
  /** ElevenLabs TTS model id, e.g. eleven_flash_v2_5. Absent = the default (Flash v2.5). */
  model?: string;
  /** 0.7 to 1.2. */
  speed?: number;
  /** 0 to 1: lower is more expressive, higher is steadier. */
  stability?: number;
  /** 0 to 1. */
  similarityBoost?: number;
  /** 0 to 1: style exaggeration (models that support it). */
  style?: number;
  useSpeakerBoost?: boolean;
  /** ISO 639-1 language code. Absent = auto-detect. */
  language?: string;
  /** One of OUTPUT_FORMATS. Absent = mp3_44100_64. */
  outputFormat?: string;
  /** Voice chat (the live voice agent): the ElevenLabs agent LLM, the first thing it says, and extra instructions for how it talks. All optional. */
  agentLlm?: string;
  agentFirstMessage?: string;
  agentPrompt?: string;
}

export const OUTPUT_FORMATS = ["mp3_22050_32", "mp3_44100_32", "mp3_44100_64", "mp3_44100_96", "mp3_44100_128", "mp3_44100_192"] as const;
export const VOICE_FIELDS = ["voiceId", "voiceName", "model", "speed", "stability", "similarityBoost", "style", "useSpeakerBoost", "language", "outputFormat", "agentLlm", "agentFirstMessage", "agentPrompt"] as const;
const ID_RE = /^[A-Za-z0-9]{8,40}$/;
const MODEL_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.max(lo, Math.min(hi, v)) * 1000) / 1000 : undefined);

/** Whatever a client, a synced device or a hand-edited file sends, only valid fields of the right shape and range survive. undefined = no voice settings at all. */
export function cleanVoice(v: unknown): BotVoice | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const o: BotVoice = {};
  if (typeof r.voiceId === "string" && ID_RE.test(r.voiceId)) o.voiceId = r.voiceId;
  if (typeof r.voiceName === "string" && r.voiceName.trim()) o.voiceName = r.voiceName.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 60);
  if (typeof r.model === "string" && MODEL_RE.test(r.model)) o.model = r.model;
  const sp = num(r.speed, 0.7, 1.2); if (sp !== undefined) o.speed = sp;
  const st = num(r.stability, 0, 1); if (st !== undefined) o.stability = st;
  const sb = num(r.similarityBoost, 0, 1); if (sb !== undefined) o.similarityBoost = sb;
  const sy = num(r.style, 0, 1); if (sy !== undefined) o.style = sy;
  if (typeof r.useSpeakerBoost === "boolean") o.useSpeakerBoost = r.useSpeakerBoost;
  if (typeof r.language === "string" && LANG_RE.test(r.language)) o.language = r.language;
  if (typeof r.outputFormat === "string" && (OUTPUT_FORMATS as readonly string[]).includes(r.outputFormat)) o.outputFormat = r.outputFormat;
  if (typeof r.agentLlm === "string" && MODEL_RE.test(r.agentLlm)) o.agentLlm = r.agentLlm;
  const clip = (t: unknown, n: number) => (typeof t === "string" ? t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, "").trim().slice(0, n) : "");
  if (clip(r.agentFirstMessage, 300)) o.agentFirstMessage = clip(r.agentFirstMessage, 300);
  if (clip(r.agentPrompt, 2000)) o.agentPrompt = clip(r.agentPrompt, 2000);
  return Object.keys(o).length ? o : undefined;
}

/** Fixed key order so equal voices serialise (and hash) the same on every device. */
export function canonVoice(v: BotVoice | undefined): BotVoice | undefined {
  const c = cleanVoice(v);
  if (!c) return undefined;
  const o: Record<string, unknown> = {};
  for (const k of VOICE_FIELDS) if (c[k] !== undefined) o[k] = c[k];
  return o as BotVoice;
}

/** The body the gateway sends MIND's /audio/speech for this voice. */
export function ttsBodyFor(voice: BotVoice | undefined, text: string): Record<string, unknown> {
  const v = voice ?? {};
  const vs: Record<string, unknown> = {};
  if (v.stability !== undefined) vs.stability = v.stability;
  if (v.similarityBoost !== undefined) vs.similarity_boost = v.similarityBoost;
  if (v.style !== undefined) vs.style = v.style;
  if (v.speed !== undefined) vs.speed = v.speed;
  if (v.useSpeakerBoost !== undefined) vs.use_speaker_boost = v.useSpeakerBoost;
  return {
    input: text,
    ...(v.voiceId ? { voice: v.voiceId } : {}),
    ...(v.model ? { model_id: v.model } : {}),
    ...(Object.keys(vs).length ? { voice_settings: vs } : {}),
    ...(v.language ? { language_code: v.language } : {}),
    ...(v.outputFormat ? { output_format: v.outputFormat } : {}),
  };
}
