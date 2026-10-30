import { test } from "node:test";
import assert from "node:assert/strict";

const mb: any = await import(new URL("../../web/mainbot.js", import.meta.url).href);

test("the header look: stock Daebot when nothing is chosen, else the chosen name, face and LED colour", () => {
  assert.deepEqual(mb.mainLook(null), { name: "Daebot", face: mb.mainLook({}).face, accent: "#ffd25a" });
  assert.deepEqual(mb.mainLook({ name: null, face: null, color: null }).name, "Daebot");
  const l = mb.mainLook({ name: "  Dae Prime ", face: "builder", color: "#3B82F6" });
  assert.equal(l.name, "Dae Prime");
  assert.equal(l.accent, "#3b82f6");
  assert.notEqual(l.face, mb.mainLook({}).face, "builder is not the default face");
  assert.equal(mb.mainLook({ color: "javascript:alert(1)" }).accent, "#ffd25a", "only #rrggbb reaches the screen");
});

test("applyMain dresses the brand name and the mascot, and only touches what changed", () => {
  const attrs: Record<string, string> = {};
  const name = { textContent: "Daebot" };
  const m = { getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => { attrs[k] = v; } };
  const root = { querySelector: (q: string) => (q === ".brand-name" ? name : q === "m-bot.brand-bot" ? m : null) };
  mb.applyMain(root, { name: "Dae Prime", face: "builder", color: "#3b82f6" });
  assert.equal(name.textContent, "Dae Prime");
  assert.equal(attrs.accent, "#3b82f6");
  assert.ok(attrs.face);
  mb.applyMain(root, null);
  assert.equal(name.textContent, "Daebot");
  assert.equal(attrs.accent, "#ffd25a");
  mb.applyMain({ querySelector: () => null }, { name: "x" }); // a page without the header: nothing breaks
});
