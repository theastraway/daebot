// n8n and "Custom MCP server" cards: the user's own address + token, probed with the token (initialize + tools/list) before anything
// is saved, sealed like any key connector, tools namespaced n8n__<tool>, and the gateway route behind the card's form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStore } from "../../src/mcpconnect/store.ts";
import { LOCAL_CONNECTORS, McpConnectError, McpConnectService } from "../../src/mcpconnect/service.ts";
import type { SafeFetch } from "../../src/mcpconnect/ssrf.ts";
// @ts-ignore plain JS module
import { entryOf } from "../../web/connectors.js";

const TOKEN = "n8n-test-token-ABC123456";
const REAL_TOOLS = [
  { name: "search_workflows", description: "find workflows", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "execute_workflow", description: "run a workflow", inputSchema: { type: "object" } },
];

async function n8nMock() {
  const seen: { path: string; auth?: string; method?: string }[] = [];
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const m = JSON.parse(b || "{}");
      seen.push({ path: req.url ?? "", auth: req.headers["authorization"] as string | undefined, method: m.method });
      if (req.url !== "/mcp-server/http") { res.writeHead(404).end(); return; }
      if (req.headers["authorization"] !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
      const reply = (result: unknown) => { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })); };
      if (m.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "n8n", version: "1" } });
      if (m.method === "tools/list") return reply({ tools: REAL_TOOLS });
      if (m.method === "tools/call") return reply({ content: [{ type: "text", text: `ran ${m.params.name}` }] });
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const net: SafeFetch = async (input, init = {}) => {
    const u = new URL(String(input));
    return fetch(base + u.pathname + u.search, { method: init.method, headers: init.headers as Record<string, string>, body: init.body, redirect: "manual" });
  };
  return { seen, net, close: () => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); }) };
}

function svcFor(net: SafeFetch, dir = mkdtempSync(join(tmpdir(), "mcptok-"))) {
  const store = new McpStore({ dir, secretKey: "k".repeat(40) });
  return { dir, store, svc: new McpConnectService({ store, net, env: {}, catalog: async () => [] }) };
}

test("n8n card: listed with a URL + token form, connected with the token, tools become n8n__<tool>, token sealed at rest", async () => {
  const m = await n8nMock();
  try {
    const { svc, dir, store } = svcFor(m.net);
    const before = (await svc.catalogItems("u1")).find((i) => i.id === "local:n8n")!;
    assert.equal(before.name, "n8n");
    assert.equal(before.auth, "url_token");
    assert.deepEqual(before.form!.fields.map((f) => f.name), ["url", "token"]);
    assert.equal(before.form!.fields[1].secret, true);
    assert.match(before.form!.fields[0].placeholder, /^https:\/\/n8n\.srv996174\.hstgr\.cloud\/mcp-server\/http$/);
    assert.equal(before.connected, false);

    const view = await svc.connectWithToken("u1", { presetId: "local:n8n", url: "https://n8n.example.test/mcp-server/http", token: `Bearer ${TOKEN}` });
    assert.equal(view.name, "n8n");
    assert.equal(view.auth, "key");
    assert.deepEqual(view.tools.map((t) => t.name), ["search_workflows", "execute_workflow"]);
    assert.ok(m.seen.every((s) => s.auth === `Bearer ${TOKEN}`), "every probe call carried the token");
    assert.ok(!JSON.stringify(view).includes(TOKEN), "the view never carries the token");

    const names = svc.tools("u1").map((t) => t.spec.name);
    assert.deepEqual(names, ["n8n__search_workflows", "n8n__execute_workflow"]);
    const run = await svc.tools("u1")[1].run({}, { cwd: "/", sessionId: "s" });
    assert.match(run.output, /ran execute_workflow/);
    assert.equal(svc.tools("u1")[1].class, "outward", "running a workflow asks first; only the read-only hint is trusted by publisher, and this publisher is unknown");

    const after = (await svc.catalogItems("u1")).find((i) => i.id === "local:n8n")!;
    assert.equal(after.connected, true);
    assert.equal(after.serverId, view.id);
    assert.ok(!readFileSync(join(dir, "daebot-mcp.json"), "utf8").includes(TOKEN), "sealed at rest");
    // reload from disk: the preset survives
    const again = new McpConnectService({ store: new McpStore({ dir, secretKey: "k".repeat(40) }), net: m.net, env: {}, catalog: async () => [] });
    assert.equal((await again.catalogItems("u1")).find((i) => i.id === "local:n8n")!.connected, true);
    assert.equal(store.list("u1")[0].preset, "local:n8n");
  } finally { await m.close(); }
});

test("n8n card: a bare instance address gets /mcp-server/http; a wrong token saves nothing; http, credentials in the URL and bad tokens are refused", async () => {
  const m = await n8nMock();
  try {
    const { svc, store } = svcFor(m.net);
    await assert.rejects(svc.connectWithToken("u1", { presetId: "local:n8n", url: "https://n8n.example.test", token: "wrong-token-123456" }), (e: any) => e instanceof McpConnectError && /did not accept/.test(e.message));
    assert.equal(store.list("u1").length, 0, "a rejected token leaves nothing behind");
    await assert.rejects(svc.connectWithToken("u1", { presetId: "local:n8n", url: "http://n8n.example.test/mcp-server/http", token: TOKEN }), /https/);
    await assert.rejects(svc.connectWithToken("u1", { presetId: "local:n8n", url: "https://user:pw@n8n.example.test/mcp-server/http", token: TOKEN }), /user name/);
    await assert.rejects(svc.connectWithToken("u1", { presetId: "local:n8n", url: "https://n8n.example.test/mcp-server/http", token: "has space" }), /no spaces/);
    await assert.rejects(svc.connectWithToken("u1", { presetId: "local:nope", url: "https://x.test/mcp", token: TOKEN }), /not available/);
    const v = await svc.connectWithToken("u1", { presetId: "local:n8n", url: "https://n8n.example.test/", token: TOKEN });
    assert.equal(v.url, "https://n8n.example.test/mcp-server/http");
    await assert.rejects(svc.connectWithToken("u1", { presetId: "local:n8n", url: "https://n8n.example.test/mcp-server/http", token: TOKEN }), /already connected/);
  } finally { await m.close(); }
});

test("custom MCP server card: any address, optional name for the tool prefix; MIND's own n8n row replaces the local card", async () => {
  const m = await n8nMock();
  try {
    const { svc } = svcFor(m.net);
    const custom = (await svc.catalogItems("u1")).find((i) => i.id === "local:custom")!;
    assert.deepEqual(custom.form!.fields.map((f) => f.name), ["url", "token", "name"]);
    const v = await svc.connectWithToken("u1", { presetId: "local:custom", url: "https://other.example.test/mcp-server/http", token: TOKEN, name: "My Flows" });
    assert.equal(v.name, "my-flows");
    assert.equal(svc.tools("u1")[0].spec.name, "my-flows__search_workflows");
    const store = new McpStore({ dir: mkdtempSync(join(tmpdir(), "mcptok-")), secretKey: "k".repeat(40) });
    const withMind = new McpConnectService({ store, net: m.net, env: {}, catalog: async () => [{ id: "mcp:n8n", name: "n8n", url: "https://mcp.n8n.example/mcp", official: true }] });
    const ids = (await withMind.catalogItems("u1")).map((i) => i.id);
    assert.ok(!ids.includes("local:n8n") && ids.includes("mcp:n8n") && ids.includes("local:custom"));
    assert.equal(LOCAL_CONNECTORS.length, 2);
  } finally { await m.close(); }
});

test("web: the form entry carries its fields to the card", () => {
  const e = entryOf({ id: "local:n8n", name: "n8n", blurb: "b", category: "automation", publisher: "community", auth: "url_token", form: { submitLabel: "Connect", fields: [{ name: "url", label: "n8n URL", placeholder: "https://x" }] } });
  assert.equal(e.form.fields[0].name, "url");
  assert.ok(e.tags.some((t: any) => t.text === "Your URL + token"));
  assert.equal(entryOf({ id: "mcp:x", name: "X", publisher: "official", auth: "oauth" }).form, undefined);
});
