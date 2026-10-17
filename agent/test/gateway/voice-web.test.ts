import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const web = (f: string) => readFileSync(join(import.meta.dirname, "..", "..", "web", f), "utf8");
const voice: any = await import(new URL("../../web/voice.js", import.meta.url).href);

test("speakable: markdown becomes plain speech (no code, urls, marks) and is capped at a sentence", () => {
  const md = "## Plan\n\n- **Call** Jane about `the_deal`\n- See [the doc](https://example.com/x) or https://example.com/y\n\n```ts\nconst a = 1;\n```\n\nDone. Next sentence is here.";
  const t = voice.speakable(md);
  assert.doesNotMatch(t, /[`*#]|https?:|const a/);
  assert.match(t, /Plan/);
  assert.match(t, /Call Jane about the_deal/);
  assert.match(t, /See the doc or link/);
  assert.match(t, /code omitted/);
  const long = "Sentence number one is here. ".repeat(100);
  const cut = voice.speakable(long, 200);
  assert.ok(cut.length <= 200 && cut.endsWith("."), cut);
  assert.equal(voice.speakable(""), "");
  assert.equal(voice.speakable(undefined), "");
});

test("pickRecorderType: webm on Chrome/Firefox, mp4 on Safari, empty when nothing is supported", () => {
  const MR = (ok: string[]) => ({ isTypeSupported: (t: string) => ok.includes(t) });
  assert.equal(voice.pickRecorderType(MR(["audio/webm;codecs=opus", "audio/webm"])), "audio/webm;codecs=opus");
  assert.equal(voice.pickRecorderType(MR(["audio/mp4"])), "audio/mp4"); // iOS Safari
  assert.equal(voice.pickRecorderType(MR([])), "");
  assert.equal(voice.pickRecorderType(undefined), "");
  assert.equal(voice.pickRecorderType({}), "");
});

test("web wiring: voice controls exist, app.js loads the module, voice.js never uses innerHTML or eval", () => {
  const html = web("index.html");
  for (const id of ["btn-mic", "btn-speak", "btn-convo", "voice-dock", "voice-status", "voice-stop", "i-mic", "i-speaker", "i-speaker-off", "i-wave"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(web("app.js"), /from "\/voice\.js"/);
  assert.match(web("app.js"), /voice\.turnDone\(/);
  const v = web("voice.js").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(v, /innerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/);
  assert.doesNotMatch(v, /fetch\((?!`\/voice\/|"\/voice\/)/, "voice.js only talks to /voice/*");
});
