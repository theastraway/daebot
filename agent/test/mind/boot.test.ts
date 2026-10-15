import { test } from "node:test";
import assert from "node:assert/strict";
import { bootMind } from "../../src/mind/index.ts";
import type { MindClient } from "../../src/types.ts";

function client(o: { context?: () => Promise<string>; profile?: () => Promise<string>; query?: () => Promise<string> }) {
  const log: string[] = [];
  const c: MindClient = {
    context: async (sections) => { log.push("context:" + (sections ?? []).join(",")); return o.context ? o.context() : "CTX"; },
    query: async (q) => { log.push("query:" + q); return o.query ? o.query() : "PRIO"; },
    remember: async () => "",
    call: async (tool, args) => { log.push(`call:${tool}:${args.action}`); return o.profile ? o.profile() : "PROFILE"; },
  };
  return { c, log };
}

test("happy path: context with the five boot sections", async () => {
  const { c, log } = client({});
  const r = await bootMind(c);
  assert.deepEqual(r, { ok: true, context: "CTX" });
  assert.deepEqual(log, ["context:soul,user,rules,priorities,recent"]);
});

test("one context failure is retried and recovers", async () => {
  let n = 0;
  const { c, log } = client({ context: async () => { if (++n === 1) throw new Error("502"); return "CTX2"; } });
  const r = await bootMind(c);
  assert.equal(r.ok, true);
  assert.equal(r.context, "CTX2");
  assert.equal(log.filter((l) => l.startsWith("context")).length, 2);
});

test("two context failures fall back to profile + priorities query: ok:true with a note", async () => {
  const { c, log } = client({ context: async () => { throw new Error("synthesis 502"); } });
  const r = await bootMind(c);
  assert.equal(r.ok, true);
  assert.match(r.context, /PROFILE/);
  assert.match(r.context, /PRIORITIES\nPRIO/);
  assert.match(r.context, /boot degraded/);
  assert.match(r.error ?? "", /synthesis 502/);
  assert.ok(log.includes("call:profile:get"));
  assert.ok(log.includes("query:current priorities"));
});

test("fallback needs both profile and query to work", async () => {
  const { c } = client({ context: async () => { throw new Error("x"); }, query: async () => { throw new Error("q down"); } });
  const r = await bootMind(c);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /q down/);
});

test("everything unreachable: ok:false with all three causes", async () => {
  const dead = async () => { throw new Error("ECONNREFUSED"); };
  const { c } = client({ context: dead, profile: dead, query: dead });
  const r = await bootMind(c);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /unreachable/);
  assert.match(r.error ?? "", /ECONNREFUSED/);
});

test("degraded flag: set only on the fallback path", async () => {
  const ok = await bootMind(client({}).c);
  assert.equal(ok.degraded, undefined);
  const { c } = client({ context: async () => { throw new Error("synthesis 502"); } });
  const r = await bootMind(c);
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
  const dead = async () => { throw new Error("down"); };
  const bad = await bootMind(client({ context: dead, profile: dead, query: dead }).c);
  assert.equal(bad.ok, false);
  assert.equal(bad.degraded, undefined);
});
