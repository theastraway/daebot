import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_ENV, canonEnv, detectEnv, envOf, envViews, groupDevices, normalizeEnv, prettyHost, readComputerName, tidyName } from "../../src/env.ts";
import type { DeviceLike } from "../../src/env.ts";
import { homeSig, mergeRecords } from "../../src/sync/merge.ts";
import { rec } from "../sync/helpers.ts";

test("detectEnv: hosted is MIND Cloud; a computer is a machine named by its hostname; a headless Linux box is a server", () => {
  assert.deepEqual(detectEnv({ hosted: true }), CLOUD_ENV);
  const mac = detectEnv({ hostname: "Anthonys-MacBook-Pro.local", platform: "darwin", env: {}, deviceId: "d_" + "a".repeat(16) });
  assert.deepEqual(mac, { id: "d_" + "a".repeat(16), kind: "machine", name: "Anthonys MacBook Pro" });
  const win = detectEnv({ hostname: "ATLAS-PC", platform: "win32", env: {} });
  assert.equal(win.kind, "machine");
  assert.match(win.id, /^d_[0-9a-f]{16}$/);
  const drop = detectEnv({ hostname: "ubuntu-s-2vcpu-nyc3", platform: "linux", env: {} });
  assert.equal(drop.kind, "server");
  assert.equal(drop.name, "ubuntu-s-2vcpu-nyc3", "a server keeps its hostname as is");
  assert.equal(detectEnv({ hostname: "box", platform: "linux", env: { DISPLAY: ":0" } }).kind, "machine", "a Linux desktop is a machine");
  assert.deepEqual(detectEnv({ hostname: "x", platform: "darwin", env: { DAEBOT_ENV_KIND: "server", DAEBOT_ENV_NAME: "  Droplet 45  " } }).name, "Droplet 45");
  assert.equal(detectEnv({ hostname: "x", platform: "darwin", env: { DAEBOT_ENV_KIND: "server" } }).kind, "server");
  assert.equal(detectEnv({ hostname: "same", platform: "linux", env: {} }).id, detectEnv({ hostname: "same", platform: "linux", env: {} }).id, "the id is stable");
});

test("prettyHost + normalizeEnv: only well-formed tags get through", () => {
  assert.equal(prettyHost("Atlas-Windows-PC.lan"), "Atlas Windows PC");
  assert.equal(prettyHost(""), "This computer");
  assert.deepEqual(normalizeEnv({ id: "cloud", kind: "cloud", name: "MIND Cloud" }), CLOUD_ENV);
  assert.equal(normalizeEnv({ id: "d_1", kind: "planet", name: "x" }), undefined);
  assert.equal(normalizeEnv({ id: "../x", kind: "machine", name: "x" }), undefined);
  assert.equal(normalizeEnv({ id: "other", kind: "cloud", name: "x" }), undefined, "only one cloud");
  assert.equal(normalizeEnv({ id: "d_1", kind: "machine", name: "   " }), undefined);
  assert.equal(normalizeEnv("nope"), undefined);
  assert.equal(normalizeEnv({ id: "d_1", kind: "machine", name: "a\u0000b\n c" })!.name, "ab c");
  assert.deepEqual(envOf({}, CLOUD_ENV), CLOUD_ENV, "a record with no home belongs to the fallback");
});

test("envViews: the current one is marked and online, cloud follows reachability, devices follow their poll", () => {
  const cur = { id: "d_1", kind: "machine" as const, name: "Mac" };
  const v = envViews([CLOUD_ENV, { id: "d_2", kind: "machine", name: "PC" }, { id: "d_3", kind: "server", name: "drop" }], cur, { cloudOnline: false, devices: new Map([["d_2", true]]) });
  const by = Object.fromEntries(v.map((e) => [e.id, e]));
  assert.equal(by.d_1.current, true); assert.equal(by.d_1.online, true);
  assert.equal(by.cloud.online, false);
  assert.equal(by.d_2.online, true);
  assert.equal(by.d_3.online, false);
  assert.equal(v.length, 4, "no duplicates");
});

test("merge: a home is never lost or flipped; two homes settle on one; the later pin decision wins even against newer messages", () => {
  const mac = { id: "d_1", kind: "machine" as const, name: "Mac" };
  const a = rec("s", { updatedAt: 100, createdAt: 10, env: mac, texts: [["u1", "hi"]] });
  const b = rec("s", { updatedAt: 200, createdAt: 10, texts: [["u1", "hi"], ["a1", "yo"]] });
  assert.deepEqual(mergeRecords(a, b).env, mac, "the side with no home takes the other's");
  assert.deepEqual(mergeRecords(b, a).env, mac);
  const x = rec("s", { createdAt: 5, env: mac }), y = rec("s", { createdAt: 9, env: CLOUD_ENV });
  assert.deepEqual(mergeRecords(x, y).env, mac); assert.deepEqual(mergeRecords(y, x).env, mac, "both sides settle on the older record's home");
  const late = rec("s", { createdAt: 99, env: mac }), early = rec("s", { createdAt: 1, env: CLOUD_ENV });
  assert.deepEqual(mergeRecords(late, early).env, mac, "a computer beats the cloud even when the cloud stamp is older (cloud is also the assumed home)");
  assert.deepEqual(mergeRecords(early, late).env, mac);
  const pc = { id: "d_2", kind: "machine" as const, name: "PC" };
  assert.deepEqual(mergeRecords(rec("s", { createdAt: 5, env: mac }), rec("s", { createdAt: 9, env: pc })).env, mac, "two computers: the older stands");
  // pin on A (metaAt later) vs newer messages on B: the pin stays
  const pinned = rec("s", { updatedAt: 100, metaAt: 500, pinnedAt: 500, texts: [["u1", "hi"]] });
  const newer = rec("s", { updatedAt: 900, texts: [["u1", "hi"], ["a1", "yo"]] });
  assert.equal(mergeRecords(pinned, newer).pinnedAt, 500); assert.equal(mergeRecords(newer, pinned).pinnedAt, 500);
  const unpinned = rec("s", { updatedAt: 100, metaAt: 800, texts: [["u1", "hi"]] });
  assert.equal(mergeRecords(pinned, unpinned).pinnedAt, undefined, "a later unpin wins");
  assert.notEqual(homeSig(pinned), homeSig(unpinned));
});

test("tidyName: a network domain goes, a raw hostname becomes words, a person's own name is left alone, a server keeps its hostname", () => {
  assert.equal(tidyName("Anthonys MBP 7.mynetworksettings.com"), "Anthonys MBP 7");
  assert.equal(tidyName("Anthonys-MBP-7.mynetworksettings.com"), "Anthonys MBP 7");
  assert.equal(tidyName("Macs-MacBook-Air.local"), "Macs MacBook Air");
  assert.equal(tidyName("Anthonys MacBook Pro"), "Anthonys MacBook Pro");
  assert.equal(tidyName("Dr. Smith's Mac"), "Dr. Smith's Mac");
  assert.equal(tidyName("Mac 2.0"), "Mac 2.0");
  assert.equal(tidyName("droplet-45.nyc3.example.com", "server"), "droplet-45");
  assert.equal(tidyName("droplet-45", "server"), "droplet-45");
  assert.equal(normalizeEnv({ id: "d_1", kind: "machine", name: "Anthonys MBP 7.mynetworksettings.com" })!.name, "Anthonys MBP 7", "a stored tag with a hostname shows tidy");
  assert.equal(detectEnv({ hostname: "Anthonys-MBP-7.mynetworksettings.com", platform: "darwin", env: {} }).name, "Anthonys MBP 7");
});

test("detectEnv: the name the person gave the computer (macOS Computer Name, Windows device name) wins over the hostname", () => {
  const e = detectEnv({ hostname: "Anthonys-MBP-7.mynetworksettings.com", platform: "darwin", env: {}, computerName: "Anthonys MacBook Pro" });
  assert.equal(e.name, "Anthonys MacBook Pro");
  assert.equal(e.kind, "machine");
  assert.equal(detectEnv({ hostname: "x", platform: "linux", env: {}, computerName: "ignored on a server" }).kind, "server");
  assert.equal(readComputerName("win32", { COMPUTERNAME: "ATLAS-PC-3" }), "ATLAS-PC-3");
  assert.equal(readComputerName("linux", {}), undefined);
});

test("groupDevices: registrations of one computer become one place; a person's rename wins; servers and other computers stay apart", () => {
  const d = (id: string, name: string, lastSeen: number, o: Partial<DeviceLike> = {}): DeviceLike => ({ id, name, lastSeen, online: false, ...o });
  const devs: DeviceLike[] = [
    d("d_a", "Anthonys-MBP-7.mynetworksettings.com", 100),
    d("d_b", "Anthonys MBP 7.mynetworksettings.com", 200),
    d("d_c", "Anthonys-MBP-7.mynetworksettings.com", 50),
    d("d_new", "Anthonys MacBook Pro", 300, { host: "Anthonys-MBP-7.mynetworksettings.com", online: true }),
    d("d_old", "Anthonys MacBook Pro", 10),
    d("d_air", "Macs-MacBook-Air.local", 150),
    d("d_srv", "droplet-45", 120, { kind: "server" }),
  ];
  const g = groupDevices(devs);
  assert.equal(g.length, 3, "one MacBook Pro, one Air, one droplet");
  const pro = g.find((x) => x.members.includes("d_a"))!;
  assert.deepEqual([...pro.members].sort(), ["d_a", "d_b", "d_c", "d_new", "d_old"]);
  assert.equal(pro.name, "Anthonys MacBook Pro", "the friendly name beats the hostname");
  assert.equal(pro.id, "d_new", "the one online (else latest) represents the group");
  assert.equal(pro.online, true);
  assert.equal(g.find((x) => x.members.includes("d_air"))!.name, "Macs MacBook Air");
  assert.equal(g.find((x) => x.kind === "server")!.name, "droplet-45");
  const renamed = groupDevices(devs, { d_a: "Work laptop" }).find((x) => x.members.includes("d_a"))!;
  assert.equal(renamed.name, "Work laptop");
  // a tag stored with any old id or the old hostname lands in the same place
  assert.deepEqual(canonEnv({ id: "d_c", kind: "machine", name: "x" }, g), { id: "d_new", kind: "machine", name: "Anthonys MacBook Pro" });
  assert.deepEqual(canonEnv({ id: "d_zzz", kind: "machine", name: "Anthonys MBP 7.mynetworksettings.com" }, g), { id: "d_new", kind: "machine", name: "Anthonys MacBook Pro" });
  assert.deepEqual(canonEnv({ id: "d_unknown", kind: "machine", name: "Some PC" }, g), { id: "d_unknown", kind: "machine", name: "Some PC" });
  assert.equal(canonEnv({ id: "cloud", kind: "cloud", name: "MIND Cloud" }, g, "Our cloud")!.name, "Our cloud");
  assert.equal(canonEnv("junk", g), undefined);
});
