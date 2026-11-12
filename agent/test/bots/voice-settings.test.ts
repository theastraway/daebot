import { test } from "node:test";
process.env.DAEBOT_BOTS_ENABLED = "1";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanVoice, canonVoice, ttsBodyFor } from "../../src/bots/voice.ts";
import { BotStore } from "../../src/bots/store.ts";
import { mergeWireBot, validWireBot, canonBot } from "../../src/sync/bots.ts";
import { createVoiceHandler } from "../../src/gateway/voice.ts";

function store() {
  const remote = new Set<string>();
  const dir = mkdtempSync(join(tmpdir(), "bots-voice-"));
  return new BotStore({ dir, owner: "u1", mind: { async list() { return [...remote].map((slug) => ({ slug })); }, async create(slug) { remote.add(slug); }, async remove(slug) { remote.delete(slug); } } });
}

test("cleanVoice keeps only valid fields, clamps ranges, drops junk", () => {
  assert.equal(cleanVoice(null), undefined);
  assert.equal(cleanVoice({ voiceId: "bad id!", model: "../x", speed: "fast" }), undefined);
  const v = cleanVoice({ voiceId: "JBFqnCBsd6RMkjVDRZzb", voiceName: " George ", model: "eleven_flash_v2_5", speed: 5, stability: -1, similarityBoost: 0.75, style: 0.2, useSpeakerBoost: false, language: "es", outputFormat: "mp3_44100_128", evil: 1 })!;
  assert.deepEqual(v, { voiceId: "JBFqnCBsd6RMkjVDRZzb", voiceName: "George", model: "eleven_flash_v2_5", speed: 1.2, stability: 0, similarityBoost: 0.75, style: 0.2, useSpeakerBoost: false, language: "es", outputFormat: "mp3_44100_128" });
  assert.equal(cleanVoice({ outputFormat: "pcm_16000" }), undefined);
  assert.equal(JSON.stringify(canonVoice({ speed: 1.1, voiceId: "JBFqnCBsd6RMkjVDRZzb" })), JSON.stringify(canonVoice({ voiceId: "JBFqnCBsd6RMkjVDRZzb", speed: 1.1 })));
});

test("ttsBodyFor builds MIND's speech body: snake_case settings, nothing when unset", () => {
  assert.deepEqual(ttsBodyFor(undefined, "hi"), { input: "hi" });
  assert.deepEqual(ttsBodyFor({ voiceId: "JBFqnCBsd6RMkjVDRZzb", model: "eleven_multilingual_v2", speed: 1.1, stability: 0.3, similarityBoost: 0.9, style: 0.1, useSpeakerBoost: true, language: "fr", outputFormat: "mp3_44100_96" }, "salut"),
    { input: "salut", voice: "JBFqnCBsd6RMkjVDRZzb", model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.3, similarity_boost: 0.9, style: 0.1, speed: 1.1, use_speaker_boost: true }, language_code: "fr", output_format: "mp3_44100_96" });
});

test("a bot's voice is set, validated, cleared and moves the look time", async () => {
  const s = store();
  const b = await s.create({ slug: "sam", name: "Sam" });
  const before = s.get(b.id)!.profileAt;
  assert.equal(s.get(b.id)!.voice, undefined);
  await new Promise((r) => setTimeout(r, 3));
  const u = s.update(b.id, { voice: { voiceId: "JBFqnCBsd6RMkjVDRZzb", voiceName: "George", speed: 1.1 } });
  assert.deepEqual(u.voice, { voiceId: "JBFqnCBsd6RMkjVDRZzb", voiceName: "George", speed: 1.1 });
  assert.ok(u.profileAt! > before!);
  assert.throws(() => s.update(b.id, { voice: { voiceId: "no way", model: "!!" } }), /not valid/);
  assert.equal(s.update(b.id, { voice: null }).voice, undefined);
  s.update(b.id, { voice: { speed: 0.9 } });
  assert.equal(s.exportSync("sam")!.voice!.speed, 0.9);
});

test("sync: the later look wins including the voice; a voice from another device is applied and stable", async () => {
  const s = store();
  const b = await s.create({ slug: "sam", name: "Sam" });
  const cur = s.exportSync("sam")!;
  const theirs = canonBot({ ...cur, voice: { voiceId: "JBFqnCBsd6RMkjVDRZzb", voiceName: "George", speed: 1.15 }, profileAt: cur.profileAt + 1000 });
  assert.ok(validWireBot(theirs));
  assert.equal(s.applySync(theirs), true);
  assert.deepEqual(s.get(b.id)!.voice, { voiceId: "JBFqnCBsd6RMkjVDRZzb", voiceName: "George", speed: 1.15 });
  assert.equal(s.applySync(theirs), false, "applying the same thing twice changes nothing");
  const older = canonBot({ ...cur, voice: { speed: 0.8 }, profileAt: cur.profileAt - 5 });
  assert.equal(s.applySync(older), false, "an older change loses");
  assert.deepEqual(mergeWireBot(cur, theirs), mergeWireBot(theirs, cur), "symmetric");
  // clearing on the later side clears everywhere
  const cleared = canonBot({ ...theirs, voice: undefined, profileAt: theirs.profileAt + 1000 });
  s.applySync(cleared);
  assert.equal(s.get(b.id)!.voice, undefined);
  assert.equal(validWireBot({ ...cur, voice: "x" }), false);
});

// ---- the gateway handler: which voice speaks ----
function call(h: ReturnType<typeof createVoiceHandler>, path: string, method: string, body?: unknown, query = "") {
  const buf = Buffer.from(JSON.stringify(body ?? {}));
  const req: any = Object.assign(Readable.from([buf]), { method, headers: { "content-type": "application/json", "content-length": String(buf.length) } });
  const out: { status: number; body: Buffer } = { status: 0, body: Buffer.alloc(0) };
  const res: any = { headersSent: false, writeHead(st: number) { out.status = st; }, end(d?: Buffer | string) { if (d) out.body = Buffer.from(d); } };
  return h(req, res, path, new URLSearchParams(query), { id: "u", username: "u", owner: false, tier: "staff" } as any).then(() => out);
}

test("/voice/tts speaks with the saved voice of the named bot; an explicit voice (preview) wins; main has none", async () => {
  const sent: any[] = [], heads: any[] = [];
  const f = (async (_url: string, init: any) => { heads.push(init.headers); sent.push(JSON.parse(init.body)); return new Response(Buffer.from("ID3x"), { status: 200, headers: { "content-type": "audio/mpeg" } }); }) as unknown as typeof fetch;
  const saved = { voiceId: "JBFqnCBsd6RMkjVDRZzb", speed: 1.1 };
  const h = createVoiceHandler({ baseUrl: "http://m/developer/v1", keyFor: () => "k", voiceOf: (_p, bot) => (bot === "sam" ? saved : undefined), fetchImpl: f });
  assert.equal((await call(h, "/voice/tts", "POST", { text: "hello", bot: "sam" })).status, 200);
  assert.deepEqual(sent[0], { input: "hello", voice: "JBFqnCBsd6RMkjVDRZzb", voice_settings: { speed: 1.1 } });
  await call(h, "/voice/tts", "POST", { text: "hello", bot: "main" });
  assert.deepEqual(sent[1], { input: "hello" });
  await call(h, "/voice/tts", "POST", { text: "hello", bot: "sam", voice: { voiceId: "21m00Tcm4TlvDq8ikWAM", stability: 0.2, bogus: 1 } });
  assert.deepEqual(sent[2], { input: "hello", voice: "21m00Tcm4TlvDq8ikWAM", voice_settings: { stability: 0.2 } });
  await call(h, "/voice/tts", "POST", { text: "hello", bot: "../../etc" });
  assert.deepEqual(sent[3], { input: "hello" }, "a bad bot name is ignored, never forwarded");
  assert.equal(heads[0]["X-Daebot-Bot"], "sam", "the bot slug goes to MIND so its spend cap and ledger apply");
  assert.equal(heads[3]["X-Daebot-Bot"], undefined);
});

test("/voice/voices and /voice/models forward GET with the user's key and a fixed query; other methods refused", async () => {
  const seen: { url: string; key: string }[] = [];
  const f = (async (url: string, init: any) => { seen.push({ url, key: init.headers["X-API-Key"] }); return new Response(JSON.stringify({ voices: [] }), { status: 200 }); }) as unknown as typeof fetch;
  const h = createVoiceHandler({ baseUrl: "http://m/developer/v1", keyFor: () => "userkey", fetchImpl: f });
  assert.equal((await call(h, "/voice/voices", "GET", undefined, "q=rach&scope=library&evil=1")).status, 200);
  assert.equal(seen[0].url, "http://m/developer/v1/audio/voices?q=rach&scope=library");
  assert.equal(seen[0].key, "userkey");
  assert.equal((await call(h, "/voice/models", "GET")).status, 200);
  assert.equal(seen[1].url, "http://m/developer/v1/audio/models");
  assert.equal((await call(h, "/voice/voices", "POST", {})).status, 405);
});
