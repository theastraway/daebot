// MIND App Store connectors in the Apps card: the list parser, the per-user fetch, the item view, Connect-from-catalog (same pending
// request and consent card as a model's proposal), the SSRF guard on catalog URLs, the publisher rule, and the gateway routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startGateway } from "../../src/gateway/index.ts";
import { McpStore } from "../../src/mcpconnect/store.ts";
import { McpConnectError, McpConnectService } from "../../src/mcpconnect/service.ts";
import type { CatalogEntry } from "../../src/mcpconnect/service.ts";
import { createMindCatalog, parseCatalog } from "../../src/mcpconnect/catalog.ts";
import type { SafeFetch } from "../../src/mcpconnect/ssrf.ts";
// @ts-ignore the browser module is plain JS with no declaration file
import { entryOf } from "../../web/connectors.js";
import { fakeRuntime, http, tmpStatic } from "../gateway/helpers.ts";

const H = { host: "daebot.live", "x-forwarded-proto": "https", origin: "https://daebot.live" };
const WEB = join(import.meta.dirname, "../../web");

// The exact shape https://m-i-n-d.ai/developer/v1/connectors returns today.
const LIVE = {
  enabled: true, authenticated: false, counts: { official: 3, community: 1 },
  items: [
    { id: "google", name: "Google", description: "Sync Google Calendar", category: "productivity", tier: "official", kind: "mind_integration", logo_url: "/connector-logos/google.svg", connect: { type: "mind_oauth", auth: "oauth", connect_path: "/integrations/google/connect", mcp_url: null } },
    { id: "mcp:notion", name: "Notion", description: "Search, read and update Notion pages.", category: "productivity", tier: "official", kind: "remote_mcp", logo_url: null, connect: { type: "mcp_remote", auth: "oauth2.1_or_api_key", mcp_url: "https://mcp.notion.com/mcp" } },
    { id: "mcp:sentry", name: "Sentry", description: "Issues and traces.", category: "observability", tier: "official", kind: "remote_mcp", connect: { auth: "oauth2.1", mcp_url: "https://mcp.sentry.dev/mcp" } },
    { id: "mcp:acme", name: "Acme Docs", description: "Community docs server.", category: "developer", tier: "community", official: true, kind: "remote_mcp", connect: { auth: "none", mcp_url: "https://acme.test/mcp" } },
  ],
};

test("parseCatalog reads the live shape: only remote MCP items, the nested mcp_url, tier decides official, auth maps", () => {
  const rows = parseCatalog(LIVE);
  assert.deepEqual(rows.map((r) => r.id), ["mcp:notion", "mcp:sentry", "mcp:acme"], "the MIND integration (no MCP url) is not an MCP connector");
  const by = Object.fromEntries(rows.map((r) => [r.id!, r]));
  assert.equal(by["mcp:notion"].url, "https://mcp.notion.com/mcp");
  assert.equal(by["mcp:notion"].official, true);
  assert.equal(by["mcp:notion"].auth, "oauth_or_key");
  assert.equal(by["mcp:sentry"].auth, "oauth");
  assert.equal(by["mcp:acme"].auth, "none");
  assert.equal(by["mcp:acme"].official, false, "a community entry's own `official: true` field changes nothing; only MIND's tier does");
  assert.equal(by["mcp:notion"].category, "productivity");
  assert.deepEqual(parseCatalog({ items: [{ id: "x", name: "X", tier: "official", kind: "remote_mcp", connect: { mcp_url: "http://insecure.example/mcp" } }] }), [], "http is dropped");
  assert.deepEqual(parseCatalog("nonsense"), []);
});

test("createMindCatalog: asks MIND with the user's own key, falls back to the public list, retries an empty answer soon", async () => {
  const seen: (string | undefined)[] = [];
  let t = 0, mode: "ok" | "down" | "reject" = "ok";
  const f = (async (_u: string, init: any) => {
    const key = init.headers["X-API-Key"];
    seen.push(key);
    if (mode === "down") return new Response("no", { status: 503 });
    if (mode === "reject" && key) return new Response("no", { status: 401 });
    return new Response(JSON.stringify(LIVE), { status: 200 });
  }) as unknown as typeof fetch;
  const cat = createMindCatalog({ baseUrl: "https://mind.test/developer/v1/", keyFor: (uid) => (uid === "u_alice" ? "mind_alice" : undefined), fetchImpl: f, now: () => t });
  assert.equal((await cat("u_alice")).length, 3);
  assert.deepEqual(seen, ["mind_alice"]);
  await cat("u_alice"); assert.equal(seen.length, 1, "cached");
  assert.equal((await cat("u_bob")).length, 3);
  assert.deepEqual(seen.slice(1), [undefined], "a user without a key still gets the public list");
  mode = "reject";
  assert.equal((await cat("u_carl")).length, 3);
  const carl = createMindCatalog({ baseUrl: "https://mind.test/developer/v1", keyFor: () => "sign-in-token", fetchImpl: f });
  seen.length = 0;
  assert.equal((await carl("u")).length, 3);
  assert.deepEqual(seen, ["sign-in-token", undefined], "401 on the key retries without it");
  mode = "down"; t = 0;
  const flaky = createMindCatalog({ baseUrl: "https://mind.test/developer/v1", keyFor: () => "k", fetchImpl: f, now: () => t });
  assert.deepEqual(await flaky("z"), []);
  mode = "ok"; t = 31_000;
  assert.equal((await flaky("z")).length, 3, "an empty answer is retried after 30 seconds, not cached for 10 minutes");
});

// ---- a tiny MCP server and a SafeFetch that routes every https name to it
async function mock() {
  const log: string[] = [];
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const m = JSON.parse(b || "{}");
      log.push(m.method);
      const reply = (result: unknown) => { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })); };
      if (m.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "m", version: "1" } });
      if (m.method === "tools/list") return reply({ tools: [{ name: "lookup", description: "look", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }, { name: "make", description: "make a thing" }] });
      if (m.method === "tools/call") return reply({ content: [{ type: "text", text: "ok" }] });
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const net: SafeFetch = async (input, init = {}) => fetch(base + new URL(String(input)).pathname, { method: init.method, headers: init.headers as Record<string, string>, body: init.body, redirect: "manual" });
  return { log, net, close: () => new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); }) };
}

const ENTRIES: CatalogEntry[] = parseCatalog(LIVE);
function svcWith(net: SafeFetch | undefined, entries: CatalogEntry[] = ENTRIES) {
  const store = new McpStore({ dir: mkdtempSync(join(tmpdir(), "mcpcat-")), secretKey: "k".repeat(40) });
  return { store, svc: new McpConnectService({ store, net, env: {}, catalog: async () => entries }) };
}

test("catalogItems: one row per MCP connector with this user's own connected and waiting state; unsafe addresses are not listed", async () => {
  const m = await mock();
  try {
    const bad: CatalogEntry[] = [...ENTRIES,
      { id: "mcp:plain", name: "Plain", url: "http://plain.test/mcp", official: false },
      { id: "mcp:keyed", name: "Keyed", url: "https://keyed.test/mcp?key=secret", official: false },
      { id: "has space", name: "Spacey", url: "https://spacey.test/mcp", official: false }];
    const { svc } = svcWith(m.net, bad);
    let items = await svc.catalogItems("u1");
    assert.deepEqual(items.map((i) => i.id), ["mcp:notion", "mcp:sentry", "mcp:acme"]);
    assert.ok(items.every((i) => !i.connected && !i.pendingId));
    assert.equal(items[0].publisher, "official");
    assert.equal(items[2].publisher, "community");
    assert.equal(items[0].host, "mcp.notion.com");
    const p = await svc.proposeFromCatalog("u1", "mcp:acme");
    items = await svc.catalogItems("u1");
    assert.equal(items.find((i) => i.id === "mcp:acme")!.pendingId, p.id);
    assert.equal((await svc.catalogItems("u2")).find((i) => i.id === "mcp:acme")!.pendingId, undefined, "another user's pending request is not shown");
    await svc.approve("u1", p.id, { mode: "none", redirectUri: "https://daebot.live/mcp/oauth/callback" });
    items = await svc.catalogItems("u1");
    const acme = items.find((i) => i.id === "mcp:acme")!;
    assert.equal(acme.connected, true);
    assert.ok(acme.serverId);
    assert.equal(acme.pendingId, undefined);
  } finally { await m.close(); }
});

test("Connect on a connector makes the same pending request as a proposal: probe only, nothing connected, tools listed for the consent card", async () => {
  const m = await mock();
  try {
    const { svc, store } = svcWith(m.net);
    const p = await svc.proposeFromCatalog("u1", "mcp:acme");
    assert.equal(p.url, "https://acme.test/mcp");
    assert.equal(p.source, "catalog");
    assert.equal(p.suggestedName, "acme");
    assert.equal(p.reason, "Community docs server.");
    assert.deepEqual(p.tools?.map((t) => t.name), ["lookup", "make"]);
    assert.deepEqual(p.defaultAllow, ["lookup"], "only read-only tools are pre-ticked");
    assert.equal(store.list("u1").length, 0);
    assert.deepEqual(svc.tools("u1"), []);
    assert.deepEqual([...new Set(m.log)].sort(), ["initialize", "notifications/initialized", "tools/list"]);
    assert.equal((await svc.proposeFromCatalog("u1", "mcp:acme")).id, p.id, "clicking twice returns the same request");
    await assert.rejects(svc.proposeFromCatalog("u1", "mcp:nope"), (e: unknown) => e instanceof McpConnectError && e.status === 404);
    await assert.rejects(svc.proposeFromCatalog("u1", "https://evil.test/mcp"), (e: unknown) => e instanceof McpConnectError, "an address is not an id");
  } finally { await m.close(); }
});

test("publisher on a catalog connect: official only when MIND's tier says official AND the host is the store entry's; a community tier is community; neither is set by the server", async () => {
  const m = await mock();
  try {
    const entries: CatalogEntry[] = [
      { id: "mcp:vendor", name: "Vendor", url: "https://vendor.test/mcp", official: true },
      { id: "mcp:comm", name: "Comm", url: "https://comm.test/mcp", official: false },
    ];
    const { svc } = svcWith(m.net, entries);
    assert.equal((await svc.proposeFromCatalog("u1", "mcp:vendor")).publisher, "official");
    assert.equal((await svc.proposeFromCatalog("u1", "mcp:comm")).publisher, "community");
    // the same official entry, proposed by a model at a different host or path, is NOT official
    assert.equal((await svc.propose("u1", { url: "https://vendor.test/other" })).publisher, "unknown");
    assert.equal((await svc.propose("u1", { url: "https://elsewhere.test/mcp" })).publisher, "unknown");
  } finally { await m.close(); }
});

test("SSRF guard still applies to a catalog URL: an entry pointing at a private or metadata address is refused before any request", async () => {
  const entries: CatalogEntry[] = [
    { id: "mcp:meta", name: "Meta", url: "https://169.254.169.254/mcp", official: true },
    { id: "mcp:lan", name: "Lan", url: "https://10.0.0.5/mcp", official: false },
    { id: "mcp:lo", name: "Lo", url: "https://127.0.0.1/mcp", official: false },
  ];
  const { svc } = svcWith(undefined, entries); // the real guard
  for (const id of ["mcp:meta", "mcp:lan", "mcp:lo"]) {
    await assert.rejects(svc.proposeFromCatalog("u1", id), (e: unknown) => e instanceof McpConnectError && /Refused/.test(e.message), id);
  }
  assert.equal(svc.pending("u1").length, 0);
});

// ---- gateway routes
async function boot(entries: CatalogEntry[] = ENTRIES, env: NodeJS.ProcessEnv = {}) {
  const m = await mock();
  const st = tmpStatic();
  for (const f of ["login.html", "login.js", "login.css", "favicon.svg"]) writeFileSync(join(st.dir, f), "x");
  const token = randomBytes(18).toString("hex");
  const { svc, store } = svcWith(m.net, entries);
  const mcpConnect = new McpConnectService({ store, net: m.net, env, catalog: async () => entries });
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: { token, allowedHosts: ["daebot.live"] }, mcpConnect });
  const r = await http(gw.url, "POST", "/login", { headers: H, body: { token } });
  const cookie = String(([] as string[]).concat(r.headers["set-cookie"] as string[])[0]).split(";")[0];
  void svc;
  return { gw, cookie, m, close: async () => { await gw.close(); await m.close(); } };
}

test("gateway: /mcp/catalog and /mcp/catalog/connect need the session, list the connectors, and Connect creates the pending request", async () => {
  const { gw, cookie, close } = await boot();
  const C = { ...H, cookie };
  try {
    for (const [meth, p] of [["GET", "/mcp/catalog"], ["POST", "/mcp/catalog/connect"]] as const)
      assert.equal((await http(gw.url, meth, p, { headers: H, body: meth === "POST" ? { id: "mcp:acme" } : undefined })).status, 401, `${meth} ${p} without a session`);
    assert.equal((await http(gw.url, "GET", "/mcp/catalog", { headers: { ...C, origin: "https://evil.example" } })).status, 403);
    const list = await http(gw.url, "GET", "/mcp/catalog", { headers: C });
    assert.equal(list.status, 200);
    const j = JSON.parse(list.body);
    assert.deepEqual(j.items.map((i: any) => i.id), ["mcp:notion", "mcp:sentry", "mcp:acme"]);
    assert.deepEqual(j.counts, { official: 2, community: 1 });
    assert.equal(j.items[0].url, undefined, "the list carries no endpoint URL to click through");
    assert.equal((await http(gw.url, "POST", "/mcp/catalog", { headers: C, body: {} })).status, 405);
    assert.equal((await http(gw.url, "GET", "/mcp/catalog/connect", { headers: C })).status, 405);

    // an address in the body is ignored: only an id from the list works
    const evil = await http(gw.url, "POST", "/mcp/catalog/connect", { headers: C, body: { url: "https://evil.test/mcp" } });
    assert.equal(evil.status, 404);
    assert.equal((await http(gw.url, "POST", "/mcp/catalog/connect", { headers: C, body: { id: "https://evil.test/mcp" } })).status, 404);

    const ok = await http(gw.url, "POST", "/mcp/catalog/connect", { headers: C, body: { id: "mcp:acme" } });
    assert.equal(ok.status, 200);
    const p = JSON.parse(ok.body).pending;
    assert.equal(p.url, "https://acme.test/mcp");
    assert.equal(p.publisher, "community");
    assert.equal(p.source, "catalog");
    assert.equal(JSON.parse((await http(gw.url, "GET", "/mcp/servers", { headers: C })).body).servers.length, 0, "nothing is connected by that click");
    assert.equal(JSON.parse((await http(gw.url, "GET", "/mcp/catalog", { headers: C })).body).items[2].pendingId, p.id);

    // the user's click on the card is the consent: the existing approve route connects it, and the list then shows it connected
    const ap = await http(gw.url, "POST", `/mcp/pending/${p.id}/approve`, { headers: C, body: { mode: "none", allow: ["lookup"] } });
    assert.equal(ap.status, 200, ap.body);
    const after = JSON.parse((await http(gw.url, "GET", "/mcp/catalog", { headers: C })).body).items[2];
    assert.equal(after.connected, true);
    const removed = await http(gw.url, "DELETE", `/mcp/servers/${after.serverId}`, { headers: C });
    assert.equal(JSON.parse(removed.body).ok, true);
    assert.equal(JSON.parse((await http(gw.url, "GET", "/mcp/catalog", { headers: C })).body).items[2].connected, false);
  } finally { await close(); }
});

test("gateway: the kill switch turns the catalog routes into 404, like every other /mcp route", async () => {
  const { gw, cookie, close } = await boot(ENTRIES, { DAEBOT_MCP_CONNECT_ENABLED: "false" });
  try {
    assert.equal((await http(gw.url, "GET", "/mcp/catalog", { headers: { ...H, cookie } })).status, 404);
    assert.equal((await http(gw.url, "POST", "/mcp/catalog/connect", { headers: { ...H, cookie }, body: { id: "mcp:acme" } })).status, 404);
  } finally { await close(); }
});

// ---- the browser side (no DOM here: pure mapping + source rules)
test("web: a connector row shows category, Official or Community, and the auth type; connected rows say Remove", () => {
  const e = entryOf({ id: "mcp:notion", name: "Notion", blurb: "Pages", category: "project-management", publisher: "official", auth: "oauth_or_key", connected: true, serverId: "srv_1" });
  assert.deepEqual(e.tags.map((t: any) => t.text), ["project management", "Official", "OAuth or API key"]);
  assert.equal(e.tags[1].tone, "ok");
  assert.equal(e.removeLabel, "Remove");
  assert.equal(e.serverId, "srv_1");
  const c = entryOf({ id: "mcp:acme", name: "Acme", blurb: "", category: "", publisher: "community", auth: "none", connected: false, pendingId: "mcp_x" });
  assert.deepEqual(c.tags.map((t: any) => t.text), ["Community", "No sign-in"]);
  assert.equal(c.tags[0].tone, "warn");
  assert.equal(c.waiting, true);
  assert.equal(c.connected, false);
});

test("web: Connect sends an id and never an address; no innerHTML anywhere in the new code; the consent card hides the Apps card", () => {
  const web = (f: string) => readFileSync(join(WEB, f), "utf8");
  const code = (f: string) => web(f).replace(/^\s*\/\/.*$/gm, "");
  for (const f of ["connectors.js", "apps.js", "mcp.js"]) assert.doesNotMatch(code(f), /innerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/, f);
  assert.match(web("connectors.js"), /JSON\.stringify\(\{ id: e\.id \}\)/);
  assert.doesNotMatch(web("connectors.js"), /\burl\b\s*:/);
  assert.doesNotMatch(web("connectors.js"), /fetch\(/);
  assert.match(web("mcp.js"), /suspendApps\(\)/, "opening the consent card steps the Apps card aside");
  assert.match(web("mcp.js"), /resumeApps\(\)/);
  assert.match(web("apps.js"), /function suspend\(\)[^}]*q\.card\.hidden = true/);
  assert.match(web("app.js"), /initConnectors\(/);
});
