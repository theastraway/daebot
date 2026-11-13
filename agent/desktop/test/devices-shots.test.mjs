import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnPlan } from "../src/lib/launcher.mjs";
import { TERMINAL_SHOT, parseDevicesShots, devicesShotsFromArgv, shotFilesFor, terminalShotProbe } from "../src/lib/devices-shots.mjs";

const argv = (...flags) => ["electron", ".", ...flags];

test("shots flags are absent, incomplete, or a pane name", () => {
  assert.equal(parseDevicesShots(["electron", "."]), null);
  assert.equal(parseDevicesShots(argv("--mindclaw-smoke")), null);
  const badPane = parseDevicesShots(argv("--daebot-devices-pane=terminal"));
  assert.match(badPane.error, /--daebot-devices-shots/);
  const badDir = parseDevicesShots(argv("--daebot-devices-shots=/tmp/shots"));
  assert.match(badDir.error, /--daebot-devices-pane/);
  const named = parseDevicesShots(argv("--daebot-devices-shots=/tmp/shots", "--daebot-devices-pane=Browser"));
  assert.match(named.error, /Browser/);
  const ok = parseDevicesShots(argv("--daebot-devices-shots=/tmp/shots", "--daebot-devices-pane=terminal"));
  assert.deepEqual(ok, { dir: "/tmp/shots", pane: "terminal" });
  assert.equal(TERMINAL_SHOT.liveMarker, "daebot-terminal-live");
  assert.equal(TERMINAL_SHOT.bottomMarker, "line 40");
});

test("the flags do nothing unless this is the smoke process", () => {
  const flags = argv("--daebot-devices-shots=/tmp/shots", "--daebot-devices-pane=terminal");
  assert.equal(devicesShotsFromArgv(flags, false), null);
  const on = devicesShotsFromArgv(flags, true);
  assert.equal(on.dir, "/tmp/shots");
  assert.equal(on.pane, "terminal");
  assert.equal(on.readyTimeoutMs, 60_000);
  assert.deepEqual(shotFilesFor("terminal").files, ["live.png", "closed.png", "empty.png"]);
  assert.match(shotFilesFor("browser").error, /browser/);
});

test("the spawn plan tells only the fake gateway which pane to seed", () => {
  const base = { agentRoot: "/a", entry: "/e.mjs", kernelMode: "off", nodePath: "/usr/bin/node", electronPath: "/E", baseEnv: {} };
  const plain = buildSpawnPlan(base);
  assert.equal(plain.env.MINDCLAW_DESKTOP_FAKE, undefined);
  assert.equal(plain.env.DAEBOT_DEVICES_SHOTS_PANE, undefined);
  const smoke = buildSpawnPlan({ ...base, fake: true });
  assert.equal(smoke.env.MINDCLAW_DESKTOP_FAKE, "1");
  assert.equal(smoke.env.DAEBOT_DEVICES_SHOTS_PANE, undefined);
  const shots = buildSpawnPlan({ ...base, fake: true, devicesShotsPane: "terminal" });
  assert.equal(shots.env.MINDCLAW_DESKTOP_FAKE, "1");
  assert.equal(shots.env.DAEBOT_DEVICES_SHOTS_PANE, "terminal");
  const ignored = buildSpawnPlan({ ...base, devicesShotsPane: "terminal" });
  assert.equal(ignored.env.DAEBOT_DEVICES_SHOTS_PANE, undefined);
  assert.equal(ignored.env.MINDCLAW_DESKTOP_FAKE, undefined);
});

test("the terminal probe reads text and does not build HTML", () => {
  const live = terminalShotProbe("live");
  assert.match(live, new RegExp(TERMINAL_SHOT.liveMarker));
  assert.match(live, new RegExp(TERMINAL_SHOT.hostile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(live, /textContent/);
  assert.doesNotMatch(live, /innerHTML/);
  assert.match(terminalShotProbe("closed"), /closed-work/);
  assert.match(terminalShotProbe("empty"), /No output yet/);
});
