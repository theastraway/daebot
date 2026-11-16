import { test } from "node:test";
import assert from "node:assert/strict";
import { botScope, personScope, repoSlug, resetScopeCache, workspaceScope } from "../../src/learn/scope.ts";
import { parseRecords, serializeLesson } from "../../src/learn/records.ts";
import { inScope, rank } from "../../src/learn/recall.ts";
import { DEFAULTS } from "../../src/learn/config.ts";
import type { Lesson } from "../../src/learn/types.ts";

const cfg = { enabled: true, user: "u", ...DEFAULTS };
const lesson = (key: string, extra: Partial<Lesson> = {}): Lesson => ({
  type: "lesson", key, rev: 1, kind: "behavior", status: "active", title: `Lesson - Behavior - x${key}`,
  trigger: "deploying the gateway service", behavior: "check logs", rule: "read the deploy logs before saying the gateway service is live",
  evidence: [], uses: 0, helped: 0, hurt: 0, created: "2026-11-01", updated: "2026-11-15", ...extra,
});

test("scopes: repo slugs from every remote shape; bot and person scopes; the workspace read is cached and failure-safe", () => {
  assert.equal(repoSlug("https://github.com/TheAstraway/Daebot.git"), "theastraway/daebot");
  assert.equal(repoSlug("git@github.com:theastraway/daebot.git\n"), "theastraway/daebot");
  assert.equal(repoSlug("ssh://git@github.com/a/b"), "a/b");
  assert.equal(repoSlug("not a remote"), undefined);
  assert.equal(botScope("Sales-Rep"), "bot:sales-rep");
  assert.equal(personScope("Anthony Conti"), "person:anthonyconti");
  resetScopeCache();
  let calls = 0;
  assert.equal(workspaceScope("/w", () => { calls++; return "git@github.com:o/r.git"; }), "workspace:o/r");
  assert.equal(workspaceScope("/w", () => { calls++; return "x"; }), "workspace:o/r", "cached per directory");
  assert.equal(calls, 1);
  assert.equal(workspaceScope("/nogit", () => { throw new Error("not a git repo"); }), undefined);
});

test("records: scope and scopes round-trip through MIND text", () => {
  const l = lesson("abc123", { scope: "workspace:o/r", scopes: ["workspace:o/r", "bot:dae"] });
  const p = parseRecords(serializeLesson(l));
  assert.equal(p.lessons[0].scope, "workspace:o/r");
  assert.deepEqual(p.lessons[0].scopes, ["workspace:o/r", "bot:dae"]);
  const old = parseRecords(serializeLesson(lesson("abc124")));
  assert.equal(old.lessons[0].scope, undefined);
});

test("recall: a lesson is recalled in its own scope, where it helped, or everywhere once promoted; a local lesson edges out a global twin", () => {
  assert.equal(inScope({ scope: undefined }, "bot:x"), true, "legacy lessons are global");
  assert.equal(inScope({ scope: "bot:a" }, "bot:a"), true);
  assert.equal(inScope({ scope: "bot:a" }, "bot:b"), false);
  assert.equal(inScope({ scope: "bot:a", scopes: ["bot:b"] }, "bot:b"), true, "helped there");
  assert.equal(inScope({ scope: "bot:a", scopes: ["bot:b", "bot:c"] }, "bot:z"), true, "promoted");
  assert.equal(inScope({ scope: "bot:a" }, undefined), true, "no scope asked: everything");
  const items = [lesson("aaaaaa", { scope: "workspace:o/r" }), lesson("bbbbbb"), lesson("cccccc", { scope: "bot:other" })];
  const msg = "deploy the gateway service and check it is live";
  const r = rank(msg, items, cfg, new Date("2026-11-16"), "workspace:o/r");
  assert.deepEqual(r.map((x) => x.item.key), ["aaaaaa", "bbbbbb"], "the other bot's lesson stays out; the local one ranks first");
  assert.equal(rank(msg, items, cfg, new Date("2026-11-16")).length, 3, "no scope: all three");
});
