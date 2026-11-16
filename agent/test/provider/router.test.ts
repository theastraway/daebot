import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTurn, nextDigest, routeTurn, routerMode } from "../../src/provider/router.ts";
import { DEFAULT_POLICY, describePolicy, loadPolicy } from "../../src/provider/policy.ts";
import { evaluateRouter } from "../../src/eval/router/run.ts";

test("routerMode: shadow by default, enforce and off by env", () => {
  assert.equal(routerMode({}), "shadow");
  assert.equal(routerMode({ DAEBOT_ROUTER: "enforce" }), "enforce");
  assert.equal(routerMode({ DAEBOT_ROUTER: "off" }), "off");
  assert.equal(routerMode({ DAEBOT_ROUTER: "nonsense" }), "shadow");
});

test("policy: env and file override a tier's model; bad values keep the default; the table is readable", () => {
  const p = loadPolicy({ DAEBOT_TIER_CODER: "qwen/qwen3-coder-flash", DAEBOT_TIER_LIGHT: "bad model id with spaces" });
  assert.equal(p.coder.model, "qwen/qwen3-coder-flash");
  assert.equal(p.light.model, DEFAULT_POLICY.light.model);
  const f = loadPolicy({ DAEBOT_ROUTING_POLICY: "/x.json" }, () => JSON.stringify({ frontier: { model: "anthropic/claude-fable-5.1", effort: "high" }, light: { effort: "silly" } }));
  assert.equal(f.frontier.model, "anthropic/claude-fable-5.1");
  assert.equal(f.frontier.effort, "high");
  assert.equal(f.light.effort, undefined);
  const broken = loadPolicy({ DAEBOT_ROUTING_POLICY: "/x.json" }, () => "{not json");
  assert.equal(broken.frontier.model, DEFAULT_POLICY.frontier.model);
  assert.match(describePolicy(DEFAULT_POLICY), /frontier: anthropic\/claude-fable-5\.2 \(effort medium\)/);
});

test("classifyTurn: the labelled scenarios all land on their tier", () => {
  const r = evaluateRouter();
  assert.deepEqual(r.misses, []);
  assert.equal(r.accuracy, 1);
  assert.ok(r.costPerTurnUsd.router < r.costPerTurnUsd["fixed:frontier"]);
  assert.ok(r.costPerTurnUsd.router > r.costPerTurnUsd["fixed:light"]);
});

test("routeTurn: floors and ceilings clamp, photos abstain, off abstains, enforce applies", () => {
  const big = "build the new billing subsystem end to end with Stripe webhooks";
  const admin = routeTurn({ message: big, canBuild: true, mode: "shadow", policy: DEFAULT_POLICY })!;
  assert.equal(admin.tier, "frontier");
  assert.equal(admin.applied, false);
  assert.equal(admin.model, DEFAULT_POLICY.frontier.model);
  const staff = routeTurn({ message: big, canBuild: true, mode: "enforce", ceiling: "reasoner", policy: DEFAULT_POLICY })!;
  assert.equal(staff.tier, "reasoner");
  assert.equal(staff.applied, true);
  assert.match(staff.reason, /clamped from frontier to the ceiling/);
  const pub = routeTurn({ message: big, canBuild: false, mode: "enforce", ceiling: "light", policy: DEFAULT_POLICY })!;
  assert.equal(pub.tier, "light");
  assert.equal(routeTurn({ message: "hi", hasPhoto: true, mode: "shadow" }), undefined);
  assert.equal(routeTurn({ message: "hi", mode: "off" }), undefined);
  const floor = routeTurn({ message: "hi", mode: "shadow", floor: "coder", policy: DEFAULT_POLICY })!;
  assert.equal(floor.tier, "coder");
});

test("effort before model: a debugging turn raises effort on the reasoner; a stuck turn escalates at the boundary", () => {
  const dbg = classifyTurn({ message: "why does the build crash on boot", canBuild: true });
  assert.equal(dbg.tier, "reasoner");
  assert.equal(dbg.effort, "high");
  const d0 = nextDigest(undefined, { failedCalls: 1, blocks: 0, unverified: false, repeatHits: 0 });
  assert.equal(d0.badStreak, 1);
  const d1 = nextDigest(d0, { failedCalls: 0, blocks: 1, unverified: false, repeatHits: 0 });
  assert.equal(d1.badStreak, 2);
  const stuck = classifyTurn({ message: "fix the test again", canBuild: true, digest: d1 });
  assert.equal(stuck.tier, "frontier");
  assert.match(stuck.reason, /2 bad turns/);
  const d2 = nextDigest(d1, { failedCalls: 0, blocks: 0, unverified: false, repeatHits: 0 });
  assert.equal(d2.badStreak, 0);
});
