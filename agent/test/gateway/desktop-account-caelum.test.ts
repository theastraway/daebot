import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { caelumToBot, displayName } from "../../src/gateway/caelum.ts";
import { localSecret } from "../../src/mcpconnect/local-secret.ts";
import { createRuntime } from "../../src/runtime.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import { http, tmpStatic } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex");

async function desktopRig(withKey = true) {
  const key = "mind_" + rnd();
  const fake = await startFakeMind({ [key]: "owner_test" });
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: withKey ? key : undefined });
  const runtime = createRuntime(cfg, { provider: new FakeProvider([]) });
  const gw = await startGateway({ runtime, cfg, port: 0, host: "127.0.0.1", staticDir: tmpStatic().dir, botsEnabled: () => true });
  const auth = { authorization: "Bearer " + gw.token };
  return { gw, fake, key, auth, close: async () => { await gw.close(); await fake.close(); } };
}

test("desktop /account: the MIND account the app signed in as; needs the gateway token", async () => {
  const r = await desktopRig();
  try {
    assert.equal((await http(r.gw.url, "GET", "/account")).status, 401);
    const a = await http(r.gw.url, "GET", "/account", { headers: r.auth });
    assert.equal(a.status, 200);
    assert.deepEqual(JSON.parse(a.body), { signedIn: true, username: "owner_test", name: "" });
    assert.doesNotMatch(a.body, /mind_/);
  } finally { await r.close(); }
  const none = await desktopRig(false);
  try { assert.equal(JSON.parse((await http(none.gw.url, "GET", "/account", { headers: none.auth })).body).signedIn, false); } finally { await none.close(); }
});

test("Ask Caelum: brief goes to MIND's agent builder with the user's key and comes back as bot fields", async () => {
  const r = await desktopRig();
  try {
    assert.equal((await http(r.gw.url, "POST", "/bots/caelum", { headers: r.auth, body: { brief: "x" } })).status, 400);
    const res = await http(r.gw.url, "POST", "/bots/caelum", { headers: r.auth, body: { brief: "Review claim emails every morning" } });
    assert.equal(res.status, 200);
    const b = JSON.parse(res.body);
    assert.equal(b.name, "Claim Review Bot");
    assert.equal(b.purpose, "Handles: Review claim emails every morning");
    assert.match(b.instructions, /^You are Claim Review Bot, Claim email reviewer\./);
    assert.match(b.instructions, /Rules\n- Never email a client/);
    const call = r.fake.seen.find((s) => s.path === "/api/agentbuilder/intake");
    assert.equal(call?.key, r.key, "billed to the user's own MIND key");
  } finally { await r.close(); }
});

test("caelumToBot clips third-party data and names readably", () => {
  assert.equal(displayName("insurance_claim_email_reviewer"), "Insurance Claim Email Reviewer");
  assert.equal(displayName("ClaimReviewBot"), "Claim Review Bot");
  const b = caelumToBot({ name: "x".repeat(500), role: 5, purposes: "nope", rules: Array(50).fill("r") });
  assert.ok(b.name.length <= 40 && b.purpose.length <= 140);
  assert.equal((b.instructions.match(/^- r$/gm) ?? []).length, 12);
  assert.equal(caelumToBot({}).name, "New bot");
});

test("desktop connector secret: created once, private, reused", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "mcpsec-")), "mcp");
  const a = localSecret(dir), b = localSecret(dir);
  assert.equal(a, b);
  assert.ok(a.length >= 40);
  assert.equal(readFileSync(join(dir, "local-secret"), "utf8").trim(), a);
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "local-secret")).mode & 0o777, 0o600);
});
