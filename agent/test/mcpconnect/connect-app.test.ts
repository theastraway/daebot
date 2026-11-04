// Daebot helps people connect: MIND apps (Google, Dropbox, ...) are in the catalog the model reads, mcp_connect action connect_app puts an
// Authorize card in the chat (connects nothing itself), the prompt says to show the right card in the same turn, and the web card reuses the Apps connect path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStore } from "../../src/mcpconnect/store.ts";
import { McpConnectService } from "../../src/mcpconnect/service.ts";
import { parseCatalog } from "../../src/mcpconnect/catalog.ts";
import { createMcpConnectTool } from "../../src/mcpconnect/tool.ts";
import { composeSystemPrompt } from "../../src/runtime.ts";
// @ts-ignore the browser module is plain JS with no declaration file
import { buildAppCard } from "../../web/appcard.js";

const CTX = { cwd: "/", sessionId: "s" };
// The shape of MIND's live GET /developer/v1/connectors (Render is kind remote_mcp, Google and Dropbox are kind mind_integration).
const LIVE = { connectors: [
  { id: "mcp:render", name: "Render", description: "Manage Render services", category: "developer", tier: "official", kind: "remote_mcp", connect: { type: "mcp", auth: "oauth", mcp_url: "https://mcp.render.com/mcp" }, status: { state: "unknown", connected: null } },
  { id: "google", name: "Google", description: "Sync Google Calendar, Gmail activity, and Google Contacts.", category: "productivity", tier: "official", source: "mind_integration", kind: "mind_integration", connect: { type: "mind_oauth", auth: "oauth", connect_path: "/integrations/google/connect", mcp_url: null }, status: { state: "unknown", connected: null } },
  { id: "dropbox", name: "Dropbox", description: "Sync Dropbox files.", category: "productivity", tier: "official", kind: "mind_integration", connect: { type: "mind_oauth", auth: "oauth", mcp_url: null }, status: { state: "unknown", connected: null } },
  { id: "soon", name: "Soon", kind: "mind_integration", connect: { auth: "oauth" }, status: { state: "coming_soon" } },
  { id: "Bad Id!", name: "Bad", kind: "mind_integration", connect: {} },
] };

function setup(apps?: Parameters<typeof createMcpConnectTool>[2]) {
  const store = new McpStore({ dir: mkdtempSync(join(tmpdir(), "mcpapp-")), secretKey: "k".repeat(40) });
  const svc = new McpConnectService({ store, env: {}, catalog: async () => parseCatalog(LIVE) });
  const tool = createMcpConnectTool(svc, "u1", apps);
  return { svc, tool };
}
const APPS = async () => [
  { provider: "google", name: "Google", configured: true, connected: false, needsReconnect: false },
  { provider: "dropbox", name: "Dropbox", configured: true, connected: true, needsReconnect: false },
];

test("parseCatalog keeps MIND app rows (provider id, no MCP url), flags unavailable ones, drops badly named ones, and keeps the MCP rows", () => {
  const rows = parseCatalog(LIVE);
  const g = rows.find((r) => r.id === "google")!;
  assert.equal(g.app, true);
  assert.equal(g.url, "");
  assert.equal(g.name, "Google");
  assert.equal(g.official, true);
  assert.ok(rows.find((r) => r.id === "dropbox")?.app);
  assert.equal(rows.find((r) => r.url === "https://mcp.render.com/mcp")?.app, undefined);
  assert.equal(rows.find((r) => r.id === "soon")?.unavailable, true);
  assert.equal(rows.find((r) => r.name === "Bad"), undefined);
});

test("the Apps card's connector list never shows a MIND app row as an MCP connector, and a card cannot be proposed from one", async () => {
  const { svc } = setup();
  const items = await svc.catalogItems("u1");
  assert.ok(items.some((i) => i.name === "Render"));
  assert.ok(!items.some((i) => i.id === "google" || i.id === "dropbox"));
  await assert.rejects(() => svc.proposeFromCatalog("u1", "google"), /not in the MIND App Store list/);
});

test("catalog action lists MIND apps (marked, with provider id and connected state) before the MCP servers", async () => {
  const { tool } = setup(APPS);
  const all = (await tool.run({ action: "catalog" }, CTX)).output.split("\n");
  assert.match(all[0], /^MIND app: Google \(provider google, not connected\)/);
  assert.ok(all.some((l) => /^MIND app: Dropbox \(provider dropbox, connected\)/.test(l)));
  assert.ok(all.some((l) => l.includes("https://mcp.render.com/mcp")));
  const q = (await tool.run({ action: "catalog", query: "dropbox" }, CTX)).output;
  assert.match(q, /connect_app/);
  const noApps = (await setup().tool.run({ action: "catalog", query: "google" }, CTX)).output;
  assert.match(noApps, /connected state unknown/);
});

test("connect_app puts an Authorize card in the chat and connects nothing: no pending MCP request, no server, no network call", async () => {
  const { svc, tool } = setup(APPS);
  assert.deepEqual((tool.spec.parameters as any).properties.action.enum, ["propose", "list", "catalog", "connect_app"]);
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("no network in this test"); }) as typeof fetch;
  try {
    const r = await tool.run({ action: "connect_app", provider: "google" }, CTX);
    assert.equal(r.ok, true);
    assert.equal(r.meta?.appCard, "google");
    assert.match(r.output, /NOT CONNECTED YET/);
    assert.match(r.output, /Authorize card for Google/);
    assert.equal(calls, 0, "the tool itself never calls MIND's connect route; only the user's click does");
  } finally { globalThis.fetch = realFetch; }
  assert.equal(svc.list("u1").length, 0);
  assert.equal(svc.pending("u1").length, 0);
});

test("connect_app refuses a bot, a made-up provider, an unavailable app and a malformed id; an already connected app needs no click", async () => {
  const { tool } = setup(APPS);
  assert.match((await tool.run({ action: "connect_app", provider: "google" }, { ...CTX, origin: "bot" })).output, /another bot cannot/);
  assert.equal((await tool.run({ action: "connect_app", provider: "nope" }, CTX)).ok, false);
  assert.match((await tool.run({ action: "connect_app", provider: "soon" }, CTX)).output, /cannot be connected right now/);
  assert.equal((await tool.run({ action: "connect_app", provider: "../x" }, CTX)).ok, false);
  assert.equal((await tool.run({ action: "connect_app" }, CTX)).ok, false);
  const already = await tool.run({ action: "connect_app", provider: "dropbox" }, CTX);
  assert.equal(already.ok, true);
  assert.match(already.output, /already connected/);
  assert.ok(!/NOT CONNECTED YET/.test(already.output));
});

test("the prompt tells Daebot to put the right card in the chat in the same turn", () => {
  const p = composeSystemPrompt({ bootContext: "", surface: "web", cwd: "/x", now: new Date("2026-01-02T12:00:00Z"), mcp: true });
  assert.match(p, /IN THE SAME TURN/);
  assert.match(p, /connect_app/);
  assert.match(p, /Authorize card/);
  assert.match(p, /masked key field/);
  assert.match(p, /do not send them to the Apps window when a card can be shown/);
  assert.match(p, /never ask for a key, password or token in chat/);
});

// ---- the web card (no browser here: a tiny element stand-in with the same calls the card makes)
class El {
  tag: string; className: string; textContent = ""; children: El[] = []; hidden = false; disabled = false; type = ""; attrs: Record<string, string> = {};
  listeners: Record<string, (() => unknown)[]> = {};
  classList = { add: (c: string) => { this.className += ` ${c}`; }, toggle: (c: string, on: boolean) => { if (on) this.className += ` ${c}`; } };
  constructor(tag: string, cls = "", text = "") { this.tag = tag; this.className = cls; this.textContent = text; }
  append(...n: El[]) { this.children.push(...n); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(ev: string, fn: () => unknown) { (this.listeners[ev] ??= []).push(fn); }
  async click() { if (this.disabled) return; for (const fn of this.listeners.click ?? []) await fn(); }
}
const h = (tag: string, cls = "", text = "") => new El(tag, cls, text);
const find = (e: El, text: string): El | undefined => (e.textContent === text ? e : e.children.map((c) => find(c, text)).find(Boolean));
const flush = () => new Promise((r) => setImmediate(r));

test("web: the Authorize card shows the app's name from the user's own list, clicking calls the Apps connect handler once, and it flips to Connected when the apps refresh", async () => {
  let connected = false; const connects: string[] = [];
  const timers: (() => void)[] = [];
  const apps = {
    cached: async () => ({ providers: [{ provider: "dropbox", name: "Dropbox", blurb: "Sync Dropbox files.", auth: "oauth", configured: true, connected }] }),
    mind: { handlers: { onConnect: async (e: any) => { connects.push(`${e.id}:${e.name}:${e.auth}`); } } },
  };
  const card = buildAppCard({ provider: "dropbox", h, apps, timers: { set: (fn: () => void) => { timers.push(fn); return timers.length; }, clear: () => {} } }) as El;
  assert.equal(connects.length, 0, "building the card connects nothing");
  await flush();
  assert.equal(find(card, "Connect Dropbox?")?.tag, "h3");
  const btn = find(card, "Authorize")!;
  assert.ok(btn && !btn.disabled);
  await btn.click();
  assert.deepEqual(connects, ["dropbox:Dropbox:oauth"]);
  assert.ok(find(card, "Approve Dropbox in the new tab, then come back here."));
  assert.equal(timers.length, 1, "it watches for the connection");
  connected = true; timers[0](); await flush();
  assert.ok(find(card, "Dropbox is connected"));
  assert.ok(card.className.includes("done"));
});

test("web: an app the user does not have, or a malformed id, gets no button", async () => {
  const apps = { cached: async () => ({ providers: [] }), mind: { handlers: { onConnect: async () => { throw new Error("must not run"); } } } };
  const a = buildAppCard({ provider: "ghost", h, apps }) as El; await flush();
  assert.ok(find(a, "App not available"));
  assert.equal(find(a, "Authorize")?.hidden ?? true, true);
  const b = buildAppCard({ provider: "../x", h, apps }) as El;
  assert.ok(find(b, "App not available"));
});
