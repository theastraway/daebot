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

test("Studio 3: the token team's bill per tier with the all-frontier counterfactual; tokens price exactly, cost-only rows scale by the output price ratio; session and day filters", async () => {
  const { costSummary, parseRouteLog } = await import("../../src/provider/learned.ts");
  const policy = { light: { model: "m/light", priceIn: 0.15, priceOut: 0.47 }, coder: { model: "m/coder", priceIn: 0.12, priceOut: 0.8 }, frontier: { model: "m/front", priceIn: 8, priceOut: 40 }, local: { model: "m/local", priceIn: 0, priceOut: 0 } };
  const rows = [
    rowFor("a", d("coder"), p(true), 0.02, { tokensIn: 100_000, tokensOut: 10_000, session: "s1" }), // frontier: 0.8 + 0.4 = 1.2
    rowFor("b", d("coder"), p(false), 0.01, { session: "s2" }),                                        // no tokens: 0.01 * 40/0.8 = 0.5
    { ...rowFor("c", d("light", "chat", false), { ...p(true), model: "m/light" }, 0.004, { session: "s1" }), at: 5 }, // shadow row: the configured model (light) ran; 0.004 * 40/0.47
    rowFor("d", d("local"), p(true), 0, { session: "s1" }),                                             // free and unknown: not in the counterfactual
    "garbage", "{bad json",
  ];
  const text = rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");
  assert.equal(parseRouteLog(text).length, 4);
  const all = costSummary(text, { policy });
  assert.equal(all.turns, 4);
  assert.equal(all.costUsd, 0.034);
  assert.equal(all.known, 3);
  assert.equal(all.frontierUsd, Number((1.2 + 0.5 + 0.004 * (40 / 0.47)).toFixed(4)));
  assert.deepEqual(Object.keys(all.byTier).sort(), ["coder", "light", "local"]);
  assert.deepEqual(all.byTier.coder, { turns: 2, costUsd: 0.03, tokensIn: 100_000, tokensOut: 10_000, verified: 1 });
  const s1 = costSummary(text, { policy, session: "s1" });
  assert.equal(s1.turns, 3);
  const recent = costSummary(text, { policy, since: 2 });
  assert.equal(recent.turns, 1, "only the shadow row (at=5) is at or after since=2; the others carry the proof time 1");
});
