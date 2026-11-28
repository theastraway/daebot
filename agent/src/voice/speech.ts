// Speech writer: turns an answer written for the SCREEN into what a person on a call would actually SAY.
// The chat keeps the full written answer (lists, code, links, tables). The ear gets one to three natural sentences that lead with
// the answer, never read symbols, paths, ids or markdown, and point at the screen when the details live there.
//
// Two layers:
//   writeForSpeech  - a small fast model rewrites the answer for the ear (the real thing).
//   plainSpeech     - a deterministic cleanup: the model's output always passes through it, and it is the whole fallback when the model
//                     is slow, fails or the user is out of budget. Never throws.
import type { Message, Provider, StreamEvent, Usage } from "../types.ts";

export const MAX_SPOKEN_CHARS = 700;      // about 45 seconds of speech: a reply on a call, not a reading
const MAX_ANSWER_CHARS = 12_000;          // what the writer sees of the written answer
const MAX_QUESTION_CHARS = 1_500;
export const SPEECH_TIMEOUT_MS = 6_000;   // the user is waiting in silence: a slow writer loses to the fallback

export const SPEECH_SYSTEM = [
  "You are the voice of an assistant on a live voice call. You get the user's last words and the assistant's WRITTEN answer, which is also on the user's screen.",
  "Write ONLY the words the assistant should SAY out loud right now. It must sound like a sharp, warm person talking on the phone, not like text being read.",
  "",
  "Rules:",
  "- Lead with the answer or the outcome in the first sentence. No preamble (\"Sure!\", \"Great question\", \"Here is\").",
  "- One to three short sentences. Up to five only when the user asked for an explanation. Use contractions.",
  "- Never say symbols, markdown, emoji, file paths, URLs, code or commands. Name the thing in plain words (\"the voice settings file\", \"the latest release\").",
  "- Leave out ids, hashes, build numbers, commit codes and long version strings entirely; never spell them out. Say \"the latest build\" or \"version zero point three sixty-one\" only when the user asked about the version.",
  "- Lists, tables, code, links, steps or long numbers: give the gist or the top one or two items, then say the rest is on screen (\"I put the details in the chat.\").",
  "- Say numbers the way people say them: \"about twelve hundred dollars\", \"three thirty tomorrow\".",
  "- If the written answer asks the user something or needs a decision, end with that question, spoken simply.",
  "- If the answer reports an error or a blocker, say what happened and what is needed, in one breath.",
  "- Never add facts, promises or opinions that are not in the written answer. Never mention that you are rewriting anything.",
  "- Same language as the user.",
  "",
  "Output the spoken words only: plain sentences, no quotes, no labels, no lists.",
].join("\n");

/** True when the written answer carries things the ear should not get: code, lists, tables, links, long ids. */
export function hasVisualDetail(md: string): boolean {
  const s = String(md || "").slice(0, MAX_PLAIN_INPUT);
  if (/```/.test(s)) return true;
  if (/^[ \t]*\|[^\n]*\|[ \t]*$/m.test(s)) return true;
  if (/\]\(https?:\/\//.test(s) || /https?:\/\/\S+/.test(s)) return true;
  const items = s.split("\n").filter((l) => /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+\S/.test(l)).length;
  return items >= 3;
}

const MAX_PLAIN_INPUT = 12_000;           // plainSpeech never looks further than this (the writer reads the same amount)
const FILE_RE = /^[\w.-]{1,200}\.(?:ts|tsx|js|jsx|mjs|py|json|md|sh|css|html|yml|yaml)$/i;
/** A whole token that is a file path, absolute ("/a/b", "~/a/b", "../a/b") or relative with an extension ("src/a.ts"); group 2 keeps trailing punctuation. */
const PATH_TOKEN_RE = /^((?:~|\.{1,2})?(?:\/[\w.@-]{1,120}){2,}\/?|[\w.@-]{1,120}(?:\/[\w.@-]{1,120})+\.(?:ts|tsx|js|jsx|mjs|py|json|md|sh|css|html|yml|yaml))([.,;:!?)]*)$/i;

/** Collapse a path-like token to the name a person would say ("agent/src/gateway/voice.ts" -> "voice"). */
function sayPath(p: string): string {
  const last = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
  return last.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|md|yml|yaml|toml|sh|css|html|txt|lock)$/i, "").replace(/[_-]+/g, " ");
}

/**
 * Deterministic: markdown answer -> plain words safe to hand to text to speech. No code, URLs, paths, ids, list or heading marks, emoji or
 * stray symbols; capped at a sentence boundary. Used on the writer's output (belt and braces) and as the whole fallback.
 */
export function plainSpeech(md: string, max = MAX_SPOKEN_CHARS): string {
  // Linear-time by construction (this runs synchronously on the gateway, on user-supplied text): the input is capped and its whitespace
  // normalised FIRST, line-anchored patterns use [ \t] never \s, lazy spans are bounded, and paths are matched per token.
  let t = String(md || "").slice(0, MAX_PLAIN_INPUT)
    .replace(/\r/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/```[^]*?(?:```|$)/g, " ")                                      // code blocks: never spoken
    .replace(/!\[[^\]\n]{0,300}\]\([^)\n]{0,2000}\)/g, " ")                  // images
    .replace(/\[([^\]\n]{1,300})\]\([^)\s]{1,2000}\)/g, "$1")                // [label](url) -> label
    .replace(/<https?:\/\/[^>\s]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")                                        // bare URLs
    .replace(/`([^`\n]{1,300})`/g, (_m, c: string) => (/[\\/]/.test(c) && !/\s/.test(c) ? sayPath(c) : FILE_RE.test(c) ? sayPath(c) : /[(){};=<>$]/.test(c) ? " " : c))
    .replace(/[^\s`]+/g, (tok) => {                                         // paths, per token
      if (tok.length > 300) return tok;
      const m = PATH_TOKEN_RE.exec(tok);
      return m ? sayPath(m[1]) + m[2] : tok;
    })
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ")     // uuids
    .replace(/\b[0-9a-f]{7,40}\b/gi, (m) => (/\d/.test(m) && /[a-f]/i.test(m) ? " " : m))   // commit hashes and hex ids
    .replace(/^ ?#{1,6} +([^\n]*)$/gm, "$1.")                                // headings become sentences
    .replace(/^ *(?:[-*+•]|\d{1,3}[.)]) +/gm, "")                            // list marks
    .replace(/^ *> ?/gm, "")                                                 // quotes
    .replace(/^[ |:-]*-{2,}[ |:-]*$/gm, " ")                                 // table rules
    .replace(/(\*\*|__)(?=\S)([^\n]{0,300}?\S)\1/g, "$2")
    .replace(/(^|[ \t(])[*_](?=\S)([^\n*_]{0,300}?\S)?[*_](?=[\s).,!?;:]|$)/gm, "$1$2")
    .replace(/ ?(?:->|=>|→|⇒|➜) ?/g, " to ")
    .replace(/ ?(?:<-|←) ?/g, " from ")
    .replace(/ & /g, " and ")
    .replace(/\band\/or\b/gi, "and or")
    .replace(/(\$?\d[\d,.]*) ?– ?(\$?\d)/g, "$1 to $2")                      // en dash ranges: "$1,200 – $1,500"
    .replace(/(?<![\d-])(\d[\d,.]*)-(\$?\d[\d,.]*)(?![\d-])/g, "$1 to $2")   // "9-5"; never dates, phone numbers or "5 - 3"
    .replace(/ [—–] /g, ", ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "") // emoji and dingbats
    .replace(/[|*_~^#<>{}[\]\\`=]+/g, " ")
    .replace(/ \/ /g, " or ")
    .replace(/\b([A-Za-z]\w{0,40})\/(\w{0,40}[A-Za-z]\w{0,40})\b/g, "$1 or $2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, ". ")
    .replace(/ ([.,!?;:])/g, "$1")
    .replace(/([.,!?;:])(?: ?[.,;:])+/g, "$1")
    .replace(/^[\s.,;:]+/, "")
    .replace(/\( ?\)/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = (end > max * 0.4 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + ".").trim();
  }
  return t;
}

/** The fallback when no writer ran: the first couple of sentences, plus a pointer to the screen when the details live there. */
export function fallbackSpeech(md: string): string {
  const plain = plainSpeech(md, 360);
  if (!plain) return "";
  return hasVisualDetail(md) && !/\bon (?:the )?screen\b|\bin the chat\b/i.test(plain) ? `${plain} The details are in the chat.` : plain;
}

export function speechMessages(question: string, answer: string, botName?: string): Message[] {
  const who = botName && botName.trim() ? `The assistant's name is ${botName.trim().slice(0, 60)}.\n\n` : "";
  return [
    { role: "system", content: SPEECH_SYSTEM },
    { role: "user", content: `${who}The user said:\n${(question || "(nothing: the assistant is speaking first)").slice(0, MAX_QUESTION_CHARS)}\n\nThe written answer on screen:\n${String(answer).slice(0, MAX_ANSWER_CHARS)}\n\nWhat the assistant says out loud:` },
  ];
}

/** Strip a model's wrappers: quotes around the whole thing, "Spoken:" labels, a <think> block that leaked. */
export function cleanWriterOutput(raw: string): string {
  return String(raw || "")
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
    .replace(/^\s*(?:spoken|say|output|answer|assistant)\s*:\s*/i, "")
    .trim()
    .replace(/^["“'](.*)["”']$/s, "$1")
    .trim();
}

/**
 * The real speech writer. Returns the spoken words, or undefined when the model failed, timed out or returned nothing usable
 * (the caller then uses fallbackSpeech). Short answers that are already plain speech skip the model entirely.
 */
export async function writeForSpeech(o: {
  provider: Provider; model: string; question: string; answer: string; botName?: string; signal?: AbortSignal; timeoutMs?: number;
}): Promise<{ text: string; usage?: Usage; skipped?: boolean } | undefined> {
  const answer = String(o.answer || "").trim();
  if (!answer) return undefined;
  // Already speech: one or two plain sentences with nothing to strip. No model call, no latency, no cost.
  const plain = plainSpeech(answer);
  if (answer.length <= 220 && !hasVisualDetail(answer) && !/[`*#|\[\]\\/{}<>=]|https?:/.test(answer) && plain.length >= answer.length * 0.9) return { text: plain, skipped: true };
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (o.signal) { if (o.signal.aborted) ac.abort(); else o.signal.addEventListener("abort", onAbort, { once: true }); }
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? SPEECH_TIMEOUT_MS);
  timer.unref?.();
  try {
    let text = "";
    let usage: Usage | undefined;
    for await (const ev of o.provider.stream({ model: o.model, messages: speechMessages(o.question, answer, o.botName), tools: [], signal: ac.signal, noReasoning: true }) as AsyncIterable<StreamEvent>) {
      if (ev.type === "text") text += ev.delta;
      else if (ev.type === "done") usage = ev.usage;
    }
    const spoken = plainSpeech(cleanWriterOutput(text));
    if (spoken.length < 2) return undefined;
    return { text: spoken, usage };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}
