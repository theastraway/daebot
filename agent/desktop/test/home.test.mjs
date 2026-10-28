// The desktop app's home folder (~/.daebot) and the one-time move of a pre-rename ~/.mindclaw. The full scenario table, run against both this
// file's subject (src/lib/home.mjs) and the TypeScript original, is agent/test/core/home.test.ts; this keeps the desktop suite self-contained.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daebotHome, migrateHome } from "../src/lib/home.mjs";
import { AccountStore, accountsPath, dataDirFor } from "../src/lib/accounts.mjs";
import { keyPath, readKey, saveKey } from "../src/lib/credentials.mjs";
import { configPath, statePath } from "../src/lib/config.mjs";

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "dae-home-")));
const KEY = "mind_" + "k".repeat(24);

function oldInstall(home) {
  const old = join(home, ".mindclaw");
  mkdirSync(old, { recursive: true, mode: 0o700 });
  writeFileSync(join(old, "mind-key"), KEY + "\n", { mode: 0o600 });
  writeFileSync(join(old, "desktop.json"), '{"keepWorking":false}\n', { mode: 0o600 });
}

test("every desktop path lives under ~/.daebot", () => {
  const env = { HOME: "/h" };
  assert.equal(daebotHome(env), "/h/.daebot");
  assert.equal(configPath(env), "/h/.daebot/desktop.json");
  assert.equal(statePath(env), "/h/.daebot/desktop-state.json");
  assert.equal(accountsPath(env), "/h/.daebot/accounts.json");
  assert.equal(keyPath(env), "/h/.daebot/mind-key");
  assert.equal(dataDirFor({ id: "a_x" }, env), "/h/.daebot/accounts/a_x/data");
  assert.equal(keyPath({ HOME: "/h", DAEBOT_HOME: "/d" }), "/d/mind-key");
  assert.equal(keyPath({ HOME: "/h", MINDCLAW_DESKTOP_HOME: "/m" }), "/m/mind-key");
});

test("a signed-in pre-rename install keeps its key and settings after the move", () => {
  const home = scratch();
  oldInstall(home);
  const env = { HOME: home };
  assert.equal(readKey(keyPath(env)), KEY, "before the move the old folder is still read");
  const lines = [];
  const r = migrateHome(env, (l) => lines.push(l));
  assert.equal(r.action, "migrated");
  assert.equal(r.linked, true);
  assert.equal(lines.length, 1);
  assert.equal(readKey(keyPath(env)), KEY, "same key, now from ~/.daebot");
  assert.equal(keyPath(env), join(home, ".daebot", "mind-key"));
  assert.equal(readFileSync(join(home, ".daebot", "desktop.json"), "utf8"), '{"keepWorking":false}\n');
  assert.equal(lstatSync(join(home, ".mindclaw")).isSymbolicLink(), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(home, ".daebot")).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, ".daebot", "mind-key")).mode & 0o777, 0o600);
  }
  // new writes land in ~/.daebot, not behind the link
  const store = new AccountStore(accountsPath(env));
  store.save({ v: 1, active: null, accounts: [], legacyName: "" });
  assert.equal(existsSync(join(home, ".daebot", "accounts.json")), true);
  saveKey(KEY, keyPath(env));
  if (process.platform !== "win32") assert.equal(statSync(keyPath(env)).mode & 0o777, 0o600);
});

test("a failed move keeps the old folder for the whole run, including the gateway child that inherits the environment", () => {
  const home = scratch();
  oldInstall(home);
  const env = { HOME: home };
  const lines = [];
  const r = migrateHome(env, (l) => lines.push(l), { renameSync: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); }, symlinkSync: () => { throw new Error("unreachable"); }, platform: "win32" });
  assert.equal(r.action, "kept-legacy");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /EBUSY/);
  assert.equal(readKey(keyPath(env)), KEY);
  assert.equal(env.DAEBOT_HOME, join(home, ".mindclaw"));
  assert.equal(daebotHome(env), join(home, ".mindclaw"));
});

test("both folders present: the new one is used and the old one is not touched", () => {
  const home = scratch();
  oldInstall(home);
  mkdirSync(join(home, ".daebot"));
  assert.equal(migrateHome({ HOME: home }, () => assert.fail("silent")).action, "current");
  assert.equal(daebotHome({ HOME: home }), join(home, ".daebot"));
  assert.equal(lstatSync(join(home, ".mindclaw")).isDirectory(), true);
  assert.equal(readKey(join(home, ".mindclaw", "mind-key")), KEY);
});
