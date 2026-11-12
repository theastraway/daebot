import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const st: any = await import(new URL("../../web/sharedthreads.js", import.meta.url).href);
const rm: any = await import(new URL("../../web/rowmenu.js", import.meta.url).href);
const gw: any = await import(new URL("../../src/gateway/shared-threads.ts", import.meta.url).href);
const src = (f: string) => readFileSync(new URL(`../../web/${f}`, import.meta.url), "utf8");

test("parseSender reads the name the gateway puts in front of a guest's message, and the page and the gateway agree on the mark", () => {
  const t = gw.attribute("bob", "hello there");
  assert.deepEqual(st.parseSender(t), { name: "bob", text: "hello there" });
  assert.deepEqual(st.parseSender("plain words"), { name: "", text: "plain words" });
  assert.deepEqual(st.parseSender("[bob] not a mark"), { name: "", text: "[bob] not a mark" });
  assert.deepEqual(st.parseSender(undefined), { name: "", text: "" });
  assert.equal(st.SENDER_MARK.source, gw.SENDER_MARK.source);
});

test("a shared thread becomes an ordinary chat row, labelled with who shared it and what you may do", () => {
  const t = { id: "s1", title: "Claims run", updatedAt: 5, busy: true, botName: "Sarah", owner: { username: "atlas_adjustments", label: "Atlas" }, role: "viewer" };
  const row = st.asRow(t);
  assert.equal(row.id, "s1");
  assert.equal(row.surface, "shared");
  assert.equal(row.shared.role, "viewer");
  assert.equal(st.sharedMeta(t, () => "now"), "from Atlas · Sarah · now · view only");
  assert.equal(st.sharedMeta({ ...t, role: "editor", botName: "" }, () => ""), "from Atlas");
  assert.equal(st.roleLabel("editor"), "Can post");
  assert.equal(st.roleLabel("viewer"), "View only");
});

test("only threads this browser has not been told about are new, and the first look on a browser announces nothing", () => {
  const list = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(st.unseenThreads(list, new Set(["a"])).map((x: any) => x.id), ["b"]);
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.equal(st.readSeen(storage), null);
  st.writeSeen(storage, new Set(["a", "b"]));
  assert.deepEqual([...st.readSeen(storage)], ["a", "b"]);
});

test("the row menu offers Share thread only on a thread you own, right after Pin", () => {
  const own = rm.menuItems({ pinned: false, share: true, remote: { state: "off" } }).map((i: any) => i.id);
  assert.deepEqual(own.slice(0, 3), ["settings", "pin", "share"]);
  assert.ok(!rm.menuItems({ pinned: false, remote: { state: "off" } }).some((i: any) => i.id === "share"));
});

test("the app wires the section, the menu action and the view-only box", () => {
  const app = src("app.js");
  assert.match(app, /sharedThreads\.renderInto\(els\.list/);
  assert.match(app, /share: \(\) => sharedThreads\.openShare\(s\)/);
  assert.match(app, /shared\.role === "viewer"/);
  assert.match(app, /sharedThreads\.forget\(id\)/);
});
