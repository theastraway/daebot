// n8n and "Custom MCP server" cards sign in with OAuth first (the standard MCP authorization flow, like Claude and Cursor), the access token second.
// The mock below answers like a real n8n instance: no resource_metadata in the 401 challenge, protected-resource metadata under the MCP path,
// authorization-server metadata at the origin, dynamic registration, PKCE-checked code exchange, refresh tokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, createFakeMind } from "./fake-mind-mcp.ts";
import { McpStore } from "../../src/mcpconnect/store.ts";
import { LOCAL_CONNECTORS, McpConnectService, n8nAddress, presetAddress } from "../../src/mcpconnect/service.ts";
import { createMcpConnectTool } from "../../src/mcpconnect/tool.ts";
import type { SafeFetch } from "../../src/mcpconnect/ssrf.ts";

const REDIRECT = "https://daebot.live/mcp/oauth/callback";
const PUB = "https://n8n.example.test";
const CTX = { cwd: "/", sessionId: "s" };
const TOOLS = [
  { name: "search_workflows", description: "find workflows", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "execute_workflow", description: "run a workflow", inputSchema: { type: "object" } },
];

interface Seen { path: string; method: string; body: string; ct?: string }
async function n8nMock(o: { oauth?: boolean; registration?: boolean; token?: string } = {}) {
  const oauth = o.oauth !== false, registration = o.registration !== false;
  const seen: Seen[] = [];
  const tokens = new Set<string>(); const refresh = new Map<string, string>(); const codes = new Map<string, { challenge: string; used: boolean; client: string }>();
  let minted = 0;
  const json = (res: any, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const srv = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      seen.push({ path: u.pathname, method: req.method ?? "", body, ct: req.headers["content-type"] as string | undefined });
      if (u.pathname === "/.well-known/oauth-protected-resource/mcp-server/http" && oauth) return json(res, 200, { resource: `${PUB}/mcp-server/http`, bearer_methods_supported: ["header"], authorization_servers: [PUB], scopes_supported: ["tool:listWorkflows", "tool:getWorkflowDetails"] });
      if (u.pathname === "/.well-known/oauth-authorization-server" && oauth) return json(res, 200, {
        issuer: PUB, authorization_endpoint: `${PUB}/mcp-oauth/authorize`, token_endpoint: `${PUB}/mcp-oauth/token`, ...(registration ? { registration_endpoint: `${PUB}/mcp-oauth/register` } : {}),
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      });
      if (u.pathname === "/mcp-oauth/register") return json(res, 201, { client_id: `client-${seen.length}`, ...JSON.parse(body) });
      if (u.pathname === "/mcp-oauth/token") {
        const f = Object.fromEntries(new URLSearchParams(body));
        const mint = () => { const t = `at-${++minted}-SECRETTOKEN`; tokens.add(t); return t; };
        if (f.grant_type === "authorization_code") {
          const c = codes.get(f.code);
          if (!c || c.used || c.client !== f.client_id || createHash("sha256").update(f.code_verifier ?? "").digest("base64url") !== c.challenge || f.redirect_uri !== REDIRECT) return json(res, 400, { error: "invalid_grant" });
          c.used = true; const rt = `rt-${minted}-SECRETREFRESH`; refresh.set(rt, f.client_id);
          return json(res, 200, { access_token: mint(), refresh_token: rt, token_type: "Bearer", expires_in: 3600 });
        }
        if (f.grant_type === "refresh_token" && refresh.get(f.refresh_token) === f.client_id) return json(res, 200, { access_token: mint(), refresh_token: f.refresh_token, token_type: "Bearer", expires_in: 3600 });
        return json(res, 400, { error: "invalid_request" });
      }
      if (u.pathname !== "/mcp-server/http") return json(res, 404, {});
      const auth = req.headers["authorization"] as string | undefined;
      const good = o.token ? auth === `Bearer ${o.token}` : !!auth && tokens.has(auth.slice(7));
      if (!good) { res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="n8n MCP Server"' }); return void res.end('{"message":"Unauthorized"}'); }
      const m = JSON.parse(body || "{}");
      const reply = (result: unknown) => json(res, 200, { jsonrpc: "2.0", id: m.id, result });
      if (m.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "n8n", version: "1" } });
      if (m.method === "tools/list") return reply({ tools: TOOLS });
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
  return { seen, tokens, codes, net, close: () => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); }) };
}

function svcFor(net: SafeFetch) {
  const dir = mkdtempSync(join(tmpdir(), "n8noa-"));
  const store = new McpStore({ dir, secretKey: "k".repeat(40) });
  return { dir, store, svc: new McpConnectService({ store, net, env: {}, catalog: async () => [] }) };
}

/** The "browser" side: signs in at n8n and returns the code bound to the PKCE challenge in the authorize address. */
function approveAt(m: Awaited<ReturnType<typeof n8nMock>>, authorizeUrl: string, code = "code-1") {
  const au = new URL(authorizeUrl);
  m.codes.set(code, { challenge: au.searchParams.get("code_challenge")!, used: false, client: au.searchParams.get("client_id")! });
  return au;
}

test("n8n card asks for the address only; the access token box is optional behind a link", async () => {
  const m = await n8nMock();
  try {
    const { svc } = svcFor(m.net);
    const it = (await svc.catalogItems("u1")).find((i) => i.id === "local:n8n")!;
    assert.equal(it.form!.oauth, true);
    const [url, token] = it.form!.fields;
    assert.equal(url.name, "url"); assert.notEqual(url.optional, true);
    assert.equal(token.name, "token"); assert.equal(token.optional, true); assert.equal(token.reveal, "Use an access token instead");
    // the help steps use n8n's own labels
    assert.match(it.form!.steps!.join(" "), /Settings > Instance-level MCP and select Enable MCP access/);
    assert.ok(LOCAL_CONNECTORS.find((l) => l.id === "local:custom")!.oauth);
  } finally { await m.close(); }
});

test("discovery succeeds: protected-resource, server metadata, dynamic registration (RFC 7591), authorization code + PKCE S256, then the token exchange connects n8n", async () => {
  const m = await n8nMock();
  try {
    const { svc, dir } = svcFor(m.net);
    // the user pastes the page they are looking at in n8n; Daebot finds the MCP path itself
    const r = await svc.connectWithOAuth("u1", { presetId: "local:n8n", url: "https://n8n.example.test/home/workflows", redirectUri: REDIRECT });
    assert.equal(r.status, "authorize");
    if (r.status !== "authorize") return;
    const paths = m.seen.map((s) => s.path);
    assert.ok(paths.includes("/.well-known/oauth-protected-resource/mcp-server/http"), "RFC 9728 protected-resource metadata, with the MCP path inserted");
    assert.ok(paths.includes("/.well-known/oauth-authorization-server"), "RFC 8414 server metadata");
    // dynamic client registration request shape: named Daebot, public client, our callback
    const reg = m.seen.find((s) => s.path === "/mcp-oauth/register")!;
    assert.equal(reg.method, "POST"); assert.match(reg.ct ?? "", /application\/json/);
    assert.deepEqual(JSON.parse(reg.body), { client_name: "Daebot", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
    // authorize address: n8n's own page, PKCE S256, state, resource, scopes from the metadata
    const au = new URL(r.url);
    assert.equal(au.origin + au.pathname, `${PUB}/mcp-oauth/authorize`);
    assert.equal(au.searchParams.get("response_type"), "code");
    assert.equal(au.searchParams.get("code_challenge_method"), "S256");
    assert.ok((au.searchParams.get("code_challenge") ?? "").length >= 43);
    assert.equal(au.searchParams.get("redirect_uri"), REDIRECT);
    assert.equal(au.searchParams.get("state"), r.state);
    assert.equal(au.searchParams.get("resource"), `${PUB}/mcp-server/http`);
    assert.equal(au.searchParams.get("scope"), "tool:listWorkflows tool:getWorkflowDetails");
    assert.equal(svc.list("u1").length, 0, "nothing is connected until n8n approves");

    approveAt(m, r.url);
    const view = await svc.completeOAuth("u1", r.state, "code-1");
    // token request shape
    const tok = m.seen.filter((s) => s.path === "/mcp-oauth/token")[0];
    const f = Object.fromEntries(new URLSearchParams(tok.body));
    assert.equal(f.grant_type, "authorization_code"); assert.equal(f.code, "code-1"); assert.equal(f.redirect_uri, REDIRECT); assert.ok(f.code_verifier.length >= 43); assert.equal(f.resource, `${PUB}/mcp-server/http`);
    assert.equal(tok.ct, "application/x-www-form-urlencoded");
    assert.equal(view.name, "n8n"); assert.equal(view.auth, "oauth"); assert.equal(view.preset, "local:n8n");
    assert.deepEqual(svc.tools("u1").map((t) => t.spec.name), ["n8n__search_workflows", "n8n__execute_workflow"]);
    const row = (await svc.catalogItems("u1")).find((i) => i.id === "local:n8n")!;
    assert.equal(row.connected, true); assert.equal(row.serverId, view.id);
    const raw = readFileSync(join(dir, "daebot-mcp.json"), "utf8");
    assert.ok(![...m.tokens].some((t) => raw.includes(t)) && !raw.includes("SECRETREFRESH"), "tokens sealed at rest");
    assert.equal(r.state.length > 20, true);
    await assert.rejects(svc.completeOAuth("u1", r.state, "code-1"), /expired/, "state is single use");
  } finally { await m.close(); }
});

test("discovery 404 falls back to the access token with a one-line reason, and the token path still connects", async () => {
  const m = await n8nMock({ oauth: false, token: "n8n-api-token-ABC123" });
  try {
    const { svc } = svcFor(m.net);
    const r = await svc.connectWithOAuth("u1", { presetId: "local:n8n", url: "https://n8n.example.test", redirectUri: REDIRECT });
    assert.equal(r.status, "token_needed");
    if (r.status !== "token_needed") return;
    assert.match(r.message, /did not offer a sign-in Daebot can use/);
    assert.match(r.message, /Use an access token instead/);
    assert.ok(!r.message.includes("\n"), "one line");
    assert.equal(svc.list("u1").length, 0);
    assert.ok(!m.seen.some((s) => s.path === "/mcp-oauth/register"), "no registration was attempted");
    const v = await svc.connectWithToken("u1", { presetId: "local:n8n", url: "https://n8n.example.test", token: "n8n-api-token-ABC123" });
    assert.equal(v.auth, "key"); assert.equal(v.preset, "local:n8n");
  } finally { await m.close(); }
});

test("a server that offers no dynamic registration also falls back to the token", async () => {
  const m = await n8nMock({ registration: false });
  try {
    const { svc } = svcFor(m.net);
    const r = await svc.connectWithOAuth("u1", { presetId: "local:n8n", url: "https://n8n.example.test/mcp-server/http", redirectUri: REDIRECT });
    assert.equal(r.status, "token_needed");
    if (r.status === "token_needed") assert.match(r.message, /register itself/);
  } finally { await m.close(); }
});

test("custom MCP server: OAuth discovery first, then the token; connectors without the oauth flag are refused", async () => {
  const m = await n8nMock();
  try {
    const { svc } = svcFor(m.net);
    const r = await svc.connectWithOAuth("u1", { presetId: "local:custom", url: "https://n8n.example.test/mcp-server/http", name: "My Flows", redirectUri: REDIRECT });
    assert.equal(r.status, "authorize");
    if (r.status !== "authorize") return;
    approveAt(m, r.url);
    const v = await svc.completeOAuth("u1", r.state, "code-1");
    assert.equal(v.name, "my-flows"); assert.equal(v.preset, "local:custom");
    await assert.rejects(svc.connectWithOAuth("u1", { presetId: "local:nope", url: "https://x.test/mcp", redirectUri: REDIRECT }), /not available/);
  } finally { await m.close(); }
});

test("token refresh: when n8n expires the access token, one refresh_token grant keeps the connection going", async () => {
  const m = await n8nMock();
  try {
    const { svc } = svcFor(m.net);
    const r = await svc.connectWithOAuth("u1", { presetId: "local:n8n", url: "https://n8n.example.test", redirectUri: REDIRECT });
    if (r.status !== "authorize") return assert.fail("expected authorize");
    approveAt(m, r.url);
    await svc.completeOAuth("u1", r.state, "code-1");
    const first = [...m.tokens][0];
    m.tokens.delete(first); // n8n expires it
    const out = await svc.tools("u1")[0].run({}, CTX);
    assert.equal(out.ok, true, out.output);
    assert.ok(!m.tokens.has(first) && m.tokens.size === 1, "a fresh token replaced the expired one");
    const rf = m.seen.filter((s) => s.path === "/mcp-oauth/token").map((s) => Object.fromEntries(new URLSearchParams(s.body))).find((f) => f.grant_type === "refresh_token")!;
    assert.ok(rf.refresh_token.startsWith("rt-") && rf.client_id && rf.resource === `${PUB}/mcp-server/http`);
    assert.ok(!out.output.includes("SECRETTOKEN"));
  } finally { await m.close(); }
});

test("per-user isolation: another user cannot finish, see or use someone else's n8n sign-in, and each user's connection carries their own token", async () => {
  const m = await n8nMock();
  try {
    const { svc } = svcFor(m.net);
    const a = await svc.connectWithOAuth("alice", { presetId: "local:n8n", url: "https://n8n.example.test", redirectUri: REDIRECT });
    const b = await svc.connectWithOAuth("bob", { presetId: "local:n8n", url: "https://n8n.example.test", redirectUri: REDIRECT });
    if (a.status !== "authorize" || b.status !== "authorize") return assert.fail("expected authorize");
    assert.notEqual(a.state, b.state);
    approveAt(m, a.url, "code-a"); approveAt(m, b.url, "code-b");
    await assert.rejects(svc.completeOAuth("bob", a.state, "code-a"), /expired/, "bob cannot finish alice's sign-in");
    await svc.completeOAuth("alice", a.state, "code-a");
    assert.equal(svc.list("bob").length, 0, "bob sees nothing of alice's");
    assert.equal((await svc.catalogItems("bob")).find((i) => i.id === "local:n8n")!.connected, false);
    await svc.completeOAuth("bob", b.state, "code-b");
    const ta = await svc.tools("alice")[0].run({}, CTX); const tb = await svc.tools("bob")[0].run({}, CTX);
    assert.equal(ta.ok && tb.ok, true);
    assert.equal(m.tokens.size, 2, "two separate tokens were issued");
    assert.equal(svc.list("alice")[0].id === svc.list("bob")[0].id, false);
  } finally { await m.close(); }
});

test("URL normalisation: bare address, n8n page address and the MCP address all land on /mcp-server/http; unsafe addresses are refused", async () => {
  const n8n = LOCAL_CONNECTORS.find((l) => l.id === "local:n8n")!;
  assert.equal(presetAddress(n8n, "https://n8n.example.test"), "https://n8n.example.test/mcp-server/http");
  assert.equal(presetAddress(n8n, "https://n8n.example.test/"), "https://n8n.example.test/mcp-server/http");
  assert.equal(presetAddress(n8n, "https://n8n.example.test/home/workflows"), "https://n8n.example.test/mcp-server/http");
  assert.equal(presetAddress(n8n, "https://n8n.example.test/mcp-server/http"), "https://n8n.example.test/mcp-server/http");
  assert.equal(n8nAddress("https://n8n.srv996174.hstgr.cloud/home/workflows"), "https://n8n.srv996174.hstgr.cloud/mcp-server/http");
  assert.equal(n8nAddress("https://flows.acme.test/mcp-server/http"), "https://flows.acme.test/mcp-server/http");
  assert.equal(n8nAddress("https://flows.acme.test/home/workflows"), undefined, "an unnamed host with a page address is not guessed at");
  assert.equal(n8nAddress("http://n8n.example.test/home"), undefined);
  assert.equal(n8nAddress("https://mcp.notion.com/mcp"), undefined);
  const m = await n8nMock();
  try {
    const { svc } = svcFor(m.net);
    await assert.rejects(svc.connectWithOAuth("u1", { presetId: "local:n8n", url: "http://n8n.example.test", redirectUri: REDIRECT }), /https/);
    await assert.rejects(svc.connectWithOAuth("u1", { presetId: "local:n8n", url: "https://user:pw@n8n.example.test", redirectUri: REDIRECT }), /user name or password/);
    await assert.rejects(svc.connectWithOAuth("u1", { presetId: "local:n8n", url: "", redirectUri: REDIRECT }), /Paste your/);
  } finally { await m.close(); }
});

test("in chat: pasting an n8n page address makes mcp_connect produce the OAuth consent card (Sign in with n8n), not a token form", async () => {
  const m = await n8nMock();
  try {
    const { svc } = svcFor(m.net);
    const tool = createMcpConnectTool(svc, "u1");
    const out = await tool.run({ action: "propose", url: "https://n8n.example.test/home/workflows" }, CTX);
    assert.equal(out.ok, true, out.output);
    assert.match(out.output, /n8n\.example\.test\/mcp-server\/http/);
    assert.match(out.output, /signs in with OAuth/);
    assert.doesNotMatch(out.output, /needs an API key/);
    const [p] = svc.pending("u1");
    assert.equal(p.oauth, true); assert.equal(p.authRequired, true); assert.equal(p.suggestedName, "n8n");
    const a = await svc.approve("u1", p.id, { mode: "oauth", redirectUri: REDIRECT });
    assert.equal(a.status, "authorize");
    if (a.status !== "authorize") return;
    approveAt(m, a.url);
    const v = await svc.completeOAuth("u1", a.state, "code-1");
    assert.equal(v.preset, "local:n8n", "the chat route lands on the same n8n connection as the card");
    assert.equal((await svc.catalogItems("u1")).find((i) => i.id === "local:n8n")!.connected, true);
  } finally { await m.close(); }
});

test("MIND holds this user's connections but refuses a host on its own hosting: the n8n card falls back to this gateway's own sign-in (and token path)", async () => {
  const m = await n8nMock({ token: "n8n-api-token-ABC123" });
  const mind = createFakeMind({ keys: { "mind_key_alice": "alice" } });
  let refusals = 0;
  const refusing: typeof fetch = async (input, init) => {
    const u = String(input);
    if ((init?.method ?? "GET") === "POST" && /\/mcp\/servers$/.test(u)) { refusals++; return new Response(JSON.stringify({ detail: { message: "That host belongs to MIND and cannot be submitted.", code: "refused" } }), { status: 422, headers: { "content-type": "application/json" } }); }
    return mind.fetch(input as any, init);
  };
  try {
    const store = new McpStore({ dir: mkdtempSync(join(tmpdir(), "n8noa-")), secretKey: "k".repeat(40) });
    const svc = new McpConnectService({ store, net: m.net, env: {}, catalog: async () => [], mind: { baseUrl: BASE, keyFor: () => "mind_key_alice", fetchImpl: refusing } });
    // token path first (n8n with no OAuth would use it): the local store holds it
    const v = await svc.connectWithToken("alice", { presetId: "local:n8n", url: "https://n8n.example.test", token: "n8n-api-token-ABC123" });
    assert.equal(v.auth, "key"); assert.equal(v.preset, "local:n8n");
    assert.equal(store.list("alice").length, 1);
    store.remove("alice", store.list("alice")[0].id);
    // OAuth path
    const m2 = await n8nMock();
    try {
      const svc2 = new McpConnectService({ store, net: m2.net, env: {}, catalog: async () => [], mind: { baseUrl: BASE, keyFor: () => "mind_key_alice", fetchImpl: refusing } });
      const r = await svc2.connectWithOAuth("alice", { presetId: "local:n8n", url: "https://n8n.example.test", redirectUri: REDIRECT });
      assert.equal(r.status, "authorize");
      if (r.status !== "authorize") return;
      assert.ok(r.state, "a local flow, bound to this gateway's callback");
      approveAt(m2, r.url);
      const v2 = await svc2.completeOAuth("alice", r.state, "code-1");
      assert.equal(v2.auth, "oauth"); assert.equal(v2.preset, "local:n8n");
      assert.equal(store.list("alice").length, 1);
      assert.equal(refusals, 2, "MIND was asked both times and refused both times");
    } finally { await m2.close(); }
  } finally { await m.close(); }
});
