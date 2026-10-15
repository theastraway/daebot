import { test } from "node:test";
import assert from "node:assert/strict";
import { IMessageAdapter } from "../../src/channels/imessage.ts";
import { fakeGateway, jsonRes, until } from "./helpers.ts";

const cfg = { apiKey: "KEYID-secret", apiSecret: "SECRETKEY-secret", fromNumber: "+15550009999", webhookSecret: "hook-shared-secret", tiers: { "+15551112222": "admin" as const } };

function setup(over: Partial<typeof cfg> & Record<string, unknown> = {}, gw = fakeGateway()) {
  const registered: any[] = [];
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => { calls.push({ url, init }); return jsonRes({ status: "QUEUED" }); }) as unknown as typeof fetch;
  const a = new IMessageAdapter({ ...cfg, ...over }, { fetch: fetchImpl, registerWebhook: (ch, handler, opts) => { registered.push({ ch, handler, opts }); return () => registered.push("unregistered"); } });
  return { a, gw, registered, calls };
}
const inbound = (over: any = {}) => ({
  method: "POST", headers: { "sb-signing-secret": "hook-shared-secret" },
  rawBody: JSON.stringify({ content: "hi there", is_outbound: false, number: "+15551112222", to_number: "+15550009999", message_handle: "H1", group_id: "", ...over }),
});

test("registers the imessage webhook with auth none (adapter verifies its own secret)", async () => {
  const { a, gw, registered } = setup();
  await a.start(gw);
  assert.equal(registered[0].ch, "imessage");
  assert.deepEqual(registered[0].opts, { auth: "none" });
  await a.stop();
  assert.ok(registered.includes("unregistered"));
});

test("inbound auth: missing/wrong secret -> 401, nothing reaches the agent", async () => {
  const { a, gw, registered } = setup();
  await a.start(gw);
  const h = registered[0].handler;
  assert.equal((await h({ ...inbound(), headers: {} })).status, 401);
  assert.equal((await h({ ...inbound(), headers: { "sb-signing-secret": "nope" } })).status, 401);
  assert.equal((await h({ ...inbound(), method: "GET" })).status, 405);
  assert.equal(gw.opened.length, 0);
  await a.stop();
});

test("valid inbound -> 200 fast, reply POSTed to Sendblue with the documented shape", async () => {
  const { a, gw, registered, calls } = setup();
  await a.start(gw);
  const res = await registered[0].handler(inbound());
  assert.equal(res.status, 200);
  await until(() => calls.length === 1, 2000, "outbound send");
  const c = calls[0]!;
  assert.equal(c.url, "https://api.sendblue.co/api/send-message");
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers["sb-api-key-id"], cfg.apiKey);
  assert.equal(c.init.headers["sb-api-secret-key"], cfg.apiSecret);
  assert.deepEqual(JSON.parse(c.init.body), { number: "+15551112222", from_number: "+15550009999", content: "echo: hi there" });
  assert.equal(gw.opened[0]!.surface, "imessage");
  assert.equal(gw.opened[0]!.opts, undefined, "admin number");
  await a.stop();
});

test("outbound echoes, group messages, empty and duplicate deliveries are ignored; strangers are public", async () => {
  const { a, gw, registered, calls } = setup();
  await a.start(gw);
  const h = registered[0].handler;
  await h(inbound({ is_outbound: true, message_handle: "O1" }));
  await h(inbound({ group_id: "g-1", message_handle: "G1" }));
  await h(inbound({ content: "  ", message_handle: "E1" }));
  await h(inbound({ number: "+15553334444", message_handle: "S1" }));
  const dup = await h(inbound({ number: "+15553334444", message_handle: "S1" }));
  assert.equal(dup.body.duplicate, true);
  await until(() => calls.length === 1, 2000);
  await a.stop();
  assert.equal(gw.opened.length, 1);
  assert.deepEqual(gw.opened[0]!.opts, { identity: "public" });
});

test("long replies are chunked to 1000 chars and markdown is stripped", async () => {
  const gw = fakeGateway(() => [{ type: "text", delta: "**Heading**\n" + "sentence here. ".repeat(200) }, { type: "done", finalText: "" }]);
  const { a, registered, calls } = setup({}, gw);
  await a.start(gw);
  await registered[0].handler(inbound());
  await until(() => calls.length >= 3, 2000, "chunks");
  await a.stop();
  const bodies = calls.map((c) => JSON.parse(c.init.body).content as string);
  assert.ok(bodies.every((b) => b.length <= 1000));
  assert.ok(bodies[0]!.startsWith("Heading"));
  assert.ok(!bodies.join("").includes("**"));
});

test("refuses to start without a webhook secret unless explicitly allowed", async () => {
  const { a, gw } = setup({ webhookSecret: undefined });
  await assert.rejects(a.start(gw), /webhookSecret is required/);
  const dev = setup({ webhookSecret: undefined, allowUnauthenticated: true });
  await dev.a.start(dev.gw);
  assert.equal((await dev.registered[0].handler({ ...inbound(), headers: {} })).status, 200);
  await dev.a.stop();
});

test("custom secret header name and gateway-shaped requests (Buffer body, array header)", async () => {
  const { a, gw, registered, calls } = setup({ secretHeader: "X-Custom-Secret" });
  await a.start(gw);
  const req = { method: "POST", headers: { "x-custom-secret": ["hook-shared-secret"] }, body: Buffer.from(inbound().rawBody), query: {}, text: undefined };
  assert.equal((await registered[0].handler(req)).status, 200);
  await until(() => calls.length === 1);
  await a.stop();
});
