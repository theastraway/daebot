import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const eg: any = await import(new URL("../../web/envgroups.js", import.meta.url).href);
const rm: any = await import(new URL("../../web/rowmenu.js", import.meta.url).href);
const ss: any = await import(new URL("../../web/sessionsettings.js", import.meta.url).href);
const src = (f: string) => readFileSync(new URL(`../../web/${f}`, import.meta.url), "utf8");

const MAC = { id: "d_1", kind: "machine", name: "Anthonys MacBook Pro" };
const PC = { id: "d_2", kind: "machine", name: "Atlas Windows PC" };
const DROP = { id: "d_3", kind: "server", name: "droplet-45" };
const ENVS = [{ ...MAC, online: true, current: true }, { id: "cloud", kind: "cloud", name: "MIND Cloud", online: true, current: false }, { ...PC, online: false, current: false }, { ...DROP, online: true, current: false }];

test("grouping: the current environment first, then online, then offline; rows keep their order; empty groups are left out", () => {
  const rows = [
    { id: "a", env: PC, updatedAt: 5 }, { id: "b", env: { id: "cloud", kind: "cloud", name: "MIND Cloud" }, updatedAt: 4 },
    { id: "c", env: MAC, updatedAt: 3 }, { id: "d", env: DROP, updatedAt: 2 }, { id: "e", env: MAC, updatedAt: 1 },
  ];
  const g = eg.groupByEnv(rows, ENVS);
  assert.deepEqual(g.groups.map((x: any) => x.env.name), ["Anthonys MacBook Pro", "droplet-45", "MIND Cloud", "Atlas Windows PC"], "current, then online (alphabetical), then offline");
  assert.deepEqual(g.groups[0].rows.map((r: any) => r.id), ["c", "e"]);
  assert.equal(g.groups.find((x: any) => x.env.id === "d_2").env.online, false);
  assert.deepEqual(eg.groupByEnv([], ENVS).groups, []);
});

test("grouping: a row with no home belongs to the current environment; an unknown home is shown offline; junk tags are ignored", () => {
  const g = eg.groupByEnv([{ id: "x" }, { id: "y", env: { id: "d_9", kind: "server", name: "new box" } }, { id: "z", env: { id: "bad id", kind: "x", name: "" } }], ENVS);
  assert.deepEqual(g.groups[0].rows.map((r: any) => r.id), ["x", "z"]);
  const nb = g.groups.find((x: any) => x.env.id === "d_9");
  assert.equal(nb.env.online, false); assert.equal(nb.env.kind, "server");
  // with no server list at all it still works: MIND Cloud
  const solo = eg.groupByEnv([{ id: "q" }], undefined);
  assert.equal(solo.groups[0].env.name, "MIND Cloud");
});

test("pinned rows leave their group for one Pinned section, newest pin first; keep() can hold one back", () => {
  const rows = [{ id: "a", env: MAC, pinnedAt: 10 }, { id: "b", env: PC, pinnedAt: 30 }, { id: "c", env: MAC }, { id: "d", env: DROP, pinnedAt: 20 }];
  const g = eg.groupByEnv(rows, ENVS);
  assert.deepEqual(g.pinned.map((r: any) => r.id), ["b", "d", "a"]);
  assert.deepEqual(g.groups.map((x: any) => x.rows.map((r: any) => r.id)), [["c"]]);
  const held = eg.groupByEnv(rows, ENVS, { keep: (r: any) => r.id !== "a" });
  assert.deepEqual(held.pinned.map((r: any) => r.id), ["b", "d"]);
  assert.ok(held.groups.some((x: any) => x.rows.some((r: any) => r.id === "a")));
});

test("collapse state: per device, round-trips, bad data is ignored", () => {
  const s = new Set(["cloud", "d_2"]);
  assert.deepEqual([...eg.parseCollapsed(eg.serializeCollapsed(s))], ["cloud", "d_2"]);
  assert.equal(eg.parseCollapsed("not json").size, 0);
  assert.deepEqual([...eg.parseCollapsed('["a", 5, null]')], ["a"]);
  assert.equal(eg.kindIcon("cloud"), "i-cloud"); assert.equal(eg.kindIcon("server"), "i-server"); assert.equal(eg.kindIcon("machine"), "i-desktop");
});

test("menu: exactly Settings, Pin, Delete and the Remote switch; Pin flips to Unpin; Remote shows its state or why it is off", () => {
  const items = rm.menuItems({ pinned: false, remote: { state: "off" } });
  assert.deepEqual(items.map((i: any) => i.id), ["settings", "pin", "delete", "remote"]);
  assert.deepEqual(items.map((i: any) => i.label), ["Settings", "Pin", "Delete", "Remote"]);
  assert.equal(items[3].type, "switch"); assert.equal(items[3].checked, false); assert.equal(items[3].disabled, false);
  assert.equal(items[2].danger, true);
  const p = rm.menuItems({ pinned: true, remote: { state: "on", where: "Atlas Windows PC" } });
  assert.equal(p[1].label, "Unpin");
  assert.equal(p[3].checked, true); assert.match(p[3].hint, /Atlas Windows PC/);
  const d = rm.menuItems({ pinned: false, remote: { state: "disabled", reason: "Bots only. No bot owns this chat." } });
  assert.equal(d[3].disabled, true); assert.match(d[3].hint, /No bot/);
  assert.equal(rm.menuItems({ pinned: false }).length, 4, "a missing remote spec is a disabled switch, never a missing item");
});

test("placement: right of the row when it fits, left or below when not, never outside the window", () => {
  const size = { w: 232, h: 190 }, view = { w: 1440, h: 900 };
  const a = rm.placeMenu({ left: 12, top: 300, right: 268, bottom: 344 }, size, view);
  assert.equal(a.side, "right"); assert.equal(a.x, 268 + rm.MENU_GAP);
  const edge = rm.placeMenu({ left: 1200, top: 300, right: 1430, bottom: 344 }, size, view);
  assert.equal(edge.side, "left"); assert.ok(edge.x + size.w <= view.w - rm.EDGE);
  const phone = rm.placeMenu({ left: 0, top: 400, right: 300, bottom: 444 }, size, { w: 390, h: 844 });
  assert.equal(phone.side, "below"); assert.ok(phone.x >= rm.EDGE && phone.x + size.w <= 390 - rm.EDGE);
  const bottom = rm.placeMenu({ left: 0, top: 790, right: 300, bottom: 834 }, size, { w: 390, h: 844 });
  assert.equal(bottom.side, "above"); assert.ok(bottom.y >= rm.EDGE);
  const low = rm.placeMenu({ left: 12, top: 880, right: 268, bottom: 900 }, size, view);
  assert.ok(low.y + size.h <= view.h - rm.EDGE, "a row at the bottom edge still gets a whole menu");
  const high = rm.placeMenu({ left: 12, top: 0, right: 268, bottom: 20 }, size, view);
  assert.ok(high.y >= rm.EDGE);
});

test("settings facts name the home environment", () => {
  assert.deepEqual(ss.settingsFacts({ title: "Plan", pinnedAt: 5 }, { name: "Atlas Windows PC", kind: "machine", online: false }), { title: "Plan", where: "Atlas Windows PC", kind: "Computer", online: false, pinned: true });
  assert.equal(ss.settingsFacts({}, undefined).where, "MIND Cloud");
});

test("wiring: the sidebar groups by environment, rows carry the menu, pin PATCHes the session, Remote PATCHes the bot, delete keeps its confirmation", () => {
  const a = src("app.js"), b = src("bots.js"), m = src("rowmenu.js"), c = src("style.css"), html = src("index.html");
  assert.match(a, /groupByEnv\(shown, state\.envs\)/);
  assert.match(a, /rowMenu\.attach\(row, \(\) => sessionSpec\(s\), sessionActions\(s\)\)/);
  assert.match(a, /JSON\.stringify\(\{ pinned: on \}\)/);
  assert.match(a, /b\.addEventListener\("dblclick"/, "inline rename stays on double-click");
  assert.match(a, /const t = sessionDeleteText\(s\.title\);\s*\n\s*if \(!\(await confirmDialog\(t\)\)\) return;/, "delete still asks first");
  assert.match(a, /\/sessions\/\$\{encodeURIComponent\(s\.id\)\}\?purge=1/, "and still uses the synced-tombstone delete");
  assert.match(a, /state\.envs = r\.envs/);
  assert.match(a, /COLLAPSE_KEY/);
  assert.match(b, /JSON\.stringify\(\{ remote: want \}\)/);
  assert.match(b, /Bots only\. No bot owns this chat\./);
  assert.match(b, /Runs on \$\{bot\.env\.name\}/);
  assert.match(m, /role", "menu"/); assert.match(m, /menuitemcheckbox/); assert.match(m, /"Escape"/); assert.match(m, /ArrowDown/); assert.match(m, /LONG_PRESS_MS/); assert.match(m, /focusin/); assert.match(m, /pointerenter/);
  assert.doesNotMatch(m + src("envgroups.js") + src("sessionsettings.js"), /innerHTML/);
  assert.match(c, /\.rowmenu \{[^}]*position: fixed/); assert.match(c, /prefers-reduced-motion[^}]*\.rowmenu/);
  assert.match(c, /:root\[data-theme="dark"\] \.rowmenu/);
  for (const id of ["i-cloud", "i-server", "i-desktop", "i-pin", "i-gear", "i-trash"]) assert.match(html, new RegExp(`id="${id}"`));
});
