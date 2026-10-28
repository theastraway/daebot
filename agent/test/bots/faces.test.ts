import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOT_FACES, FACE_IDS, facePersonality, isFaceId, suggestFace } from "../../src/bots/faces.ts";
import { BotStore } from "../../src/bots/store.ts";
import type { BotMindApi } from "../../src/bots/store.ts";
import { BotError } from "../../src/bots/types.ts";
import { composeSystemPrompt } from "../../src/runtime.ts";
import { caelumToBot } from "../../src/gateway/caelum.ts";

const web: any = await import(new URL("../../web/faces.js", import.meta.url).href);
const bots: any = await import(new URL("../../web/bots.js", import.meta.url).href);

const mind: BotMindApi = { async list() { return []; }, async create() {}, async remove() {} };
const mk = () => new BotStore({ dir: mkdtempSync(join(tmpdir(), "faces-")), owner: "u1", mind });

test("the server list and the web list are the same faces: ids, names, blurbs, in order", () => {
  assert.deepEqual(web.FACES.map((f: any) => [f.id, f.name, f.blurb]), BOT_FACES.map((f) => [f.id, f.name, f.blurb]));
  assert.ok(BOT_FACES.length >= 8 && BOT_FACES.length <= 12);
  assert.equal(new Set(FACE_IDS).size, FACE_IDS.length, "ids are unique");
  for (const f of BOT_FACES) {
    assert.match(f.id, /^[a-z]+$/);
    assert.ok(f.personality.length > 80 && f.personality.length < 700, `${f.id} personality is a short paragraph`);
    assert.ok(!/ignore|override|disregard/i.test(f.personality), `${f.id} personality never talks about overriding anything`);
  }
  for (const f of web.FACES) assert.ok(f.shapes.length >= 3, `${f.id} is drawn`);
});

test("isFaceId and facePersonality: allowlisted ids only", () => {
  assert.equal(isFaceId("analyst"), true);
  for (const bad of ["", "Analyst", "robot", "../x", null, undefined, 5, {}]) assert.equal(isFaceId(bad), false);
  assert.match(facePersonality("closer"), /next step/);
  assert.equal(facePersonality("nope"), "");
  assert.equal(facePersonality(undefined), "");
});

test("store: face is validated on create and update; old bots have none; clearing works", async () => {
  const s = mk();
  const old = await s.create({ slug: "old", name: "Old" });
  assert.equal(old.face, undefined, "no face unless one is chosen");
  const b = await s.create({ slug: "ana", name: "Ana", face: "analyst", color: "#2dd4bf" });
  assert.equal(b.face, "analyst");
  await assert.rejects(s.create({ slug: "bad", name: "Bad", face: "evil" }), (e: unknown) => e instanceof BotError && e.status === 400 && e.code === "bad_face");
  await assert.rejects(s.create({ slug: "bad2", name: "Bad", face: 7 }), (e: unknown) => e instanceof BotError && e.code === "bad_face");
  assert.equal(s.bySlug("bad"), undefined, "a refused face creates nothing");
  assert.equal(s.update(b.id, { face: "coach" }).face, "coach");
  assert.throws(() => s.update(b.id, { face: "<script>" }), (e: unknown) => e instanceof BotError && e.code === "bad_face");
  assert.equal(s.get(b.id)!.face, "coach", "a refused update changes nothing");
  assert.equal(s.update(b.id, { name: "Ana 2" }).face, "coach", "other edits keep the face");
  assert.equal(s.update(b.id, { face: "" }).face, undefined);
  assert.equal(s.update(old.id, { face: "guardian" }).face, "guardian");
});

test("system prompt: the face's personality is appended after the instructions and never overrides them", () => {
  const base = { bootContext: "", surface: "web", cwd: "/x", now: new Date("2026-01-02T12:00:00Z") };
  const withFace = composeSystemPrompt({ ...base, bot: { slug: "ana", instructions: "# Role\nBe Ana.", face: "analyst" } });
  const iInstr = withFace.indexOf("Be Ana.");
  const iPers = withFace.indexOf("## Personality: Analyst");
  assert.ok(iInstr > 0 && iPers > iInstr, "personality comes after the owner's instructions");
  assert.ok(withFace.includes(facePersonality("analyst")));
  assert.match(withFace, /tone and manner only[^\n]*every gate win/);
  const none = composeSystemPrompt({ ...base, bot: { slug: "old", instructions: "# Role\nOld." } });
  assert.ok(!none.includes("Personality:"), "a bot without a face gets no personality section");
  const bogus = composeSystemPrompt({ ...base, bot: { slug: "x", instructions: "x", face: "evil" } });
  assert.ok(!bogus.includes("Personality:"), "an unknown face adds nothing");
  assert.ok(!composeSystemPrompt(base).includes("Personality:"), "an ordinary session is unchanged");
});

test("suggestFace and Caelum: the nearest personality is suggested from the draft, nothing when nothing fits", () => {
  assert.equal(suggestFace("follow up with every new sales lead and close the deal"), "closer");
  assert.equal(suggestFace("monitor for security and compliance risk"), "guardian");
  assert.equal(suggestFace("zzz qqq"), undefined);
  assert.equal(suggestFace(""), undefined);
  const b = caelumToBot({ name: "claim_review_bot", role: "Insurance claim reviewer", primary_responsibility: "Review each claim for compliance risk and flag problems", traits: ["careful"] });
  assert.ok(isFaceId(b.face));
  assert.equal(caelumToBot({ name: "zzz", role: "qqq" }).face, undefined);
});

test("web faceSvg: unknown ids draw nothing; known ids are inline SVG in currentColor with no external references", () => {
  assert.equal(web.faceOf("nope"), undefined);
  assert.equal(web.faceOf(undefined), undefined);
  assert.ok(FACE_IDS.includes(bots.DEFAULT_FACE), "a new bot starts on a real face");
  for (const f of web.FACES) for (const [tag, attrs] of f.shapes) {
    assert.ok(["path", "circle", "rect"].includes(tag));
    for (const [k, v] of Object.entries<any>(attrs)) {
      assert.ok(!/^on|href/i.test(k), `${f.id}: no event or link attributes`);
      assert.ok(!/url\(|javascript:|http/i.test(String(v)), `${f.id}: no external references`);
    }
  }
});
