import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminLedger, mistakeBrief } from "../../src/gateway/mistakes.ts";
import { MindFeed, cleanTitlePart } from "../../src/gateway/mind-feed.ts";

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "daebot-feed-"));
  const L = new AdminLedger(dir);
  const store = new Map<string, { type: string; title: string; content: string }>();
  let n = 0;
  const client = {
    async remember(a: { type?: "entry" | "document"; title: string; content: string }) { const id = `id${++n}`; store.set(id, { type: a.type ?? "entry", title: a.title, content: a.content }); return `saved ${a.type ?? "entry"} ${id}`; },
    async call(_t: string, args: Record<string, unknown>) { store.delete(String(args.item_id)); return "ok"; },
  };
  const feed = new MindFeed(client, () => L, () => {});
  const docs = (prefix: string) => [...store.values()].filter((x) => x.type === "document" && x.title.startsWith(prefix));
  return { L, feed, store, docs, dir };
}

test("titles never carry slash, parentheses or dashes inside the text", () => {
  assert.equal(cleanTitlePart("Said done (no proof) / skipped — receipt"), "Said done no proof skipped receipt");
});

test("a mistake writes one entry and keeps ONE updated type document", async () => {
  const { L, feed, store, docs } = rig();
  const a = L.logMistake({ type: "Fixes built dark", definition: "d", prevention: "turn it on", what: "w1", quote: "q1", product: "Atlas", fix: "f1" });
  await feed.onMistake(a);
  const b = L.logMistake({ type: "Fixes built dark", what: "w2", product: "Atlas" });
  await feed.onMistake(b);
  assert.equal(docs("Daebot Mistake - Fixes built dark").length, 1, "old version is replaced, not accumulated");
  const doc = docs("Daebot Mistake - Fixes built dark")[0].content;
  assert.match(doc, /Count: 2/); assert.match(doc, /Prevention rule: turn it on/); assert.match(doc, /w2/); assert.match(doc, /w1/);
  const entries = [...store.values()].filter((x) => x.type === "entry");
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.title === "Lesson - Failure - Fixes built dark"));
  // delete the second occurrence: its entry goes, the document drops to count 1
  const d = L.deleteOccurrence(b.occurrence_id!)!;
  await feed.onOccurrenceDeleted(d);
  assert.equal([...store.values()].filter((x) => x.type === "entry").length, 1);
  assert.match(docs("Daebot Mistake - Fixes built dark")[0].content, /Count: 1/);
});

test("last 10 occurrences only, and a test-born type disappears from MIND with its occurrence", async () => {
  const { L, feed, docs } = rig();
  for (let i = 0; i < 13; i++) L.logMistake({ type: "Big", prevention: "p", what: `w${i}`, when: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() });
  await feed.syncType(L.typeIds()[0]);
  const body = docs("Daebot Mistake - Big")[0].content;
  assert.match(body, /Count: 13/); assert.match(body, /w12/); assert.doesNotMatch(body, /\bw2\b/);
  const t = L.logMistake({ type: "ZZ test", what: "x" });
  await feed.onMistake(t);
  assert.equal(docs("Daebot Mistake - ZZ test").length, 1);
  await feed.onOccurrenceDeleted(L.deleteOccurrence(t.occurrence_id!)!);
  assert.equal(docs("Daebot Mistake - ZZ test").length, 0);
});

test("backfill: one document per type and a KPI snapshot that is replaced the same day", async () => {
  const { L, feed, docs } = rig();
  for (const t of ["A", "B", "C"]) L.logMistake({ type: t, what: "x" });
  L.upsertTask({ title: "t", status: "done-verified", prompts_to_satisfaction: 2, repeats: 1, anger_flag: true });
  const r = await feed.backfill();
  assert.equal(r.types, 3); assert.equal(docs("Daebot Mistake - ").length, 3);
  assert.equal(docs("Daebot KPIs - ").length, 1);
  assert.match(docs("Daebot KPIs - ")[0].content, /Anger count \(tasks flagged angry\): 1/);
  await feed.snapshot();
  assert.equal(docs("Daebot KPIs - ").length, 1);
  assert.match(docs("Daebot KPIs - ")[0].title, /^Daebot KPIs - \d{4}-\d{2}-\d{2}$/);
});

test("a MIND outage never stops the ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daebot-feed-"));
  const L = new AdminLedger(dir);
  const feed = new MindFeed({ remember: async () => { throw new Error("down"); }, call: async () => { throw new Error("down"); } }, () => L, () => {});
  const a = L.logMistake({ type: "X", what: "y" });
  await feed.onMistake(a);
  assert.equal(L.typeSummary(a.type_id)!.count, 1);
});

test("boot brief lists the top types by count with prevention rules", () => {
  const { L, dir } = rig();
  for (let i = 0; i < 3; i++) L.logMistake({ type: "Often", prevention: "do the thing", what: "w" });
  L.logMistake({ type: "Rare", what: "w" });
  const b = mistakeBrief(dir);
  assert.match(b, /1\. Often \(3x/); assert.match(b, /RULE: do the thing/); assert.match(b, /2\. Rare \(1x/);
  assert.equal(mistakeBrief(join(dir, "nope")), "");
});

test("a session's system prompt carries the top mistakes (boot context)", async () => {
  const { createRuntime } = await import("../../src/runtime.ts");
  const { FakeProvider, baseCfg, collect } = await import("../core/helpers.ts");
  const { dir, L } = rig();
  for (let i = 0; i < 2; i++) L.logMistake({ type: "Said done without proof", prevention: "open the page first", what: "w" });
  const provider = new FakeProvider([{ text: "ok" }]);
  const failing = (async () => { throw new Error("offline"); }) as any;
  const rt = createRuntime(baseCfg(), { provider, fetchImpl: failing, mistakeDir: dir });
  const s = await rt.openSession({ surface: "headless", title: "t" });
  await collect(s.send("hi"));
  const sys = provider.requests[0].messages[0].content;
  assert.match(sys, /My own repeat failures/); assert.match(sys, /1\. Said done without proof \(2x/); assert.match(sys, /RULE: open the page first/);
  await s.close();
});
