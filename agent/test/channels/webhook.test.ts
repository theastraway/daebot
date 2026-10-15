import { test } from "node:test";
import assert from "node:assert/strict";
import { WebhookAdapter } from "../../src/channels/webhook.ts";
import { fakeGateway, jsonRes, until } from "./helpers.ts";

function setup(over: Record<string, unknown> = {}) {
  const gw = fakeGateway();
  const registered: any[] = [];
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => { calls.push({ url, init }); return jsonRes({ ok: true }); }) as unknown as typeof fetch;
  const a = new WebhookAdapter({ secret: "s3cret-value", ...over }, { fetch: fetchImpl, registerWebhook: (ch, handler, opts) => { registered.push({ ch, handler, opts }); } });
  return { a, gw, registered, calls };
}
const req = (body: any, headers: Record<string, string> = { "x-mindclaw-secret": "s3cret-value" }) => ({ method: "POST", headers, rawBody: JSON.stringify(body) });

test("shared secret required; bad JSON shape -> 400", async () => {
  const { a, gw, registered } = setup();
  await a.start(gw);
  assert.equal(registered[0].ch, "webhook");
  assert.deepEqual(registered[0].opts, { auth: "none" });
  const h = registered[0].handler;
  assert.equal((await h(req({ conversationId: "c", sender: "u", text: "t" }, {}))).status, 401);
  assert.equal((await h(req({ conversationId: "c", sender: "u", text: "t" }, { "x-mindclaw-secret": "wrong" }))).status, 401);
  assert.equal((await h(req({ sender: "u" }))).status, 400);
  assert.equal((await h({ method: "POST", headers: { "x-mindclaw-secret": "s3cret-value" }, rawBody: "not json" })).status, 400);
  assert.equal(gw.opened.length, 0);
  await a.stop();
});

test("synchronous reply in the HTTP response; conversation reused; default tier is public", async () => {
  const { a, gw, registered } = setup();
  await a.start(gw);
  const h = registered[0].handler;
  const r1 = await h(req({ conversationId: "c1", sender: "alice", text: "ping" }));
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body, { conversationId: "c1", text: "echo: ping", parts: ["echo: ping"] });
  await h(req({ conversationId: "c1", sender: "alice", text: "pong" }));
  assert.equal(gw.opened.length, 1);
  assert.equal(gw.opened[0]!.surface, "webhook");
  assert.deepEqual(gw.opened[0]!.opts, { identity: "public" });
  assert.deepEqual(gw.sessions[0]!.sent, ["ping", "pong"]);
  await a.stop();
});

test("callbackUrl: 202 now, reply POSTed later; non-https or off-list hosts rejected", async () => {
  const { a, gw, registered, calls } = setup({ allowedCallbackHosts: ["hooks.example.com"], tiers: { alice: "admin" } });
  await a.start(gw);
  const h = registered[0].handler;
  const res = await h(req({ conversationId: "c", sender: "alice", text: "later", callbackUrl: "https://hooks.example.com/cb" }));
  assert.equal(res.status, 202);
  await until(() => calls.length === 1, 2000, "callback");
  assert.equal(calls[0]!.url, "https://hooks.example.com/cb");
  assert.equal(JSON.parse(calls[0]!.init.body).text, "echo: later");
  assert.equal((await h(req({ conversationId: "c", sender: "a", text: "x", callbackUrl: "http://hooks.example.com/cb" }))).status, 400);
  assert.equal((await h(req({ conversationId: "c", sender: "a", text: "x", callbackUrl: "https://evil.example.org/cb" }))).status, 400);
  await a.stop();
});
