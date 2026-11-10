import { test } from "node:test";
import assert from "node:assert/strict";
import { eventKeys, mergeHistory, mergeRecords, recordSig } from "../../src/sync/merge.ts";
import { fromWire, toWire } from "../../src/sync/wire.ts";
import { rec } from "./helpers.ts";

test("history is a union by message id, in order, with no duplicates", () => {
  const a = rec("s", { updatedAt: 10, texts: [["u1", "hi"], ["a1", "hello"]] });
  const b = rec("s", { updatedAt: 20, texts: [["u1", "hi"], ["a1", "hello"], ["u2", "more"], ["a2", "ok"]] });
  const m = mergeRecords(a, b);
  assert.deepEqual(m.history.map((e: any) => e.id), ["u1", "a1", "u2", "a2"]);
  assert.equal(m.updatedAt, 20);
  assert.equal(m.state.messages.length, 4, "the more complete side supplies the model context");
  assert.equal(recordSig(mergeRecords(m, b)), recordSig(m), "merging again changes nothing");
});

test("both sides added different messages: nothing is lost and both orders are kept", () => {
  const base: [string, string][] = [["u1", "hi"], ["a1", "hello"]];
  const a = rec("s", { updatedAt: 30, texts: [...base, ["u2", "from mac"]] });
  const b = rec("s", { updatedAt: 40, texts: [...base, ["u3", "from phone"]] });
  const m = mergeRecords(a, b);
  const ids = m.history.map((e: any) => e.id);
  assert.deepEqual(ids.slice(0, 2), ["u1", "a1"]);
  assert.deepEqual(new Set(ids), new Set(["u1", "a1", "u2", "u3"]));
  assert.equal(ids.length, 4);
  // converges: either direction ends with the same set and the same record signature once exchanged again
  const m2 = mergeRecords(b, a);
  assert.deepEqual(new Set(m2.history.map((e: any) => e.id)), new Set(ids));
});

test("same message id with different text: the newer writer wins that message (last-writer-wins per id)", () => {
  const a = rec("s", { updatedAt: 10, texts: [["a1", "old text"]] });
  const b = rec("s", { updatedAt: 99, texts: [["a1", "new text"]] });
  assert.equal((mergeRecords(a, b).history[0] as any).delta, "new text");
  assert.equal((mergeRecords(b, a).history[0] as any).delta, "new text");
});

test("record-level fields are last-writer-wins; bot and model never vanish", () => {
  const a = rec("s", { updatedAt: 10, title: "old", bot: "b_1", model: "m1" });
  const b = rec("s", { updatedAt: 20, title: "renamed", titleSet: true });
  const m = mergeRecords(a, b);
  assert.equal(m.title, "renamed");
  assert.equal(m.bot, "b_1");
  assert.equal(m.model, "m1");
  assert.equal(m.owner, "owner", "the local owner is kept");
});

test("identical id-less events stay distinct (occurrence counter)", () => {
  const n = { type: "notice", level: "info", text: "x" } as any;
  assert.equal(new Set(eventKeys([n, n])).size, 2);
  assert.equal(mergeHistory([n, n], [n]).length, 2);
});

test("wire: bots travel by slug and map to each side's own id; owner never travels", () => {
  const desk = { get: (id: string) => (id === "b_desk" ? { id, slug: "scout" } : undefined), bySlug: (s: string) => (s === "scout" ? { id: "b_desk", slug: s } : undefined) } as any;
  const host = { get: () => undefined, bySlug: (s: string) => (s === "scout" ? { id: "b_host", slug: s } : undefined) } as any;
  const r = rec("s", { bot: "b_desk", peer: "main", run: { id: "r", status: "running", startedAt: 1, updatedAt: 1 } });
  const w = toWire(r, desk)!;
  assert.equal(w.botSlug, "scout");
  assert.equal(w.peerSlug, "main");
  assert.ok(!("owner" in w) && !("bot" in w) && !("run" in w) && !("tier" in w));
  const back = fromWire(w, host, "u_abc", "staff");
  assert.ok(back.ok && back.rec.bot === "b_host" && back.rec.owner === "u_abc" && back.rec.tier === "staff" && back.rec.peer === "main");
  const unknown = fromWire({ ...w, botSlug: "ghost" }, host, "u_abc", "staff");
  assert.ok(!unknown.ok && unknown.reason === "nobot");
  assert.equal(toWire(rec("x", { bot: "b_unknown" }), desk), undefined, "an unmappable bot is held back, not sent wrong");
  assert.equal(toWire(rec("x", { surface: "routine" }), desk)?.surface, "routine", "routine run threads sync like any session");
  assert.ok(!fromWire({ junk: true }, host, "u", "staff").ok);
});
