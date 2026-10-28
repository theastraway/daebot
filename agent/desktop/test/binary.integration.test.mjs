// Opt-in: runs the REAL bun-compiled gateway binary the way the packaged app does (serve --port 0, MIND billing, throwaway HOME).
//   DAEBOT_TEST_BINARY=/path/to/daebot-<os>-<arch> npm test
// Skipped when the variable is unset, so a plain `npm test` needs no bun and builds nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildGateway, waitForHealth } from "../src/lib/child.mjs";
import { buildSpawnPlan } from "../src/lib/launcher.mjs";

const bin = process.env.DAEBOT_TEST_BINARY;

test("bundled binary: ready line, embedded UI, public download page, token gate, persistent store dir, clean stop", { skip: !bin || !existsSync(bin) }, async () => {
  const home = mkdtempSync(join(tmpdir(), "dae-bin-"));
  const gw = new ChildGateway({
    spawn,
    readyTimeoutMs: 20_000,
    plan: () => buildSpawnPlan({
      agentRoot: "/unused", entry: "/unused.mjs", kernelMode: "enforced", binaryPath: bin, nodePath: null, electronPath: "/unused",
      baseEnv: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, mindKey: "mind_TESTKEY_0123456789abcdef", home,
    }),
  });
  const { url, token } = await gw.start();
  const pid = gw.child.pid;
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(new URL(url).port, "7777");
    assert.match(token, /^[0-9a-f]{64}$/);
    await waitForHealth(url);
    const root = await fetch(`${url}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /btn-new/); // the embedded web UI, not a 404
    const dl = await fetch(`${url}/download/`);
    assert.equal(dl.status, 200);
    assert.match(await dl.text(), /Get Daebot/);
    assert.equal((await fetch(`${url}/sessions`)).status, 401);
    assert.equal((await fetch(`${url}/sessions`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.ok(existsSync(join(home, ".daebot", "gateway-token")));
    assert.equal(statSync(join(home, ".daebot", "gateway-token")).mode & 0o777, 0o600);
  } finally {
    await gw.stop();
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "child is gone after stop");
});
