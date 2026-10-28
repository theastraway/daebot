// ONE Connectors list, one row per product. The MIND apps (Google, GitHub, Dropbox, Apple Calendar ...) and the MIND App Store's MCP
// servers are all connectors. GitHub is both a MIND app (syncs repositories into MIND) and an App Store server (lets Daebot act on GitHub):
// the gateway marks the server as the same product, and the list shows the app's row with the server inside it. Connected rows come first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startGateway } from "../../src/gateway/index.ts";
import { McpStore } from "../../src/mcpconnect/store.ts";
import { McpConnectService } from "../../src/mcpconnect/service.ts";
import type { CatalogEntry } from "../../src/mcpconnect/service.ts";
import { normalizeProviders } from "../../src/mind/integrations.ts";
// @ts-ignore the browser module is plain JS with no declaration file
import { childEntry, connectableApp, connectorList, connectorRows, initConnectors, mindEntry, orderRows } from "../../web/connectors.js";
import { fakeRuntime, http, tmpStatic } from "../gateway/helpers.ts";

const H = { host: "daebot.live", "x-forwarded-proto": "https", origin: "https://daebot.live" };
const WEB = join(import.meta.dirname, "../../web");

const prov = (provider: string, display_name: string, o: Record<string, unknown> = {}) => ({ provider, display_name, blurb: `Sync ${display_name}.`, auth: "oauth", configured: true, connected: false, status: null, account_label: null, files: true, ...o });
const MIND_LIST = {
  integrations_enabled: true,
  providers: [
    prov("google", "Google", { connected: true, account_label: "anthony@theastraway.com", mail: true, calendar: true, contacts: true }),
    prov("apple", "Apple Calendar", { auth: "credentials", connected: true, account_label: "anthony@theastraway.com", calendar: true, files: false }),
    prov("dropbox", "Dropbox", { connected: true, account_label: "anthony@theastraway.com" }),
    prov("github", "GitHub", { connected: true, account_label: "theastraway" }),
    prov("zoom", "Zoom", { configured: false }), // MIND has not set Zoom up and the user has not connected it: no row
    prov("slack", "Slack"),
  ],
};

const ENTRIES: CatalogEntry[] = [
  { id: "mcp:github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", official: true, description: "GitHub's own MCP server", category: "developer", auth: "oauth_or_key" },
  { id: "mcp:dropbox", name: "Dropbox", url: "https://mcp.dropbox.com/mcp", official: true, category: "productivity", auth: "oauth" },
  { id: "mcp:zoom", name: "Zoom", url: "https://mcp.zoom.us/mcp", official: true, category: "communication", auth: "oauth" },
  { id: "mcp:linear", name: "Linear", url: "https://mcp.linear.app/mcp", official: true, category: "project-management", auth: "oauth" },
];

async function boot(mindStatus = 200) {
  const st = tmpStatic();
  for (const f of ["login.html", "login.js", "login.css", "favicon.svg"]) writeFileSync(join(st.dir, f), "x");
  const token = randomBytes(18).toString("hex");
  const store = new McpStore({ dir: mkdtempSync(join(tmpdir(), "fold-")), secretKey: "k".repeat(40) });
  const mcpConnect = new McpConnectService({ store, env: {}, catalog: async () => ENTRIES });
  const seen: { url: string; key: string }[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    seen.push({ url: String(url), key: init.headers["X-API-Key"] });
    return mindStatus === 200 ? new Response(JSON.stringify(MIND_LIST), { status: 200 }) : new Response("{}", { status: mindStatus });
  }) as unknown as typeof fetch;
  const gw = await startGateway({
    runtime: fakeRuntime(), port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: { token, allowedHosts: ["daebot.live"] }, mcpConnect,
    apps: { baseUrl: "https://mind.test/developer/v1", keyFor: () => "mind_alice_key", fetchImpl },
  });
  const r = await http(gw.url, "POST", "/login", { headers: H, body: { token } });
  const cookie = String(([] as string[]).concat(r.headers["set-cookie"] as string[])[0]).split(";")[0];
  return { gw, C: { ...H, cookie }, seen, close: async () => { await gw.close(); } };
}

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

test("gateway: /mcp/catalog marks the connectors that are the same product as an app the user can see, and only those", async () => {
  const { gw, C, seen, close } = await boot();
  try {
    const j = JSON.parse((await http(gw.url, "GET", "/mcp/catalog", { headers: C })).body);
    const by = Object.fromEntries(j.items.map((i: any) => [i.id, i]));
    assert.equal(by["mcp:github"].foldedInto, "github");
    assert.equal(by["mcp:github"].addon.label, "GitHub actions (issues, pull requests, code)");
    assert.match(by["mcp:github"].addon.why, /^Optional\. Lets Daebot open issues and pull requests/);
    assert.equal(by["mcp:dropbox"].foldedInto, "dropbox");
    assert.equal(by["mcp:dropbox"].addon.label, "Dropbox actions");
    assert.equal(by["mcp:zoom"].foldedInto, undefined, "Zoom is not in the user's list, so the connector keeps its own row");
    assert.equal(by["mcp:linear"].foldedInto, undefined);
    assert.equal(by["local:n8n"].foldedInto, undefined);
    assert.ok(seen.length >= 1 && seen.every((s) => s.url === "https://mind.test/developer/v1/integrations" && s.key === "mind_alice_key"), "the user's own key, MIND's integrations route");
    // MIND down: the list still comes, nothing is folded (same as before this change)
    const down = await boot(503);
    try {
      const d = JSON.parse((await http(down.gw.url, "GET", "/mcp/catalog", { headers: down.C })).body);
      assert.equal(d.items.some((i: any) => i.foldedInto), false);
      assert.equal(d.items.length, j.items.length);
    } finally { await down.close(); }
  } finally { await close(); }
});

test("the one Connectors list: every MIND app with its real state first, then the not-connected MIND apps, then the App Store; GitHub exactly once with the server inside it", async () => {
  const { gw, C, close } = await boot();
  try {
    const items = JSON.parse((await http(gw.url, "GET", "/mcp/catalog", { headers: C })).body).items;
    const providers = normalizeProviders(MIND_LIST).providers.filter(connectableApp);
    const rows = connectorList(providers, items);
    assert.deepEqual(names(rows), ["Google", "Apple Calendar", "Dropbox", "GitHub", "Slack", "n8n", "Custom MCP server", "Zoom", "Linear"], "connected MIND apps, then MIND apps not connected, then the App Store");
    assert.equal(names(rows).filter((n) => n === "GitHub").length, 1, "one row named GitHub");
    assert.equal(names(rows).filter((n) => n === "Dropbox").length, 1, "one row named Dropbox");
    const inside = rows.flatMap((r: any) => names(r.children ?? []));
    assert.deepEqual(inside, ["Dropbox actions", "GitHub actions (issues, pull requests, code)"]);
    const gh = rows.find((r: any) => r.id === "github");
    assert.deepEqual([gh.kind, gh.account, gh.connected, gh.manageable], ["mind", "theastraway", true, false]);
    assert.deepEqual(gh.children.map((k: any) => [k.id, k.kind, k.connected, k.logo]), [["mcp:github", "mcp", false, "github"]]);
    assert.match(gh.children[0].blurb, /^Optional\. Lets Daebot open issues and pull requests/);
    const google = rows.find((r: any) => r.id === "google");
    assert.deepEqual([google.kind, google.account, google.connected, google.logo], ["mind", "anthony@theastraway.com", true, "google"]);
    assert.equal(google.children, undefined, "no server, no inner row");
    assert.equal(rows.find((r: any) => r.id === "slack").connected, false);
    assert.equal(rows.some((r: any) => r.id === "zoom" && r.kind === "mind"), false, "an app MIND has not set up is not listed as an app; its server keeps its own row");
    assert.equal(rows.filter((r: any) => r.kind === "mcp").length, 4);
    // a connected App Store server (n8n) sits with the connected rows, ahead of every not-connected one
    const withN8n = connectorList(providers, items.map((i: any) => (i.id === "local:n8n" ? { ...i, connected: true, serverId: "srv_n8n" } : i)));
    assert.deepEqual(names(withN8n).slice(0, 6), ["Google", "Apple Calendar", "Dropbox", "GitHub", "n8n", "Slack"]);
    // a connected inner server is its own state, and a waiting one says so
    assert.deepEqual([childEntry({ id: "mcp:github", name: "GitHub", connected: true, serverId: "srv_1", addon: { label: "GitHub actions", why: "w" } }).connected, childEntry({ id: "mcp:x", name: "X", pendingId: "p1" }).waiting], [true, true]);
    // nothing marked (the owner login, or MIND down): the list is the App Store as it was
    assert.deepEqual(connectorRows([{ id: "a", name: "A" }, { id: "b", name: "B", foldedInto: "b" }]).map((r: any) => r.id), ["a"]);
    assert.deepEqual(names(orderRows([mindEntry({ provider: "g", name: "G", connected: false })], [{ name: "S", connected: true }])), ["S", "G"]);
  } finally { await close(); }
});

/** Runs the real initConnectors against a fake Apps card and returns the section it registered. */
function section(data: { integrations?: unknown; catalog?: unknown }) {
  let def: any;
  const calls: string[] = [];
  const reply = (v: unknown) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  const apps = {
    addSection: (d: unknown) => { def = d; },
    cached: (path: string) => reply(path === "/apps/integrations" ? data.integrations : data.catalog),
    say: () => {}, refresh: () => { calls.push("refresh"); },
    mind: { handlers: { onConnect: (e: any) => { calls.push(`mind-connect ${e.id}`); }, onDisconnect: (e: any) => { calls.push(`mind-disconnect ${e.id}`); } } },
  };
  const json = async (path: string, o?: { method?: string; body?: string }) => { calls.push(`${o?.method ?? "GET"} ${path} ${o?.body ?? ""}`.trim()); return { pending: { id: "p1" } }; };
  initConnectors({ apps, json, getMcp: () => undefined });
  return { def, calls };
}

test("the Connectors section: one load covers the MIND apps and the App Store, owner login and outages degrade to what can be read, a click goes to the right place", async () => {
  const items = [{ id: "mcp:github", name: "GitHub", foldedInto: "github", addon: { label: "GitHub actions (issues, pull requests, code)", why: "Optional." } }, { id: "mcp:linear", name: "Linear", publisher: "official", auth: "oauth", category: "project-management" }];
  const apps = { signedIn: true, enabled: true, providers: normalizeProviders(MIND_LIST).providers };
  const ok = section({ integrations: apps, catalog: { items } });
  assert.equal(ok.def.id, "connectors");
  assert.equal(ok.def.title, "Connectors");
  assert.ok(ok.def.search, "one search box");
  const loaded = await ok.def.load();
  assert.deepEqual(names(loaded.entries), ["Google", "Apple Calendar", "Dropbox", "GitHub", "Slack", "Linear"]);
  assert.equal(loaded.message, undefined);
  // the search covers every kind of row (the section filters on name, blurb, tags and inner names)
  assert.ok(loaded.entries.some((e: any) => e.kind === "mind") && loaded.entries.some((e: any) => e.kind === "mcp"));
  // the owner access-code login has no MIND apps: the App Store still lists, with the sign-in words as the note
  const unmarked = items.map((i) => ({ ...i, foldedInto: undefined })); // with no MIND apps to fold into, the gateway marks nothing
  const owner = await section({ integrations: { signedIn: false, message: "Sign in with MIND to connect apps." }, catalog: { items: unmarked } }).def.load();
  assert.deepEqual(names(owner.entries), ["GitHub", "Linear"]);
  assert.equal(owner.message, "Sign in with MIND to connect apps.");
  // MIND apps down: the App Store shows and says so; both down: the card's Try again; connectors switched off and no apps: hidden
  const down = await section({ integrations: new Error("MIND could not be reached"), catalog: { items } }).def.load();
  assert.deepEqual(names(down.entries), ["Linear"]);
  assert.match(down.message, /Your MIND apps could not be loaded right now/);
  await assert.rejects(section({ integrations: new Error("a"), catalog: new Error("b") }).def.load(), /b/);
  const noStore = await section({ integrations: apps, catalog: new Error("connecting MCP servers is not enabled on this deployment") }).def.load();
  assert.deepEqual(names(noStore.entries), ["Google", "Apple Calendar", "Dropbox", "GitHub", "Slack"], "the MIND apps stand without the App Store");
  assert.deepEqual(await section({ integrations: { signedIn: false, message: "x" }, catalog: new Error("not enabled") }).def.load(), { entries: [], hidden: true });
  // clicks: a MIND row goes to MIND, a server goes through the gateway's MCP routes, the inner server too; the confirm words differ
  const s = section({ integrations: apps, catalog: { items } });
  const h = s.def.handlers;
  await h.onConnect({ id: "google", kind: "mind", name: "Google" }, {});
  await h.onConnect({ id: "mcp:linear", kind: "mcp", name: "Linear" }, { busy() {}, say() {} });
  await h.child.onConnect({ id: "mcp:github", kind: "mcp", name: "GitHub actions" }, { busy() {}, say() {} });
  await h.onDisconnect({ id: "github", kind: "mind", name: "GitHub" }, {});
  assert.deepEqual(s.calls, ["mind-connect google", 'POST /mcp/catalog/connect {"id":"mcp:linear"}', 'POST /mcp/catalog/connect {"id":"mcp:github"}', "mind-disconnect github"]);
  assert.match(h.confirmText({ kind: "mind", name: "GitHub" }), /^Disconnect GitHub\? Anything already synced to MIND stays\./);
  assert.match(h.confirmText({ kind: "mcp", name: "Linear" }), /^Remove Linear\?/);
});

test("web wiring: ONE section, the MIND-app calls live in apps.js, the inner server's buttons are the App Store's, DOM is textContent only", () => {
  const apps = readFileSync(join(WEB, "apps.js"), "utf8");
  const conn = readFileSync(join(WEB, "connectors.js"), "utf8");
  const css = readFileSync(join(WEB, "brand/brand.css"), "utf8");
  assert.doesNotMatch(apps, /title: "MIND integrations"/, "no separate MIND integrations section");
  assert.match(apps, /const mind = \{/);
  assert.match(apps, /handlers\.child/);
  assert.match(apps, /e\.manageable !== false/);
  assert.match(conn, /Promise\.allSettled\(\[get\("\/apps\/integrations"\), get\("\/mcp\/catalog"\)\]\)/);
  assert.match(conn, /id: "connectors", title: "Connectors", search: "Search connectors"/);
  assert.equal((conn.match(/addSection\(/g) ?? []).length, 1);
  for (const f of [apps, conn]) assert.doesNotMatch(f.replace(/\/\/.*$/gm, ""), /innerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/);
  // brand rules: solid surface and a hairline, the LED motif, no capsule on the inner row
  const block = css.slice(css.indexOf(".app-group + .app-group"));
  assert.match(block, /\.app-row\.is-sub \{[^}]*background: var\(--surface\)/);
  assert.match(block, /\.app-led\.is-on \{[^}]*--led-deep/);
  assert.match(block, /1px solid var\(--line\)/);
  assert.doesNotMatch(block, /border-radius: ?999px/);
});
