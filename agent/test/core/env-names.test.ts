import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_ENV, canonEnv, detectEnv, envViews, groupDevices, osLabel, prettyHost } from "../../src/env.ts";
import { RemoteHub } from "../../src/remote/hub.ts";

const eg: any = await import(new URL("../../web/envgroups.js", import.meta.url).href);
const ID = (c: string) => "d_" + c.repeat(16);

test("naming per OS: the name the person gave the computer, never a guess", () => {
  // macOS: ComputerName wins; the hostname's "-7" and ".local" are cleaned when only the hostname is known
  assert.equal(detectEnv({ platform: "darwin", hostname: "Anthonys-MacBook-Pro-7.local", computerName: "Anthony's MacBook Pro", env: {}, deviceId: ID("a") }).name, "Anthony's MacBook Pro");
  assert.equal(detectEnv({ platform: "darwin", hostname: "Anthonys-MacBook-Pro-7.local", env: {}, deviceId: ID("a") }).name, "Anthonys MacBook Pro");
  assert.equal(prettyHost("Macs-MacBook-Air-2.local"), "Macs MacBook Air");
  assert.equal(prettyHost("Atlas-PC-2"), "Atlas PC 2", "a number that is part of a name stays");
  // Windows: the PC name (COMPUTERNAME) as the person set it
  assert.equal(detectEnv({ platform: "win32", hostname: "LEGION", computerName: "Legion", env: {}, deviceId: ID("b") }).name, "Legion");
  assert.equal(detectEnv({ platform: "win32", hostname: "LEGION-5", env: {}, deviceId: ID("b") }).name, "LEGION 5");
  assert.equal(detectEnv({ platform: "win32", hostname: "x", env: { COMPUTERNAME: "x" }, computerName: "Legion Laptop", deviceId: ID("b") }).kind, "machine");
  // Linux: a desktop is a computer named by its hostname; a headless box is a server that keeps its hostname
  assert.deepEqual(detectEnv({ platform: "linux", hostname: "thinkpad", env: { DISPLAY: ":0" }, deviceId: ID("c") }), { id: ID("c"), kind: "machine", name: "thinkpad" });
  assert.deepEqual(detectEnv({ platform: "linux", hostname: "ubuntu-droplet-45", env: {}, deviceId: ID("d") }), { id: ID("d"), kind: "server", name: "ubuntu-droplet-45" });
  // the hosted service is MIND Cloud, whatever it is called
  assert.deepEqual(detectEnv({ hosted: true, hostname: "srv-abc", platform: "linux" }), CLOUD_ENV);
  assert.equal(osLabel("darwin"), "mac"); assert.equal(osLabel("win32"), "windows"); assert.equal(osLabel("linux"), "linux");
});

const dev = (id: string, name: string, extra: object = {}) => ({ id, name, slugs: [] as string[], ...extra });

test("rename sync: a rename made from one device shows on every device of the account, survives a restart, and an app update's new name does not undo it", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-"));
  let t = 1_000_000;
  const hub = new RemoteHub({ dir, now: () => t });
  hub.heartbeat("o1", dev(ID("a"), "ATLAS DAEBOT", { kind: "machine", os: "windows", model: "Legion 5 15ITH6" }));
  hub.heartbeat("o1", dev(ID("b"), "Mac’s MacBook Air", { kind: "machine", os: "mac" }));
  // device A renames device B's environment, as the person did from the sidebar header
  assert.equal(hub.renameEnv("o1", ID("b"), "  Front desk   Mac "), true);
  assert.equal(hub.renameEnv("o1", "nope", "x"), false, "an unknown environment is refused");
  // "the second client": the same account read again from another device's poll
  assert.deepEqual(hub.envGroups("o1").map((g) => g.name).sort(), ["ATLAS DAEBOT", "Front desk Mac"]);
  // restart: a new hub on the same disk
  const hub2 = new RemoteHub({ dir, now: () => t });
  assert.deepEqual(hub2.envGroups("o1").map((g) => g.name).sort(), ["ATLAS DAEBOT", "Front desk Mac"]);
  // the desktop updates and reports a different automatic name: the person's name stays
  hub2.heartbeat("o1", dev(ID("b"), "Macs MacBook Air 2", { kind: "machine" }));
  assert.ok(hub2.envGroups("o1").some((g) => g.name === "Front desk Mac" && g.members.includes(ID("b"))));
  // another account never sees it
  assert.deepEqual(hub2.envGroups("o2"), []);
  // an empty name puts the automatic one back
  assert.equal(hub2.renameEnv("o1", ID("b"), ""), true);
  assert.ok(hub2.envGroups("o1").some((g) => g.name === "Macs MacBook Air 2"));
  // MIND Cloud can be renamed too, and cleared
  hub2.renameEnv("o1", "cloud", "Cloud"); assert.equal(hub2.cloudName("o1"), "Cloud");
  hub2.renameEnv("o1", "cloud", ""); assert.equal(hub2.cloudName("o1"), undefined);
});

test("a user rename beats the automatic name, also when a reinstall registers the same computer again under a new id", () => {
  const devices = [
    { id: ID("a"), name: "ATLAS DAEBOT", host: "ATLAS-DAEBOT", kind: "machine" as const, lastSeen: 100, online: false },
    { id: ID("e"), name: "ATLAS DAEBOT", host: "ATLAS-DAEBOT", kind: "machine" as const, lastSeen: 200, online: true },
  ];
  const groups = groupDevices(devices, { [ID("a")]: "Legion" });
  assert.equal(groups.length, 1, "one computer");
  assert.equal(groups[0].name, "Legion");
  assert.equal(canonEnv({ id: ID("e"), kind: "machine", name: "ATLAS DAEBOT" }, groups)!.name, "Legion", "a stored tag shows the renamed name");
});

test("the device record carries what it said about itself (os, model, host) through to the environment list", () => {
  const hub = new RemoteHub({ now: () => 5000 });
  hub.heartbeat("o1", dev(ID("a"), "Legion", { kind: "machine", os: "windows", model: "Legion 5 15ITH6", host: "LEGION-5" }));
  hub.heartbeat("o1", dev(ID("a"), "Legion", { kind: "machine" }));
  const d = hub.devices("o1")[0];
  assert.equal(d.os, "windows"); assert.equal(d.model, "Legion 5 15ITH6", "a later poll that does not say keeps what was said");
  const g = hub.envGroups("o1");
  const v = envViews(g.map((x) => ({ id: x.id, kind: x.kind, name: x.name })), { id: ID("z"), kind: "machine", name: "Here" }, { cloudOnline: true, devices: new Map(g.map((x) => [x.id, x.online] as const)), info: new Map(g.map((x) => [x.id, { lastSeen: x.lastSeen, os: x.os, model: x.model, host: x.host }] as const)) });
  const leg = v.find((e) => e.id === ID("a"))!;
  assert.equal(leg.lastSeen, 5000); assert.equal(leg.os, "windows"); assert.equal(leg.model, "Legion 5 15ITH6");
});

test("dots: green = this computer, blue = another computer or server, neutral = MIND Cloud, dimmed = offline", () => {
  const here = { id: ID("a"), kind: "machine", name: "Legion", online: true, current: true };
  const other = { id: ID("b"), kind: "machine", name: "Mac", online: true, current: false };
  const box = { id: ID("c"), kind: "server", name: "droplet", online: true, current: false };
  const gone = { id: ID("d"), kind: "machine", name: "Old PC", online: false, current: false };
  const cloud = { id: "cloud", kind: "cloud", name: "MIND Cloud", online: true, current: false };
  assert.equal(eg.dotKind(here), "here");
  assert.equal(eg.dotKind(other), "remote");
  assert.equal(eg.dotKind(box), "remote");
  assert.equal(eg.dotKind(cloud), "cloud");
  assert.equal(eg.dotKind({ ...cloud, current: true }), "cloud", "the web client is on MIND Cloud: neutral, never the computer green");
  assert.equal(eg.dotKind(gone), "offline");
  assert.equal(eg.dotKind({ ...cloud, online: false }), "offline");
  // the sidebar header carries the class, and tells a person where they are
  const model = eg.groupByEnv([{ id: "s", env: other }, { id: "t", env: here }], [here, other, cloud]);
  assert.equal(model.groups[0].env.id, ID("a"), "this computer first");
  assert.equal(eg.lastSeenText(1_000_000, 1_000_000 + 5 * 60_000), "5 min ago");
  assert.match(eg.envDescription({ ...other, os: "mac", lastSeen: 0 }), /Mac \(computer, macOS\)/);
  assert.match(eg.envDescription({ ...here, os: "windows", model: "Legion 5" }), /Legion \(computer, Windows, Legion 5\), this computer/);
});
