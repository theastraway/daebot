import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnPlan } from "../src/lib/launcher.mjs";
import { TERMINAL_SHOT, IOS_SIM_SHOT, parseDevicesShots, devicesShotsFromArgv, shotFilesFor, shotProbeFor, terminalShotProbe, iosSimShotProbe } from "../src/lib/devices-shots.mjs";

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
  assert.deepEqual(shotFilesFor("browser").files, ["pane-loaded.png", "after-typing.png", "refusal.png", "approval.png", "takeover.png"]);
  assert.deepEqual(shotFilesFor("ios-sim").files, ["fixture-window.png", "fixture-pane.png"]);
  assert.match(shotFilesFor("nope").error, /nope/);
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
  const sim = buildSpawnPlan({ ...base, fake: true, devicesShotsPane: "ios-sim" });
  assert.equal(sim.env.DAEBOT_DEVICES_SHOTS_PANE, "ios-sim");
  assert.equal(sim.env.DAEBOT_SIMULATOR_FAKE, "1");
  assert.equal(sim.env.DAEBOT_DEV_SHOTS, "1");
  const mac = buildSpawnPlan({ ...base, fake: true, devicesShotsPane: "ios-sim", baseEnv: { DAEBOT_IOS_SIM_SHOT_MODE: "needs-mac", DAEBOT_SIMULATOR_FAKE: "1", DAEBOT_DEV_SHOTS: "1" } });
  assert.equal(mac.env.DAEBOT_DEVICES_SHOTS_PANE, "ios-sim");
  assert.equal(mac.env.DAEBOT_SIMULATOR_FAKE, undefined);
  assert.equal(mac.env.DAEBOT_DEV_SHOTS, undefined);
  assert.equal(mac.env.MINDCLAW_DESKTOP_FAKE, "1");
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

test("ios-sim shots name the window and the pane, and the probe checks they do not overlap", () => {
  assert.equal(IOS_SIM_SHOT.device, "iPhone 16");
  assert.deepEqual(shotFilesFor("ios-sim").files, ["fixture-window.png", "fixture-pane.png"]);
  assert.deepEqual(shotFilesFor("ios-sim", { DAEBOT_IOS_SIM_SHOT_MODE: "needs-mac" }).files, ["needs-mac-window.png", "needs-mac-pane.png"]);
  const named = parseDevicesShots(argv("--daebot-devices-shots=/tmp/shots", "--daebot-devices-pane=ios-sim"));
  assert.deepEqual(named, { dir: "/tmp/shots", pane: "ios-sim" });
  const windowShot = shotProbeFor("ios-sim", "fixture-window.png");
  assert.equal(windowShot.fullRect, true);
  assert.equal(windowShot.clip, "");
  const paneShot = shotProbeFor("ios-sim", "needs-mac-pane.png");
  assert.equal(paneShot.clip, "sim-pane");
  assert.equal(paneShot.fullRect, false);
  const probe = iosSimShotProbe("fixture");
  assert.match(probe, /iPhone 16/);
  assert.match(probe, /Fixture\. This picture is not a live simulator\./);
  assert.match(probe, /btn-send/);
  assert.match(probe, /textContent/);
  assert.match(probe, /getBoundingClientRect/);
  assert.doesNotMatch(probe, /innerHTML/);
  assert.match(iosSimShotProbe("needs-mac"), /needs a Mac with Xcode/);
  assert.match(shotProbeFor("terminal", "live.png").script, new RegExp(TERMINAL_SHOT.liveMarker));
  assert.equal(shotProbeFor("terminal", "live.png").timeoutMs, 30_000);
});
