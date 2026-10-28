import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAppMenuTemplate, buildTrayTemplate, flatten } from "../src/lib/menu.mjs";
import { buildConfirmNotification, createRateLimiter, shouldNotify, validateNotifyPayload } from "../src/lib/notify.mjs";

const mk = () => {
  const calls = [];
  const h = {};
  for (const n of ["toggle", "newSession", "quit", "hideWindow"]) h[n] = () => calls.push(n);
  h.setKernelMode = (m) => calls.push(`kernel:${m}`);
  return { h, calls };
};

test("tray menu: toggle label follows visibility; kernel radios reflect the mode and call back", () => {
  const { h, calls } = mk();
  const shown = flatten(buildTrayTemplate({ windowVisible: true, kernelMode: "shadow", shortcut: "Alt+Space", handlers: h }));
  assert.ok(shown.some((i) => i.path === "Hide Daebot"));
  const hidden = flatten(buildTrayTemplate({ windowVisible: false, kernelMode: "enforced", shortcut: null, handlers: h }));
  assert.ok(hidden.some((i) => i.path === "Show Daebot"));
  const radios = shown.filter((i) => i.path.startsWith("Kernel mode > "));
  assert.deepEqual(radios.map((r) => [r.item.label, r.item.checked]), [["Enforced", false], ["Shadow (log only)", true], ["Off", false]]);
  radios[2].item.click();
  shown.find((i) => i.path === "New Session").item.click();
  shown.find((i) => i.path === "Quit Daebot").item.click();
  assert.deepEqual(calls, ["kernel:off", "newSession", "quit"]);
});

test("app menu carries Cmd+N, Cmd+W, Cmd+Q exactly once each", () => {
  const { h, calls } = mk();
  const items = flatten(buildAppMenuTemplate({ handlers: h, isMac: true }));
  const acc = (a) => items.filter((i) => i.accelerator === a);
  assert.equal(acc("CmdOrCtrl+N").length, 1);
  assert.equal(acc("CmdOrCtrl+W").length, 1);
  assert.equal(acc("CmdOrCtrl+Q").length, 1);
  acc("CmdOrCtrl+N")[0].item.click(); acc("CmdOrCtrl+W")[0].item.click(); acc("CmdOrCtrl+Q")[0].item.click();
  assert.deepEqual(calls, ["newSession", "hideWindow", "quit"]);
  assert.ok(!flatten(buildAppMenuTemplate({ handlers: h, isMac: false })).some((i) => i.path.startsWith("Daebot >")));
});

test("shouldNotify: only confirm events, and only when the window is not visible+focused", () => {
  const confirm = { type: "confirm", id: "k1", tool: "send_email", args: {}, reason: "Outward action" };
  assert.equal(shouldNotify(confirm, { visible: true, focused: false }), true);
  assert.equal(shouldNotify(confirm, { visible: false, focused: false }), true);
  assert.equal(shouldNotify(confirm, { visible: true, focused: true }), false);
  assert.equal(shouldNotify(confirm, null), true);
  assert.equal(shouldNotify({ type: "text", delta: "x" }, { visible: false, focused: false }), false);
  assert.equal(shouldNotify(null, null), false);
});

test("confirm notification text is single-line, bounded, and never includes tool args", () => {
  const n = buildConfirmNotification({ type: "confirm", id: "k", tool: "send_email", args: { to: "jane@example.com", body: "SECRET-BODY" }, reason: "Outward action:\nemails a real third party.\u0007" });
  assert.equal(n.title, "Daebot needs your go: send_email");
  assert.ok(!/\n|\u0007/.test(n.body));
  assert.ok(!JSON.stringify(n).includes("jane@example.com") && !JSON.stringify(n).includes("SECRET-BODY"));
  const long = buildConfirmNotification({ type: "confirm", tool: "t".repeat(500), reason: "r".repeat(1000) });
  assert.ok(long.title.length <= 80 && long.body.length <= 200);
});

test("preload notify payload validation", () => {
  assert.deepEqual(validateNotifyPayload({ title: " Hi\n", body: "there" }), { title: "Hi", body: "there" });
  for (const bad of [null, [], "x", {}, { title: "a" }, { title: "", body: "b" }, { title: 1, body: "b" }, { title: "a".repeat(121), body: "" }, { title: "a", body: "b".repeat(501) }]) assert.equal(validateNotifyPayload(bad), null);
});

test("rate limiter allows N per window then blocks, then recovers", () => {
  let t = 0;
  const ok = createRateLimiter(2, 1000, () => t);
  assert.deepEqual([ok(), ok(), ok()], [true, true, false]);
  t = 1500;
  assert.equal(ok(), true);
});

test("a permission card also notifies when the window is hidden, with the plain title and no arguments", () => {
  const card = { type: "permission", id: "p1", tool: "bash", title: "Run a command on this computer", args: { command: "SECRET-CMD" }, detail: [] };
  assert.equal(shouldNotify(card, { visible: false, focused: false }), true);
  assert.equal(shouldNotify(card, { visible: true, focused: true }), false);
  const n = buildConfirmNotification(card);
  assert.equal(n.title, "Daebot is asking permission: bash");
  assert.equal(n.body, "Run a command on this computer");
  assert.ok(!JSON.stringify(n).includes("SECRET-CMD"));
  assert.equal(shouldNotify({ type: "permissionResolved", id: "p1" }, null), false);
});
