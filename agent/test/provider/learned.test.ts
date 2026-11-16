import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_SAMPLES, adviseTier, appendRouteLog, classOf, describeTable, fitTable, loadTable, routeLogPath, rowFor } from "../../src/provider/learned.ts";
import type { RouteDecision, TurnProof } from "../../src/types.ts";

const d = (tier: RouteDecision["tier"], reason = "small fix: one module, tests exist", applied = true): RouteDecision => ({ tier, model: "m", reason, source: "rules", applied });
const p = (verified: boolean): TurnProof => ({ at: 1, calls: 2, failed: verified ? 0 : 1, blocked: 0, unverified: !verified, verified, model: "m" });

test("route log rows carry no message text, only a hash and the class; the file is appended under the data dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "routelog-"));
  const file = routeLogPath(dir, "user@x/y");
  assert.ok(file.endsWith("routing/user_x_y.jsonl"));
  const row = rowFor("fix the typo in README", d("coder"), p(true), 0.01);
  assert.equal(row.cls, "small fix");
  assert.ok(!JSON.stringify(row).includes("README"));
  appendRouteLog(file, row);
  appendRouteLog(file, rowFor("x", d("coder"), p(false)));
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
  assert.equal(loadTable(file).get("small fix")!.get("coder")!.n, 2);
  assert.equal(classOf(d("coder", "stuck: 2 bad turns in a row (clamped)")), "stuck");
});

test("the learned table: only applied rows count; a class that keeps failing moves up, one that always verifies moves down, nothing moves on thin data", () => {
  const lines: string[] = [];
  for (let i = 0; i < MIN_SAMPLES; i++) lines.push(JSON.stringify(rowFor("a", d("coder"), p(i % 10 < 3)))); // 30% verified on coder
  for (let i = 0; i < 5; i++) lines.push(JSON.stringify(rowFor("a", d("coder", "small fix", false), p(false)))); // shadow rows: ignored
  const t = fitTable(lines.join("\n"));
  assert.equal(t.get("small fix")!.get("coder")!.n, MIN_SAMPLES);
  const up = adviseTier(t, "small fix", "coder");
  assert.equal(up.tier, "reasoner");
  assert.match(up.why!, /learned/);
  const thin = fitTable(lines.slice(0, 5).join("\n"));
  assert.equal(adviseTier(thin, "small fix", "coder").tier, "coder");
  const good: string[] = [];
  for (let i = 0; i < MIN_SAMPLES; i++) { good.push(JSON.stringify(rowFor("a", d("reasoner", "debugging"), p(true)))); good.push(JSON.stringify(rowFor("a", d("coder", "debugging"), p(i % 20 !== 0)))); }
  const down = adviseTier(fitTable(good.join("\n")), "debugging", "reasoner");
  assert.equal(down.tier, "coder");
  assert.equal(adviseTier(new Map(), "x", "light").tier, "light");
  assert.ok(describeTable(t)[0].includes("small fix on coder"));
});
