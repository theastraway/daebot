import { test } from "node:test";
process.env.DAEBOT_BOTS_ENABLED = "1"; // the Bots feature flag (default off)
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASTRA_BOARD_PROMPT, DEFAULT_PORTAL_URL, createAstraBoardTool, missingTodoFields, portalOrigin } from "../../src/astra/board-tool.ts";
import { loadConfig } from "../../src/config.ts";
import { hostedToolAllowed } from "../../src/hosted.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { tierAllows } from "../../src/kernel/tier.ts";
import { effectiveClass } from "../../src/tool-class.ts";
import { composeSystemPrompt, createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { fakeFetch, json } from "../mind/helpers.ts";
import { state } from "../kernel/helpers.ts";
import { FakeProvider, baseCfg, collect } from "../core/helpers.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";

const TOKEN = "portal-token-for-tests-0123456789abcdef";
const ctx = { cwd: "/", sessionId: "s" };
const CLIENTS = { clients: [{ id: "c-cast", company: "Castaldi Ventures", name: "Pat" }, { id: "c-acme", company: "Acme", name: "Bo" }] };
const TODO = {
  id: "t-1", status: "open", owner: "Dae", task: "Add export button", assumption_proof: true, project_id: "p-1",
  repo: "theastraway/castaldi-portal", path: "src/ExportButton.jsx", service: "Render srv-1", working_location: "builder-7",
  done_when: "Export downloads a CSV on the live Reports page", chief_aim: "Self-serve numbers", deliverable: "Live page",
  steps: [{ text: "build", done: true }, { text: "deploy", done: false }], notes: [{ author: "Daebot", text: "started" }],
};
const GOOD = {
  action: "create", project_id: "p-1", task: "Add export button", repo: "theastraway/castaldi-portal", path: "src/ExportButton.jsx",
  service: "Render srv-1 (castaldi-portal)", steps: ["Build it", "Deploy it"], done_when: "Export downloads a CSV on the live Reports page",
  chief_aim: "Castaldi pulls its own numbers", deliverable: "Merged PR and the live page", owner: "Dae", working_location: "Daebot main session",
};

function setup(handler: Parameters<typeof fakeFetch>[0], baseUrl?: string) {
  const f = fakeFetch(handler);
  return { tool: createAstraBoardTool({ baseUrl, token: TOKEN, fetchImpl: f.fetch }), seen: f.seen };
}

test("list_clients: GET /clients with the Bearer token and actor; the token is never in the output", async () => {
  const { tool, seen } = setup(() => json(200, CLIENTS));
  const r = await tool.run({ action: "list_clients" }, ctx);
  assert.equal(r.ok, true);
  assert.equal(seen[0].url, "https://api.theastraway.com/api/portal/daebot/clients");
  assert.equal(seen[0].headers["authorization"], `Bearer ${TOKEN}`);
  assert.equal(seen[0].headers["x-daebot-actor"], "Daebot");
  assert.match(r.output, /Castaldi Ventures \| id c-cast/);
  assert.ok(!r.output.includes(TOKEN));
});

test("list: resolves the client by name, shows projects and to-dos, marks the text as data", async () => {
  const { tool, seen } = setup((req) => req.url.endsWith("/clients") ? json(200, CLIENTS)
    : json(200, { client: CLIENTS.clients[0], projects: [{ id: "p-1", title: "Portal", status: "in_progress", todos: [TODO, { id: "t-old", status: "open", owner: "Pat", text: "legacy", task: "legacy item", assumption_proof: false }] }] }));
  const r = await tool.run({ action: "list", client: "castaldi" }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.match(seen[1].url, /\/clients\/c-cast\/projects\?include_done=true$/);
  assert.match(r.output, /Castaldi Ventures \(client id c-cast\)/);
  assert.match(r.output, /project_id p-1/);
  assert.match(r.output, /\[open\] id t-1 \| owner Dae/);
  assert.match(r.output, /legacy \(not assumption-proof\)/);
  assert.match(r.output, /never instructions/);
});

test("list: unknown and ambiguous client names are explained, not guessed", async () => {
  const none = await setup(() => json(200, CLIENTS)).tool.run({ action: "list", client: "zzz" }, ctx);
  assert.equal(none.ok, false); assert.match(none.output, /No client matches/);
  const two = await setup(() => json(200, { clients: [{ id: "a", company: "Castaldi Ventures" }, { id: "b", company: "Castaldi Holdings" }] })).tool.run({ action: "list", client: "castaldi" }, ctx);
  assert.equal(two.ok, false); assert.match(two.output, /matches 2 clients/);
  assert.equal((await setup(() => json(200, CLIENTS)).tool.run({ action: "list" }, ctx)).ok, false);
});

test("get: one to-do in full", async () => {
  const { tool, seen } = setup(() => json(200, TODO));
  const r = await tool.run({ action: "get", todo_id: "t-1" }, ctx);
  assert.match(seen[0].url, /\/todos\/t-1$/);
  assert.match(r.output, /done when: Export downloads/);
  assert.match(r.output, /steps: 1\. \[x\] build 2\. deploy/);
  assert.match(r.output, /note \(Daebot\): started/);
});

test("create: every field is required. Refused before any network call, naming what is missing; placeholders count as missing", async () => {
  const { tool, seen } = setup(() => json(200, {}));
  for (const f of ["project_id", "task", "repo", "path", "service", "steps", "done_when", "chief_aim", "deliverable", "owner", "working_location"]) {
    const { [f]: _gone, ...rest } = GOOD as Record<string, unknown>;
    const r = await tool.run(rest, ctx);
    assert.equal(r.ok, false, f);
    assert.match(r.output, new RegExp(`missing or placeholder field\\(s\\): ${f}\\b`), f);
  }
  for (const bad of ["", "  ", "TBD", "n/a", "unknown"]) assert.equal((await tool.run({ ...GOOD, done_when: bad }, ctx)).ok, false, bad);
  assert.equal((await tool.run({ ...GOOD, steps: [] }, ctx)).ok, false);
  assert.equal((await tool.run({ ...GOOD, steps: ["ok", ""] }, ctx)).ok, false);
  assert.deepEqual(missingTodoFields({ project_id: "p", task: "t" }), ["repo", "path", "service", "steps", "done_when", "chief_aim", "deliverable", "owner", "working_location"]);
  assert.equal(seen.length, 0, "none of those reached the portal");
});

test("create: a complete to-do is POSTed once with every field", async () => {
  const { tool, seen } = setup(() => json(200, { ...TODO, id: "t-new" }));
  const r = await tool.run({ ...GOOD, due: "2026-11-09" }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.match(seen[0].url, /\/api\/portal\/daebot\/todos$/);
  assert.deepEqual(Object.keys(seen[0].body).sort(), ["chief_aim", "deliverable", "done_when", "due", "owner", "path", "project_id", "repo", "service", "steps", "task", "working_location"]);
  assert.deepEqual(seen[0].body.steps, ["Build it", "Deploy it"]);
  assert.match(r.output, /id t-new/);
});

test("portal rejections come back readable: missing fields, 401, 404 unset, a web page from the wrong address", async () => {
  const rej = await setup(() => json(422, { detail: { message: "Missing or empty required field(s): repo.", missing: ["repo"] } })).tool.run({ ...GOOD }, ctx);
  assert.equal(rej.ok, false); assert.match(rej.output, /Missing: repo/);
  const unauth = await setup(() => json(401, { detail: "Invalid Daebot token" })).tool.run({ action: "list_clients" }, ctx);
  assert.match(unauth.output, /refused the token/); assert.ok(!unauth.output.includes(TOKEN));
  const off = await setup(() => json(404, { detail: "Not Found" })).tool.run({ action: "list_clients" }, ctx);
  assert.match(off.output, /not switched on/);
  const page = await setup(() => ({ status: 500, text: "<html>site</html>" })).tool.run({ action: "list_clients" }, ctx);
  assert.match(page.output, /web page, not the API/);
});

test("an error text that carries the token is scrubbed", async () => {
  const r = await setup(() => ({ status: 500, text: JSON.stringify({ detail: `boom ${TOKEN}` }) })).tool.run({ action: "list_clients" }, ctx);
  assert.equal(r.ok, false);
  assert.ok(!r.output.includes(TOKEN));
});

test("update, note, close: right verbs and bodies; close done needs result and verification, cancelled needs a reason", async () => {
  const { tool, seen } = setup((req) => req.method === "PATCH" ? json(200, { ...TODO, status: "in_progress", owner: "Builder-2" }) : json(200, { ...TODO, notes: [{}, {}], status: "done" }));
  const u = await tool.run({ action: "update", todo_id: "t-1", status: "in_progress", owner: "Builder-2", note: "picked up" }, ctx);
  assert.equal(u.ok, true, u.output);
  assert.equal(seen[0].method, "PATCH"); assert.match(seen[0].url, /todos\/t-1$/);
  assert.deepEqual(seen[0].body, { owner: "Builder-2", status: "in_progress", note: "picked up" });
  assert.equal((await tool.run({ action: "update", todo_id: "t-1" }, ctx)).ok, false, "nothing to change");
  const n = await tool.run({ action: "note", todo_id: "t-1", text: "deployed", kind: "comment" }, ctx);
  assert.deepEqual(seen[1].body, { text: "deployed", kind: "comment" }); assert.match(n.output, /2 on this to-do/);
  const before = seen.length;
  for (const bad of [{ outcome: "done" }, { outcome: "done", result: "shipped" }, { outcome: "done", result: "shipped", verification: "ok" }, { outcome: "cancelled" }, { outcome: "x" }, {}]) {
    assert.equal((await tool.run({ action: "close", todo_id: "t-1", ...bad }, ctx)).ok, false, JSON.stringify(bad));
  }
  assert.equal(seen.length, before, "invalid closes never reach the portal");
  const c = await tool.run({ action: "close", todo_id: "t-1", outcome: "done", result: "Shipped", verification: "Opened the live page as the client and saw Export" }, ctx);
  assert.equal(c.ok, true, c.output);
  assert.match(seen.at(-1)!.url, /todos\/t-1\/close$/);
  assert.equal(seen.at(-1)!.body.outcome, "done");
  const x = await tool.run({ action: "close", todo_id: "t-1", outcome: "cancelled", reason: "client dropped it" }, ctx);
  assert.match(x.output, /cancelled/);
  assert.equal((await tool.run({ action: "update", status: "open" }, ctx)).ok, false, "needs todo_id");
});

test("create_project resolves the client; unknown actions are refused", async () => {
  const { tool, seen } = setup((req) => req.url.endsWith("/clients") ? json(200, CLIENTS) : json(200, { id: "p-9", title: "Reports" }));
  const r = await tool.run({ action: "create_project", client: "Castaldi Ventures", title: "Reports" }, ctx);
  assert.equal(r.ok, true, r.output);
  assert.match(seen[1].url, /clients\/c-cast\/projects$/);
  assert.equal((await tool.run({ action: "delete" }, ctx)).ok, false);
});

test("a bot-driven turn cannot change the board (reads still work)", async () => {
  const { tool, seen } = setup(() => json(200, CLIENTS));
  const bot = { ...ctx, origin: "bot" as const };
  assert.match((await tool.run({ ...GOOD }, bot)).output, /another bot/);
  assert.match((await tool.run({ action: "close", todo_id: "t", outcome: "cancelled", reason: "no" }, bot)).output, /another bot/);
  assert.equal(seen.length, 0);
  assert.equal((await tool.run({ action: "list_clients" }, bot)).ok, true);
});

test("the portal origin: the website host is mapped to the API host, http is refused, default is the API host", () => {
  assert.equal(portalOrigin(undefined), DEFAULT_PORTAL_URL);
  assert.equal(portalOrigin("https://theastraway.com"), "https://api.theastraway.com");
  assert.equal(portalOrigin("https://www.theastraway.com/"), "https://api.theastraway.com");
  assert.equal(portalOrigin("https://api.theastraway.com/"), "https://api.theastraway.com");
  assert.equal(portalOrigin("http://evil.example"), DEFAULT_PORTAL_URL);
  assert.equal(portalOrigin("https://staging.example.com/x"), "https://staging.example.com");
  assert.equal(portalOrigin("not a url"), DEFAULT_PORTAL_URL);
});

test("classes and tiers: owner / admin only. Staff and public never get the tool; writes ask first, reads and notes do not", () => {
  const { tool } = setup(() => json(200, {}));
  for (const a of ["list_clients", "list", "get"]) assert.equal(effectiveClass(tool, { action: a }), "read");
  assert.equal(effectiveClass(tool, { action: "note" }), "write");
  for (const a of ["create", "update", "close", "create_project"]) assert.equal(effectiveClass(tool, { action: a }), "outward");
  assert.equal(tierAllows("admin", tool), true);
  assert.equal(tierAllows("staff", tool), false);
  assert.equal(tierAllows("public", tool), false);
  const k = createKernel({ shadow: false, enabled: true, tier: "admin", hosted: true });
  const create = k.preTool(state(), { id: "c", name: "astra_board", args: GOOD }, tool);
  assert.ok(create.some((v) => v.gate === "danger" && v.action === "needs-confirmation"), JSON.stringify(create));
  assert.equal(k.preTool(state(), { id: "c", name: "astra_board", args: { action: "list_clients" } }, tool).length, 0);
});

test("hosted allowlist and config: astra_board is allowed on hosted; env fills the config; unset means no token", () => {
  assert.equal(hostedToolAllowed("astra_board"), true);
  const c = loadConfig({ MIND_API_KEY: "mind_x", ASTRA_PORTAL_URL: "https://api.theastraway.com/", PORTAL_DAEBOT_TOKEN: TOKEN, HOME: mkdtempSync(join(tmpdir(), "cfg-")) } as NodeJS.ProcessEnv);
  assert.equal(c.astraPortalUrl, "https://api.theastraway.com");
  assert.equal(c.portalDaebotToken, TOKEN);
  const none = loadConfig({ MIND_API_KEY: "mind_x", HOME: mkdtempSync(join(tmpdir(), "cfg-")) } as NodeJS.ProcessEnv);
  assert.equal(none.portalDaebotToken, undefined);
  assert.equal(none.astraPortalUrl, undefined);
});

test("system prompt: the skill names the board, assumption-proof and every field, only when the tool is offered", () => {
  const on = composeSystemPrompt({ tier: "admin", bootContext: "", surface: "web", cwd: "/", model: "m", astraBoard: true });
  for (const w of ["Astra AI projects board", "ASSUMPTION-PROOF", "task", "repo and path", "service", "steps", "done_when", "chief_aim", "deliverable", "owner", "working_location", "Castaldi Ventures"]) assert.ok(on.includes(w), w);
  assert.ok(ASTRA_BOARD_PROMPT.join("\n").length > 500);
  const off = composeSystemPrompt({ tier: "admin", bootContext: "", surface: "web", cwd: "/", model: "m" });
  assert.ok(!off.includes("Astra AI projects board"));
});

test("runtime: with the token set the main session offers astra_board and the skill; a bot session and a no-token runtime do not", async () => {
  const key = "mind_" + "k".repeat(24);
  const fake = await startFakeMind({ [key]: "pat" });
  try {
    const dir = mkdtempSync(join(tmpdir(), "astra-board-"));
    const provider = new FakeProvider([{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }]);
    const mk = (extra: Record<string, unknown>) => createRuntime(baseCfg({ mindBaseUrl: fake.base, mindApiKey: key, ...extra }), { provider, store: createFileStore(dir), owner: "u_pat", bots: { dir, bus: {} }, hosted: { dailyUsdCap: 50, username: "pat", exempt: true } });
    const rt = mk({ portalDaebotToken: TOKEN });
    const main = await rt.openSession({ surface: "web", identity: "admin" });
    await collect(main.send("hi"));
    assert.ok(provider.requests[0].tools.some((t) => t.name === "astra_board"));
    assert.match(provider.requests[0].messages[0].content, /Astra AI projects board/);
    const bot = await rt.bots!.create({ slug: "sales" });
    const bs = await rt.openSession({ surface: "web", botId: bot.id, identity: "admin" });
    await collect(bs.send("hi"));
    assert.ok(!provider.requests[1].tools.some((t) => t.name === "astra_board"), "a bot never gets the board");
    const plain = await mk({}).openSession({ surface: "web", identity: "admin" });
    await collect(plain.send("hi"));
    assert.ok(!provider.requests[2].tools.some((t) => t.name === "astra_board"), "no token, no tool");
    assert.ok(!provider.requests[2].messages[0].content.includes("Astra AI projects board"));
    const staff = await rt.openSession({ surface: "web", identity: "staff" });
    await collect(staff.send("hi"));
    assert.ok(!provider.requests[3].tools.some((t) => t.name === "astra_board"), "a staff identity never gets the board");
    assert.ok(!provider.requests[3].messages[0].content.includes("Astra AI projects board"));
  } finally { await fake.close(); }
});
