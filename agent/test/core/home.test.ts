// Daebot's home folder: ~/.daebot, with a one-time, non-destructive move of a pre-rename ~/.mindclaw.
// The same scenarios run against the TypeScript helper (agent/src/home.ts) and its plain-JS mirror used by the desktop app
// (agent/desktop/src/lib/home.mjs), so the two cannot drift apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as tsHome from "../../src/home.ts";
import { dataDir } from "../../src/persist.ts";
import { configFilePath } from "../../src/config.ts";
import { defaultHistoryPath } from "../../src/ui/history.ts";
import { defaultTokenPath } from "../../src/gateway/auth.ts";
import { loadChannelsConfig } from "../../src/channels/common.ts";

const here = dirname(fileURLToPath(import.meta.url));
const mjsHome = await import(pathToFileURL(join(here, "../../desktop/src/lib/home.mjs")).href);
const IMPLS: Array<[string, typeof tsHome]> = [["home.ts", tsHome], ["desktop home.mjs", mjsHome]];
const posix = process.platform !== "win32";

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "daebot-home-")));
/** A pre-rename install: ~/.mindclaw with a config, a token (0600) and a saved chat, the folder 0700. */
function oldInstall(home: string): void {
  const old = join(home, ".mindclaw");
  mkdirSync(join(old, "data", "sessions"), { recursive: true, mode: 0o700 });
  chmodSync(old, 0o700);
  writeFileSync(join(old, "config.json"), '{"mindBaseUrl":"https://example.test/v1"}\n', { mode: 0o600 });
  writeFileSync(join(old, "gateway-token"), "a".repeat(64) + "\n", { mode: 0o600 });
  writeFileSync(join(old, "data", "sessions", "s1.json"), '{"id":"s1"}\n', { mode: 0o600 });
}
const quiet = () => { const lines: string[] = []; return { lines, log: (l: string) => { lines.push(l); } }; };
const err = (code: string) => Object.assign(new Error(code), { code });

for (const [name, h] of IMPLS) {
  test(`${name}: fresh install uses ~/.daebot and creates nothing`, () => {
    const home = scratch();
    assert.equal(h.daebotHome({ HOME: home }), join(home, ".daebot"));
    const q = quiet();
    const r = h.migrateHome({ HOME: home }, q.log);
    assert.deepEqual(r, { home: join(home, ".daebot"), action: "fresh" });
    assert.deepEqual(readdirSync(home), [], "neither folder is created by a lookup or a no-op migrate");
    assert.deepEqual(q.lines, []);
  });

  test(`${name}: DAEBOT_HOME wins, then the older MINDCLAW_DESKTOP_HOME, then ~/.daebot; an override moves nothing`, () => {
    const home = scratch();
    oldInstall(home);
    assert.equal(h.daebotHome({ HOME: home, DAEBOT_HOME: "/x/a", MINDCLAW_DESKTOP_HOME: "/x/b" }), "/x/a");
    assert.equal(h.daebotHome({ HOME: home, MINDCLAW_DESKTOP_HOME: "/x/b" }), "/x/b");
    assert.equal(h.daebotHome({ HOME: home, DAEBOT_HOME: "   ", MINDCLAW_DESKTOP_HOME: "" }), join(home, ".mindclaw"), "blank overrides are ignored");
    const env = { HOME: home, DAEBOT_HOME: "/x/a" };
    assert.deepEqual(h.migrateHome(env, () => assert.fail("an override logs nothing")), { home: "/x/a", action: "override" });
    assert.equal(lstatSync(join(home, ".mindclaw")).isDirectory(), true, "the old folder is untouched");
    assert.equal(existsSync(join(home, ".daebot")), false);
  });

  test(`${name}: migrate renames ~/.mindclaw to ~/.daebot, leaves a link behind, keeps modes and contents, and is idempotent`, () => {
    const home = scratch();
    oldInstall(home);
    const env: Record<string, string | undefined> = { HOME: home };
    assert.equal(h.daebotHome(env), join(home, ".mindclaw"), "until it is moved, the old folder is what is used");
    const q = quiet();
    const r = h.migrateHome(env, q.log);
    assert.deepEqual(r, { home: join(home, ".daebot"), action: "migrated", linked: true });
    assert.equal(q.lines.length, 1);
    assert.match(q.lines[0], /moved .*\.mindclaw to .*\.daebot/);
    assert.equal(lstatSync(join(home, ".mindclaw")).isSymbolicLink(), true);
    assert.equal(realpathSync(join(home, ".mindclaw")), join(home, ".daebot"));
    assert.equal(readFileSync(join(home, ".daebot", "config.json"), "utf8"), '{"mindBaseUrl":"https://example.test/v1"}\n');
    assert.equal(readFileSync(join(home, ".mindclaw", "data", "sessions", "s1.json"), "utf8"), '{"id":"s1"}\n', "an older Daebot reading the old path still finds its chats");
    if (posix) {
      assert.equal(statSync(join(home, ".daebot")).mode & 0o777, 0o700);
      assert.equal(statSync(join(home, ".daebot", "gateway-token")).mode & 0o777, 0o600);
      assert.equal(statSync(join(home, ".daebot", "config.json")).mode & 0o777, 0o600);
    }
    assert.equal(h.daebotHome(env), join(home, ".daebot"));
    assert.equal(env.DAEBOT_HOME, undefined, "a successful move pins nothing");
    // second run: nothing happens, no log line
    const again = quiet();
    assert.deepEqual(h.migrateHome(env, again.log), { home: join(home, ".daebot"), action: "current" });
    assert.deepEqual(again.lines, []);
    assert.equal(readlinkSync(join(home, ".mindclaw")), join(home, ".daebot"));
  });

  test(`${name}: both folders exist -> ~/.daebot is used and ~/.mindclaw is never touched`, () => {
    const home = scratch();
    oldInstall(home);
    mkdirSync(join(home, ".daebot"), { mode: 0o700 });
    writeFileSync(join(home, ".daebot", "marker"), "new\n");
    const before = readdirSync(join(home, ".mindclaw"), { recursive: true }).sort();
    assert.equal(h.daebotHome({ HOME: home }), join(home, ".daebot"));
    assert.deepEqual(h.migrateHome({ HOME: home }, () => assert.fail("no log")), { home: join(home, ".daebot"), action: "current" });
    assert.equal(lstatSync(join(home, ".mindclaw")).isDirectory(), true, "still a real directory, not replaced by a link");
    assert.deepEqual(readdirSync(join(home, ".mindclaw"), { recursive: true }).sort(), before);
    assert.deepEqual(readdirSync(join(home, ".daebot")), ["marker"], "nothing was merged into the new folder");
  });

  test(`${name}: a failed rename keeps ~/.mindclaw for this run, logs one line, pins the run, and loses nothing`, () => {
    const home = scratch();
    oldInstall(home);
    const env: Record<string, string | undefined> = { HOME: home };
    const q = quiet();
    const r = h.migrateHome(env, q.log, { renameSync: () => { throw err("EXDEV"); }, symlinkSync: () => assert.fail("no link when nothing moved"), platform: "darwin" });
    assert.deepEqual(r, { home: join(home, ".mindclaw"), action: "kept-legacy", error: "EXDEV" });
    assert.equal(q.lines.length, 1);
    assert.match(q.lines[0], /EXDEV/);
    assert.equal(existsSync(join(home, ".daebot")), false);
    assert.equal(readFileSync(join(home, ".mindclaw", "data", "sessions", "s1.json"), "utf8"), '{"id":"s1"}\n');
    assert.equal(env.DAEBOT_HOME, join(home, ".mindclaw"), "the gateway child inherits the pin, so both use the same folder");
    assert.equal(h.daebotHome(env), join(home, ".mindclaw"));
    // a later call in the same run does not retry (and so cannot split the run across two folders)
    assert.deepEqual(h.migrateHome(env, () => assert.fail("no second attempt")), { home: join(home, ".mindclaw"), action: "override" });
    // the next run (fresh environment) tries again and succeeds
    assert.equal(h.migrateHome({ HOME: home }, () => {}).action, "migrated");
  });

  test(`${name}: failing to create the link is ignored; Windows gets a junction`, () => {
    const home = scratch();
    oldInstall(home);
    const q = quiet();
    const r = h.migrateHome({ HOME: home }, q.log, { renameSync: (a, b) => { renameSync(a, b); }, symlinkSync: () => { throw err("EPERM"); }, platform: "linux" });
    assert.deepEqual(r, { home: join(home, ".daebot"), action: "migrated", linked: false });
    assert.equal(existsSync(join(home, ".mindclaw")), false);
    assert.equal(readFileSync(join(home, ".daebot", "config.json"), "utf8").includes("example.test"), true);
    assert.equal(q.lines.length, 1);
    assert.doesNotMatch(q.lines[0], /now points at it/);

    const home2 = scratch();
    oldInstall(home2);
    const types: string[] = [];
    h.migrateHome({ HOME: home2 }, () => {}, { renameSync: (a, b) => { renameSync(a, b); }, symlinkSync: (_t, _p, ty) => { types.push(ty); }, platform: "win32" });
    h.migrateHome({ HOME: scratch() }, () => {}, { renameSync: () => assert.fail("nothing to move"), symlinkSync: () => assert.fail("nothing to link"), platform: "win32" });
    assert.deepEqual(types, ["junction"]);
    const home3 = scratch();
    oldInstall(home3);
    h.migrateHome({ HOME: home3 }, () => {}, { renameSync: (a, b) => { renameSync(a, b); }, symlinkSync: (_t, _p, ty) => { types.push(ty); }, platform: "darwin" });
    assert.deepEqual(types, ["junction", "dir"]);
  });

  test(`${name}: another process moving it first is not an error; a symlinked or dangling ~/.mindclaw is left alone`, () => {
    const home = scratch();
    oldInstall(home);
    const r = h.migrateHome({ HOME: home }, () => assert.fail("no log"), {
      renameSync: (a, b) => { renameSync(a, b); throw err("ENOENT"); }, // the other process won the rename; ours reports the vanished source
      symlinkSync: () => assert.fail("not ours to link"), platform: "linux",
    });
    assert.deepEqual(r, { home: join(home, ".daebot"), action: "current" });

    const elsewhere = scratch();
    mkdirSync(join(elsewhere, "mine"));
    const home2 = scratch();
    symlinkSync(join(elsewhere, "mine"), join(home2, ".mindclaw"), "dir");
    assert.equal(h.daebotHome({ HOME: home2 }), join(home2, ".mindclaw"), "the user's own link to a folder is kept in use");
    assert.deepEqual(h.migrateHome({ HOME: home2 }, () => assert.fail("no log")), { home: join(home2, ".mindclaw"), action: "legacy-link" });
    assert.equal(existsSync(join(home2, ".daebot")), false);

    const home3 = scratch();
    symlinkSync(join(home3, "gone"), join(home3, ".mindclaw"), "dir");
    assert.equal(h.daebotHome({ HOME: home3 }), join(home3, ".daebot"));
    assert.equal(h.migrateHome({ HOME: home3 }, () => {}).action, "fresh");
  });
}

test("home.ts and home.mjs agree on every answer for the same scenarios", () => {
  for (const setup of [(_h: string) => {}, oldInstall, (h: string) => { oldInstall(h); mkdirSync(join(h, ".daebot")); }]) {
    for (const extra of [{}, { DAEBOT_HOME: "/o/a" }, { MINDCLAW_DESKTOP_HOME: "/o/b" }, { DAEBOT_HOME: "/o/a", MINDCLAW_DESKTOP_HOME: "/o/b" }]) {
      const a = scratch(); const b = scratch();
      setup(a); setup(b);
      const envA = { HOME: a, ...extra }; const envB = { HOME: b, ...extra };
      const strip = (r: { home: string }, h: string) => ({ ...r, home: r.home.replace(h, "<HOME>") });
      assert.equal(tsHome.daebotHome(envA).replace(a, "<HOME>"), mjsHome.daebotHome(envB).replace(b, "<HOME>"));
      assert.deepEqual(strip(tsHome.migrateHome(envA, () => {}), a), strip(mjsHome.migrateHome(envB, () => {}), b));
    }
  }
});

test("the modules that keep files in the home folder all resolve through it (~/.daebot, honouring DAEBOT_HOME)", () => {
  const home = scratch();
  const env = { HOME: home };
  assert.equal(dataDir(env), join(home, ".daebot", "data"));
  assert.equal(dataDir({ ...env, DATA_DIR: "/data" }), "/data", "hosted: DATA_DIR still wins");
  assert.equal(configFilePath(env), join(home, ".daebot", "config.json"));
  assert.equal(configFilePath({ ...env, MINDCLAW_CONFIG: "/etc/c.json" }), "/etc/c.json");
  assert.equal(defaultHistoryPath(env), join(home, ".daebot", "history"));
  assert.equal(defaultHistoryPath({ ...env, MINDCLAW_HISTORY: "/h" }), "/h");
  assert.equal(dataDir({ ...env, DAEBOT_HOME: "/srv/d" }), join("/srv/d", "data"));
  // channels.json: read from the home folder, overlaid with env
  mkdirSync(join(home, ".daebot"));
  writeFileSync(join(home, ".daebot", "channels.json"), JSON.stringify({ telegram: { token: "from-file" } }));
  assert.equal(loadChannelsConfig({ HOME: home }).telegram?.token, "from-file");
  const prev = process.env.HOME;
  process.env.HOME = home;
  try { assert.equal(defaultTokenPath(), join(home, ".daebot", "gateway-token")); } finally { if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev; }
});

test("an un-migrated install is still read from ~/.mindclaw (nothing starts empty before the move)", () => {
  const home = scratch();
  oldInstall(home);
  const env = { HOME: home };
  assert.equal(dataDir(env), join(home, ".mindclaw", "data"));
  assert.equal(configFilePath(env), join(home, ".mindclaw", "config.json"));
  tsHome.migrateHome(env, () => {});
  assert.equal(dataDir(env), join(home, ".daebot", "data"));
  assert.equal(readFileSync(join(dataDir(env), "sessions", "s1.json"), "utf8"), '{"id":"s1"}\n');
});

test("only home.ts / home.mjs spell the folder names; every other module goes through daebotHome()", () => {
  const roots = [join(here, "../../src"), join(here, "../../desktop/src")];
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|mjs|cjs|js)$/.test(e.name) || /^home\.(ts|mjs)$/.test(e.name)) continue;
      const src = readFileSync(p, "utf8");
      // code, not comments: a quoted ".mindclaw" / ".daebot" folder name or a join(..., ".mindclaw", ...) segment
      if (/["'`]\.(mindclaw|daebot)["'`]/.test(src)) hits.push(p);
    }
  };
  for (const r of roots) walk(r);
  assert.deepEqual(hits, [], "build the path with daebotHome(), do not spell the folder");
});
