import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createBotsFake } from "../../src/gateway/dev-fake-bots.ts";

const web = (f: string) => readFileSync(join(import.meta.dirname, "..", "..", "web", f), "utf8");
const code = (f: string) => web(f).replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const bots: any = await import(new URL("../../web/bots.js", import.meta.url).href);
const models: any = await import(new URL("../../web/models.js", import.meta.url).href);

// ---------------------------------------------------------------- pure helpers: bots.js

test("safeColor and initialOf: only #rrggbb reaches the page; the badge letter is the first letter or digit", () => {
  assert.equal(bots.safeColor("#7DFF9A"), "#7dff9a");
  assert.equal(bots.safeColor("red"), bots.DEFAULT_COLOR);
  assert.equal(bots.safeColor("url(javascript:alert(1))"), bots.DEFAULT_COLOR);
  assert.equal(bots.safeColor(undefined), bots.DEFAULT_COLOR);
  assert.equal(bots.initialOf("quinn"), "Q");
  assert.equal(bots.initialOf("  ledger"), "L");
  assert.equal(bots.initialOf("42 bot"), "4");
  assert.equal(bots.initialOf("***"), "B");
  assert.equal(bots.initialOf(undefined), "B");
  assert.equal(bots.COLORS.length, 6);
  for (const c of bots.COLORS) assert.equal(bots.safeColor(c.hex), c.hex);
});

test("byteLength counts UTF-8 bytes against the 8 KB limit; countLabel formats it", () => {
  assert.equal(bots.byteLength("abc"), 3);
  assert.equal(bots.byteLength("é"), 2);
  assert.equal(bots.byteLength("😀"), 4);
  assert.equal(bots.byteLength(undefined), 0);
  assert.equal(bots.MAX_INSTRUCTION_BYTES, 8192);
  assert.equal(bots.countLabel(1204), "1,204 / 8,192 bytes");
});

test("starterTemplate uses the name and purpose and is far below the limit", () => {
  const t = bots.starterTemplate("Quinn", "triage claims");
  assert.match(t, /You are Quinn\. Your job: triage claims/);
  assert.match(t, /^# Role/);
  assert.ok(bots.byteLength(t) < 1024);
  assert.match(bots.starterTemplate("", ""), /You are this bot/);
});

test("botErrorMessage: bot_limit names the plan limit and links the upgrade page; other failures are plain words", () => {
  const m = bots.botErrorMessage(402, { error: "bot_limit", limit: 3, tier: "Free", upgrade_url: "https://example.com/upgrade" });
  assert.equal(m.text, "Your plan includes 3 bots. Upgrade to add more.");
  assert.equal(m.href, "https://example.com/upgrade");
  assert.equal(m.linkText, "Upgrade");
  assert.ok(m.text.includes(m.linkText));
  assert.equal(bots.botErrorMessage(402, { error: "bot_limit", limit: 1 }).text, "Your plan includes 1 bot. Upgrade your plan to add more.");
  // a javascript: URL from the server never becomes a link
  assert.equal(bots.botErrorMessage(402, { error: "bot_limit", limit: 2, upgrade_url: "javascript:alert(1)" }).href, undefined);
  assert.match(bots.botErrorMessage(409, {}).text, /already have a bot with that name/);
  assert.match(bots.botErrorMessage(400, { error: "name_required" }).text, /Give your bot a name/);
  assert.match(bots.botErrorMessage(413, {}).text, /over 8 KB/);
  assert.match(bots.botErrorMessage(404, {}).text, /not available/);
  assert.match(bots.botErrorMessage(500, null).text, /Something went wrong/);
});

test("generalSessions hides bot threads; peerLabel resolves an id, a slug or a name; dotState ranks busy over live", () => {
  const list = [{ id: "a" }, { id: "b", bot: "b1" }, { id: "c", bot: "" }];
  assert.deepEqual(bots.generalSessions(list).map((s: any) => s.id), ["a", "c"]);
  assert.deepEqual(bots.generalSessions(undefined), []);
  const all = [{ id: "b1", slug: "quinn", name: "Quinn" }, { id: "b2", slug: "ledger", name: "Ledger" }];
  assert.equal(bots.peerLabel("b2", all), "from Ledger");
  assert.equal(bots.peerLabel("quinn", all), "from Quinn");
  assert.equal(bots.peerLabel("Someone", all), "from Someone");
  assert.equal(bots.peerLabel("", all), "");
  assert.equal(bots.dotState({ live: true, busy: true }), "busy");
  assert.equal(bots.dotState({ live: true }), "live");
  assert.equal(bots.dotState({}), "idle");
  assert.equal(bots.dotState(undefined), "idle");
});

// ---------------------------------------------------------------- pure helpers: models.js

test("prettyModel: a server name wins; ids are tidied; :free is marked", () => {
  assert.equal(models.prettyModel("x/y", "My Model"), "My Model");
  assert.equal(models.prettyModel("qwen/qwen3.8-flash:free"), "Qwen 3.8 Flash (free)");
  assert.equal(models.prettyModel("steady-1"), "Steady 1");
  assert.equal(models.prettyModel(""), "");
  assert.equal(models.prettyModel(undefined), "");
});

test("normalizeModels: drops bad rows, defaults allowed to true, lists locked models last", () => {
  const n = models.normalizeModels({
    models: [
      { id: "a", name: "A", allowed: false },
      null,
      { name: "no id" },
      { id: "b", free: true, price_hint: "$0 per 1M" },
      { id: "c", name: "C", allowed: true },
    ],
    default: "b",
  });
  assert.deepEqual(n.rows.map((r: any) => r.id), ["b", "c", "a"]);
  assert.equal(n.rows[0].free, true);
  assert.equal(n.rows[0].priceHint, "$0 per 1M");
  assert.equal(n.rows[2].allowed, false);
  assert.equal(n.def, "b");
  assert.deepEqual(models.normalizeModels(undefined), { rows: [], def: "" });
  assert.equal(models.LOCKED_NOTE, "Plus and up");
});

test("badgeModel: a pending choice, then the model that answered, then the default, then the gateway's", () => {
  assert.equal(models.badgeModel({ served: "s", chosen: "c", def: "d", health: "h" }), "c");
  assert.equal(models.badgeModel({ served: "s", def: "d", health: "h" }), "s");
  assert.equal(models.badgeModel({ def: "d", health: "h" }), "d");
  assert.equal(models.badgeModel({ health: "h" }), "h");
  assert.equal(models.badgeModel({}), "");
  assert.match(models.badgeTitle({ label: "B", served: "a", chosen: "b", servedLabel: "A" }), /from the next message \(last answer: A\)/);
  assert.equal(models.badgeTitle({ label: "B" }), "B. Click to change.");
  assert.equal(models.badgeTitle({ label: "" }), "Choose a model");
});

// ---------------------------------------------------------------- wiring

test("web wiring: every id bots.js and models.js look up exists in index.html", () => {
  const html = web("index.html");
  for (const f of ["bots.js", "models.js"]) {
    const ids = new Set([...code(f).matchAll(/\$\("([a-z0-9-]+)"\)/g)].map((m) => m[1]));
    assert.ok(ids.size >= 3, `${f} should look up elements`);
    for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `${f} needs #${id}`);
  }
  for (const id of ["tab-sessions", "tab-bots", "side-label", "bot-list", "btn-instr", "instr-drawer", "instr-text", "instr-count", "instr-save", "instr-revert",
    "bd-name", "bd-purpose", "bd-colors", "bd-delete", "bd-delete-yes", "bot-new", "bn-name", "bn-purpose", "bn-instr", "bn-create", "model-badge", "model-menu", "model-wrap", "top-badge", "i-lock", "i-sliders", "i-chev-down"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  // the segmented control is two real buttons with aria-pressed
  assert.match(html, /id="tab-sessions"[^>]*aria-pressed="true"/);
  assert.match(html, /id="tab-bots"[^>]*aria-pressed="false"/);
  // the model badge is a button now, still carrying the ids brand.js fills
  assert.match(html, /<button[^>]*class="model-badge"[^>]*id="model-badge"/);
  assert.match(html, /id="mb-name"/);
});

test("web wiring: app.js loads the modules and routes through them", () => {
  const app = web("app.js");
  assert.match(app, /from "\/bots\.js"/);
  assert.match(app, /from "\/models\.js"/);
  assert.match(app, /generalSessions\(state\.sessions\)/, "the Sessions list hides bot threads");
  assert.match(app, /bots\.view\(\) === "bots"/, "refreshSessions and the New button are view-aware");
  assert.match(app, /body\.bot = state\.curBot/, "a thread started from a bot is created with its bot");
  assert.match(app, /models\.answered\(/, "the badge follows the model that actually served the answer");
});

test("CSP safety: no innerHTML, eval, confirm(), inline script or style in the page or the new modules", () => {
  for (const f of ["bots.js", "models.js"]) {
    const c = code(f);
    assert.doesNotMatch(c, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|window\.confirm|\bconfirm\(|setAttribute\(\s*["']style["']|\.cssText/, f);
    assert.doesNotMatch(c, /fetch\(\s*["'`]https?:/, `${f} stays same-origin`);
    assert.doesNotMatch(c, /import\s+[^;]*from\s+["']https?:/, f);
    assert.doesNotMatch(c, /^\s*import\(/m, f);
  }
  const app = code("app.js");
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|window\.confirm/, "app.js");
  const html = web("index.html");
  assert.doesNotMatch(html, /\sstyle\s*=/i, "no inline style attributes");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline event handlers");
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i, "no inline scripts");
  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html, /(src|href)="https?:\/\/(?!claude)/i, "no CDN or third-party assets");
});

test("mascot: the accent attribute only tints the lit LEDs; the head image is untouched", () => {
  const m = web("brand/mbot.js");
  assert.match(m, /observedAttributes\(\) \{ return \["mood", "accent"\]/);
  assert.match(m, /\^#\[0-9a-f\]\{6\}\$/i, "accent must be #rrggbb");
  assert.match(m, /v === 2 \? LED_RED : v === 3 \? LED_HOT : accent/, "alert red and the white twinkle keep their colours");
  assert.match(m, /HEAD_SRC = "\/brand\/daebot-head\.webp"/);
});

// ---------------------------------------------------------------- the dev fake documents the contract

test("dev fake: the REST contract the UI is built against (shapes, 402 bot_limit, 409, 413, locked model)", async () => {
  const fake = createBotsFake({ token: "t0k", backendPort: 1, botLimit: 3, upgradeUrl: "https://example.com/up" });
  const srv = createServer(async (req, res) => { if (!(await fake.handle(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const res = await fetch(base + path, { method, headers: { ...(auth ? { authorization: "Bearer t0k" } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };
  try {
    assert.equal((await call("GET", "/bots", undefined, false)).status, 401);
    const list = await call("GET", "/bots");
    assert.equal(list.status, 200);
    assert.equal(list.body.bots.length, 3);
    for (const k of ["id", "slug", "name", "purpose", "color", "updatedAt", "live", "busy"]) assert.ok(k in list.body.bots[0], k);
    const full = await call("POST", "/bots", { name: "Fourth", purpose: "x" });
    assert.equal(full.status, 402);
    assert.deepEqual({ ...full.body }, { error: "bot_limit", limit: 3, tier: "Free", upgrade_url: "https://example.com/up" });
    const id = list.body.bots[0].id;
    assert.equal((await call("DELETE", `/bots/${list.body.bots[2].id}`)).status, 200);
    assert.equal((await call("POST", "/bots", { name: "quinn" })).status, 409);
    const made = await call("POST", "/bots", { name: "Fresh", purpose: "p", instructions: "# hi" });
    assert.equal(made.status, 201);
    assert.equal((await call("GET", `/bots/${made.body.id}/instructions`)).body.text, "# hi");
    assert.equal((await call("PUT", `/bots/${id}/instructions`, { text: "x".repeat(8193) })).status, 413);
    const put = await call("PUT", `/bots/${id}/instructions`, { text: "ok" });
    assert.equal(put.body.text, "ok");
    assert.ok(put.body.updatedAt > 0);
    const patched = await call("PATCH", `/bots/${id}`, { color: "#5ee0ff", purpose: "new" });
    assert.equal(patched.body.color, "#5ee0ff");
    const ms = await call("GET", "/models");
    assert.ok(ms.body.models.some((m: any) => m.allowed === false));
    assert.equal(typeof ms.body.default, "string");
    const locked = ms.body.models.find((m: any) => !m.allowed);
    assert.equal((await call("PATCH", "/sessions/s1", { model: locked.id })).status, 403);
    assert.equal((await call("PATCH", "/sessions/s1", { model: ms.body.default })).status, 200);
  } finally { srv.close(); srv.closeAllConnections(); }
});
