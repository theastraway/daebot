import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AngerLedger } from "../../src/gateway/anger.ts";

const NOW = Date.parse("2026-10-22T16:00:00Z");
const msg = (id: string, ts: string, label: string, extra: object = {}) => ({ id, ts, session: "s1", label, reasons: [], repeat: false, caps: 0, len: 10, text: id, ...extra });

test("anger ledger: upsert is idempotent and the headline counts mixed against the number", () => {
  const dir = mkdtempSync(join(tmpdir(), "anger-"));
  const l = new AngerLedger(dir, () => NOW);
  const batch = [msg("a", "2026-10-22T14:00:00Z", "instruction"), msg("b", "2026-10-22T14:05:00Z", "answer"), msg("c", "2026-10-22T14:06:00Z", "chaser", { repeat: true }), msg("d", "2026-10-22T14:07:00Z", "anger"), msg("e", "2026-10-22T14:08:00Z", "mixed"), msg("old", "2026-09-01T14:00:00Z", "instruction")];
  assert.deepEqual(l.ingest({ batch, sessions: { s1: { title: "t" } } }), { added: 6, updated: 0, skipped: 0, total: 6 });
  assert.equal(l.ingest({ batch }).added, 0);
  const v = l.view();
  assert.equal(v.headline.today.total, 5);
  assert.equal(v.headline.today.productive, 2);
  assert.equal(v.headline.today.pct, 0.4);
  assert.equal(v.headline.today.chasers, 1);
  assert.equal(v.headline.today.repeats, 1);
  assert.equal(v.headline.d30.total, 5);
  assert.equal(v.headline.all.total, 6);
  assert.equal(v.trend.length, 30);
  assert.equal(v.sessions[0].title, "t");
  assert.ok(v.examples.length <= 20 && v.examples.length >= 5);
  assert.equal(new AngerLedger(dir, () => NOW).view().stored, 6, "persisted");
});

test("anger ledger: malformed rows are skipped, not guessed", () => {
  const l = new AngerLedger(mkdtempSync(join(tmpdir(), "anger-")), () => NOW);
  const r = l.ingest({ batch: [{ id: "", ts: "x", label: "instruction" }, { id: "z", ts: "2026-10-22T10:00:00Z", label: "bogus" }, msg("ok", "2026-10-22T10:00:00Z", "instruction")] });
  assert.equal(r.skipped, 2); assert.equal(r.added, 1);
  assert.equal(l.view().headline.today.pct, 1);
});
