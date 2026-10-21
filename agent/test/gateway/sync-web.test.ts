import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const web = (f: string) => readFileSync(join(import.meta.dirname, "..", "..", "web", f), "utf8");
const sync: any = await import(new URL("../../web/sync.js", import.meta.url).href);

const U = (text: string) => ({ type: "user", text });
const D = { type: "done", finalText: "ok" };

test("historyMarks counts user messages and completed turns, ignores junk", () => {
  assert.deepEqual(sync.historyMarks([U("a"), { type: "text", delta: "x" }, D, U("b"), D, null, {}]), { users: 2, dones: 2 });
  assert.deepEqual(sync.historyMarks(undefined), { users: 0, dones: 0 });
});

test("a message that arrived from elsewhere (MINDbots reply) makes the transcript behind", () => {
  const events = [U("hi"), D, U("can you try?"), { type: "text", delta: "Trying" }];
  const r = sync.transcriptBehind({ events, localUsers: 1, lastDones: 1 });
  assert.equal(r.behind, true);
});

test("the answer finishing later (done count moves) makes the transcript behind", () => {
  const events = [U("hi"), D, U("can you try?"), D];
  assert.equal(sync.transcriptBehind({ events, localUsers: 2, lastDones: 1 }).behind, true);
  assert.equal(sync.transcriptBehind({ events, localUsers: 2, lastDones: 2 }).behind, false);
});

test("no baseline yet (first look, or just after a local send): only a user-message gap counts", () => {
  const events = [U("hi"), D, U("again"), D];
  assert.equal(sync.transcriptBehind({ events, localUsers: 2, lastDones: undefined }).behind, false);
  assert.equal(sync.transcriptBehind({ events, localUsers: 1, lastDones: undefined }).behind, true);
  assert.equal(sync.transcriptBehind({ events, localUsers: 2, lastDones: undefined }).dones, 2);
});

test("web wiring: app.js polls the open session, skips busy/hidden tabs, re-baselines after a local send; CSP-safe", () => {
  const app = web("app.js");
  assert.match(app, /from "\/sync\.js"/);
  assert.match(app, /setInterval\(syncCurrent, \d+\)/);
  assert.match(app, /state\.busy\.has\(id\)/);
  assert.match(app, /syncDones = undefined/);
  const code = web("sync.js").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /innerHTML|eval\(|new Function|fetch\(/);
});
