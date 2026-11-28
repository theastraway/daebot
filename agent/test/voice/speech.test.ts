import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanWriterOutput, fallbackSpeech, hasVisualDetail, plainSpeech, speechMessages, writeForSpeech, SPEECH_SYSTEM } from "../../src/voice/speech.ts";
import type { Provider, StreamEvent } from "../../src/types.ts";

const MD = "## Done ✅\n\nI fixed `agent/src/gateway/voice.ts` → now the TTS works. Commit 854228b pushed.\n\n- **Step 1**: run `npm test`\n- Step 2: see [PR #392](https://github.com/x/y/pull/392)\n- Step 3 & 4: deploy\n\n```ts\nconst a = 1;\n```\nCost is $1,200 – $1,500 for Q3/Q4.";

test("plainSpeech: never says markdown, symbols, emoji, paths, urls, code, hashes or uuids", () => {
  const t = plainSpeech(MD);
  assert.doesNotMatch(t, /[`*#|→✅\[\]{}<>\\=]|https?:|const a|854228b|agent\/src|\/Users/);
  assert.match(t, /I fixed voice to now the TTS works/);
  assert.match(t, /see PR 392/);
  assert.match(t, /Step 3 and 4: deploy/);
  assert.match(t, /\$1,200 to \$1,500 for Q3 or Q4/);
  const p = plainSpeech("Path /Users/ajc/code/daebot/agent/web/voice.js changed. id d294ae94-1111-2222-3333-444455556666 done.");
  assert.equal(p, "Path voice changed. id done.");
  assert.equal(plainSpeech(""), "");
  assert.equal(plainSpeech(undefined as unknown as string), "");
});

test("plainSpeech: capped at a sentence boundary", () => {
  const long = "Sentence number one is here. ".repeat(100);
  const cut = plainSpeech(long, 200);
  assert.ok(cut.length <= 200 && cut.endsWith("."), cut);
});

test("hasVisualDetail / fallbackSpeech: lists, code, links and tables point at the screen; plain speech does not", () => {
  assert.equal(hasVisualDetail(MD), true);
  assert.equal(hasVisualDetail("| a | b |\n|---|---|\n| 1 | 2 |"), true);
  assert.equal(hasVisualDetail("Yes, it shipped this morning."), false);
  assert.match(fallbackSpeech(MD), /The details are in the chat\.$/);
  assert.equal(fallbackSpeech("Yes, it shipped this morning."), "Yes, it shipped this morning.");
  assert.ok(fallbackSpeech("word ".repeat(400)).length <= 400);
});

test("speechMessages carries the rules, the user's words and the written answer; cleanWriterOutput strips wrappers", () => {
  const m = speechMessages("did it ship?", "Yes. **Shipped** at 3pm.", "Sam");
  assert.equal(m[0].content, SPEECH_SYSTEM);
  assert.match(m[1].content, /Sam/); assert.match(m[1].content, /did it ship\?/); assert.match(m[1].content, /Shipped/);
  assert.match(SPEECH_SYSTEM, /Never say symbols/); assert.match(SPEECH_SYSTEM, /in the chat/);
  assert.equal(cleanWriterOutput('<think>hmm</think>Spoken: "Yep, it went out at three."'), "Yep, it went out at three.");
});

class Writer implements Provider {
  name = "w"; calls = 0; seen: any[] = [];
  out: string; delayMs: number; fail: boolean;
  constructor(out: string, delayMs = 0, fail = false) { this.out = out; this.delayMs = delayMs; this.fail = fail; }
  async *stream(req: any): AsyncIterable<StreamEvent> {
    this.calls++; this.seen.push(req);
    if (this.delayMs) await new Promise((r, j) => { const t = setTimeout(r, this.delayMs); req.signal?.addEventListener("abort", () => { clearTimeout(t); j(new Error("aborted")); }); });
    if (this.fail) throw new Error("boom");
    yield { type: "text", delta: this.out };
    yield { type: "done", usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.0001 }, finishReason: "stop" };
  }
}

test("writeForSpeech: the model's words, cleaned; short plain answers skip the model; failures and slowness return undefined", async () => {
  const w = new Writer('"Done, the voice fix is live. The steps are in the chat. 🎉"');
  const r = await writeForSpeech({ provider: w, model: "cheap", question: "status?", answer: MD });
  assert.equal(r?.text, "Done, the voice fix is live. The steps are in the chat.");
  assert.equal(r?.usage?.costUsd, 0.0001);
  assert.equal(w.seen[0].noReasoning, true); assert.deepEqual(w.seen[0].tools, []);
  const skip = new Writer("never");
  const s = await writeForSpeech({ provider: skip, model: "cheap", question: "", answer: "Yes, it shipped this morning." });
  assert.deepEqual(s, { text: "Yes, it shipped this morning.", skipped: true });
  assert.equal(skip.calls, 0);
  assert.equal(await writeForSpeech({ provider: new Writer("x", 0, true), model: "c", question: "", answer: MD }), undefined);
  const t0 = Date.now();
  assert.equal(await writeForSpeech({ provider: new Writer("late", 5_000), model: "c", question: "", answer: MD, timeoutMs: 80 }), undefined);
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal(await writeForSpeech({ provider: new Writer("ok"), model: "c", question: "", answer: "  " }), undefined);
});
