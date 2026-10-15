// MCP client (Streamable HTTP) against a local fake MCP server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpHttpClient, classFor, createMcpLoader, loadServerTools, parseMcpServers } from "../../src/mcp/client.ts";
import { createRuntime } from "../../src/runtime.ts";
import { hostedToolAllowed } from "../../src/hosted.ts";
import { FakeProvider, baseCfg, call, collect } from "./helpers.ts";

interface Fake { url: string; log: { method: string; auth?: string; session?: string; proto?: string }[]; calls: Record<string, unknown>[]; close(): Promise<void>; expireSessions(): void }

async function fakeMcp(o: { sse?: boolean; token?: string } = {}): Promise<Fake> {
  const log: Fake["log"] = [];
  const calls: Record<string, unknown>[] = [];
  let sessionOk = true;
  const srv: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      log.push({ method: msg.method, auth: req.headers["authorization"] as string, session: req.headers["mcp-session-id"] as string, proto: req.headers["mcp-protocol-version"] as string });
      if (o.token && req.headers["authorization"] !== `Bearer ${o.token}`) { res.writeHead(401).end(); return; }
      if (msg.method !== "initialize" && req.headers["mcp-session-id"] && !sessionOk) { res.writeHead(404).end(); return; }
      const reply = (result: unknown, headers: Record<string, string> = {}) => {
        const payload = { jsonrpc: "2.0", id: msg.id, result };
        if (o.sse) { res.writeHead(200, { "content-type": "text/event-stream", ...headers }); res.end(`: hi\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`); }
        else { res.writeHead(200, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(payload)); }
      };
      if (msg.method === "initialize") { sessionOk = true; return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }, { "mcp-session-id": "sess-1" }); }
      if (msg.method === "notifications/initialized") { res.writeHead(202).end(); return; }
      if (msg.method === "tools/list") {
        if (msg.params?.cursor === "p2") return reply({ tools: [{ name: "danger.zone", description: "dangerous" }] });
        return reply({ tools: [{ name: "lookup", description: "look a thing up", inputSchema: { type: "object", properties: { q: { type: "string" } } } }, { name: "send_it", description: "sends" }], nextCursor: "p2" });
      }
      if (msg.method === "tools/call") {
        calls.push(msg.params);
        if (msg.params.name === "boom") return reply({ isError: true, content: [{ type: "text", text: "it broke" }] });
        return reply({ content: [{ type: "text", text: `result for ${JSON.stringify(msg.params.arguments)}` }, { type: "image", data: "x", mimeType: "image/png" }] });
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
  return { url, log, calls, expireSessions: () => { sessionOk = false; }, close: () => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); }) };
}

test("parseMcpServers: validates names and urls, never echoes headers in problems", () => {
  const r = parseMcpServers(JSON.stringify([
    { name: "Docs", url: "https://x.example/mcp", headers: { Authorization: "Bearer SECRET" }, classes: { search: "read" } },
    { name: "bad name", url: "https://x.example" },
    { name: "plain", url: "http://evil.example/mcp" },
    { name: "local", url: "http://127.0.0.1:9/mcp" },
    { name: "docs", url: "https://dup.example" },
  ]));
  assert.deepEqual(r.servers.map((s) => s.name), ["docs", "local"]);
  assert.equal(r.problems.length, 3);
  assert.ok(!r.problems.join(" ").includes("SECRET"));
  assert.deepEqual(parseMcpServers("nope").servers, []);
  assert.deepEqual(parseMcpServers(undefined), { servers: [], problems: [] });
});

test("classFor: unknown is outward, never read; per-tool and '*' overrides; garbage falls back to outward", () => {
  const cfg = { name: "s", url: "https://x", classes: { search: "read", "*": "write", weird: "root" } };
  assert.equal(classFor({ name: "s", url: "https://x" }, "anything"), "outward");
  assert.equal(classFor(cfg, "search"), "read");
  assert.equal(classFor(cfg, "other"), "write");
  assert.equal(classFor(cfg, "weird"), "outward");
  assert.equal(classFor({ name: "s", url: "https://x", classes: { "*": "read" } }, "toString"), "read");
});

for (const sse of [false, true]) {
  test(`client (${sse ? "SSE" : "JSON"} replies): initialize, paginated tools/list, tools/call, session + auth headers`, async () => {
    const f = await fakeMcp({ sse, token: "tok" });
    try {
      const c = new McpHttpClient({ name: "fake", url: f.url, headers: { authorization: "Bearer tok" } });
      const tools = await c.listTools();
      assert.deepEqual(tools.map((t) => t.name), ["lookup", "send_it", "danger.zone"]);
      const r = await c.callTool("lookup", { q: "a" });
      assert.equal(r.ok, true);
      assert.match(r.output, /result for {"q":"a"}/);
      assert.match(r.output, /\[image content omitted\]/);
      assert.equal((await c.callTool("boom", {})).ok, false);
      assert.deepEqual(f.log.slice(0, 3).map((l) => l.method), ["initialize", "notifications/initialized", "tools/list"]);
      assert.equal(f.log[2].session, "sess-1");
      assert.equal(f.log[2].proto, "2025-03-26");
      assert.ok(f.log.every((l) => l.auth === "Bearer tok"));
    } finally { await f.close(); }
  });
}

test("client re-initializes once when the server drops the session", async () => {
  const f = await fakeMcp();
  try {
    const c = new McpHttpClient({ name: "fake", url: f.url });
    await c.listTools();
    f.expireSessions();
    const r = await c.callTool("lookup", {});
    assert.equal(r.ok, true);
    assert.equal(f.log.filter((l) => l.method === "initialize").length, 2);
  } finally { await f.close(); }
});

test("loadServerTools: <server>__<tool> names, class from config (default outward), run goes through tools/call", async () => {
  const f = await fakeMcp();
  try {
    const tools = await loadServerTools({ name: "acme", url: f.url, classes: { lookup: "read" } });
    assert.deepEqual(tools.map((t) => [t.spec.name, t.class]), [["acme__lookup", "read"], ["acme__send_it", "outward"], ["acme__danger_zone", "outward"]]);
    assert.ok(tools.every((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.spec.name) && hostedToolAllowed(t.spec.name)));
    const out = await tools[0].run({ q: "z" }, { cwd: "/", sessionId: "s" });
    assert.equal(out.ok, true);
    assert.deepEqual(f.calls.at(-1), { name: "lookup", arguments: { q: "z" } });
  } finally { await f.close(); }
});

test("loader: a dead server is skipped (no throw), and does not block the live one", async () => {
  const f = await fakeMcp();
  const logs: string[] = [];
  try {
    const l = createMcpLoader({ servers: [{ name: "dead", url: "http://127.0.0.1:1/mcp" }, { name: "live", url: f.url }], log: (x) => logs.push(x), timeoutMs: 2000 });
    const tools = await l.tools(5000);
    assert.deepEqual(tools.map((t) => t.spec.name).sort(), ["live__danger_zone", "live__lookup", "live__send_it"]);
    assert.ok(logs.some((x) => x.includes('"dead"')));
  } finally { await f.close(); }
});

test("runtime: remote tools are offered in hosted mode and an unconfigured (outward) one asks before running", async () => {
  const f = await fakeMcp();
  const mind = (async () => new Response(JSON.stringify({ context: "BOOT" }), { status: 200 })) as any;
  try {
    const provider = new FakeProvider([{ calls: [call("c1", "acme__send_it", { to: "x" })] }, { text: "need your go" }]);
    const rt = createRuntime(baseCfg(), { provider, fetchImpl: mind, hosted: { dailyUsdCap: 5 }, mcpServers: [{ name: "acme", url: f.url, classes: { lookup: "read" } }] });
    const s = await rt.openSession({ surface: "web" });
    const ev = await collect(s.send("send it to x"));
    const names = provider.requests[0].tools.map((t) => t.name);
    assert.ok(names.includes("acme__lookup") && names.includes("acme__send_it"), names.join(","));
    assert.ok(!names.includes("bash"));
    assert.ok(ev.some((e) => e.type === "confirm" && (e as any).tool === "acme__send_it"), "danger gate asks first");
    assert.equal(f.calls.length, 0, "the remote tool did not run");
  } finally { await f.close(); }
});
