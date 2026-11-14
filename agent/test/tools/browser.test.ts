import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { createBrowserBridge } from "../../src/browser/bridge.ts";
import { parseMark } from "../../src/browser/driver.ts";
import { resetBrowserLive, setBrowserLive } from "../../src/browser/live.ts";
import { BROWSER_PARTITION, classForClickKind, classifyClick, navigationAllowed, stripSecretText, stripSecrets } from "../../src/browser/policy.ts";
import { BROWSER_UNAVAILABLE, PASSWORD_REFUSAL, USER_HAS_CONTROL, createBrowserTool } from "../../src/tools/browser.ts";
import { browserSupport } from "../../src/devices/index.ts";
import { dangerGate, grantIfAffirmed } from "../../src/kernel/danger.ts";
import { tierAllows } from "../../src/kernel/tier.ts";
import { filterHostedTools, hostedToolAllowed } from "../../src/hosted.ts";
import { botSessionTools } from "../../src/runtime.ts";
import { createBuiltinTools } from "../../src/tools/index.ts";
import { PermissionService } from "../../src/permissions/index.ts";
import { allowKindsFor, describeCall, factsOf } from "../../src/permissions/rules.ts";
import type { BrowserHost } from "../../src/browser/host.ts";
import type { TurnState } from "../../src/types.ts";
import { auth, fakeRuntime, http, tmpStatic } from "../gateway/helpers.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00]).toString("base64");

interface FakeOpts {
  connected?: boolean;
  text?: string;
  nodes?: unknown[];
  control?: "agent" | "user";
}

function fake(opts: FakeOpts = {}) {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  let notice: { kind: "refusal" | "approval" | "info"; text: string } | null = null;
  let tabs = [{ id: "t1", url: "http://127.0.0.1:9/shop", title: "Daebot shop", active: true, control: opts.control ?? "agent" as const }];
  const host: BrowserHost = {
    connected: () => opts.connected !== false,
    snapshot: () => ({
      partition: BROWSER_PARTITION,
      gatewayOrigin: "http://127.0.0.1:1",
      pane: { open: true, width: 440 },
      tabs: tabs.map((t) => ({ ...t })),
      notice,
    }),
    notice: (n) => { notice = n; },
    async call(op, args) {
      calls.push({ op, args });
      if (op === "open") {
        const url = String(args.url || "");
        tabs = [{ id: "t1", url, title: "Opened", active: true, control: "agent" }];
        return { tabId: "t1", url, title: "Opened" };
      }
      if (op === "navigate") return { url: typeof args.url === "string" ? args.url : "http://127.0.0.1:9/next", title: "Next" };
      if (op === "close") { tabs = []; return { closed: true }; }
      if (op === "cdp") {
        const method = String(args.method || "");
        const params = (args.params ?? {}) as { expression?: string };
        if (method === "Runtime.evaluate") {
          const mark = parseMark(String(params.expression || ""));
          if (!mark) return { result: { value: null } };
          if (mark.kind === "TEXT") return { result: { value: opts.text ?? "Daebot shop\nsigned in" } };
          if (mark.kind === "READ") return { result: { value: opts.nodes ?? [] } };
          if (mark.kind === "HAS_TEXT") return { result: { value: String(opts.text ?? "").includes(String(mark.arg)) } };
          if (mark.kind === "QUERY") return { result: { value: mark.arg === "#note" } };
        }
        if (method === "Page.captureScreenshot") return { data: JPEG };
        return {};
      }
      return {};
    },
  };
  return { host, calls, notice: () => notice, setControl(c: "agent" | "user") { tabs = tabs.map((t) => ({ ...t, control: c })); } };
}

const shopNodes = [
  { tag: "input", type: "text", role: "textbox", name: "Note", id: "note", x: 10, y: 40, w: 200, h: 24, value: "" },
  { tag: "input", type: "password", role: "textbox", name: "Password", id: "pw", autocomplete: "current-password", x: 10, y: 80, w: 200, h: 24, value: "should-not-leak", secret: true },
  { tag: "input", type: "text", role: "textbox", name: "Card number", id: "card", autocomplete: "cc-number", x: 10, y: 120, w: 200, h: 24, value: "4242424242424242" },
  { tag: "button", type: "submit", role: "button", name: "Place order", text: "Place order", x: 10, y: 170, w: 120, h: 32 },
];

test("navigation refuses file, chrome, devtools, view-source, javascript, data, and the gateway origin", () => {
  assert.equal(BROWSER_PARTITION, "persist:daebot-browser");
  assert.equal(navigationAllowed("about:blank").ok, true);
  for (const url of ["file:///etc/passwd", "chrome://settings", "chrome-extension://abc/page.html", "devtools://devtools/bundled/inspector.html", "view-source:https://example.com", "javascript:alert(1)", "data:text/html,hi"]) {
    assert.equal(navigationAllowed(url).ok, false, url);
  }
  assert.equal(navigationAllowed("ftp://example.com/x").ok, false);
  assert.equal(navigationAllowed("not a url").ok, false);
  assert.equal(navigationAllowed("http://127.0.0.1:9/shop", "http://127.0.0.1:1").ok, true);
  assert.equal(navigationAllowed("http://127.0.0.1:1/secret", "http://127.0.0.1:1").ok, false);
});

test("click classifier: purchase and delete are irreversible, send and submit are outward", () => {
  assert.equal(classifyClick({ name: "Place order", tag: "button", type: "submit" }), "purchase");
  assert.equal(classForClickKind("purchase"), "irreversible");
  assert.equal(classifyClick({ name: "Remove item", tag: "button", type: "button" }), "delete");
  assert.equal(classForClickKind("delete"), "irreversible");
  assert.equal(classifyClick({ name: "Send message", tag: "button", type: "button" }), "send");
  assert.equal(classifyClick({ name: "Publish", tag: "button", type: "submit" }), "send");
  assert.equal(classForClickKind("send"), "outward");
  assert.equal(classifyClick({ name: "Save", tag: "button", type: "submit" }), "submit");
  assert.equal(classifyClick({ name: "Go", tag: "button" }), "submit");
  assert.equal(classForClickKind("submit"), "outward");
  assert.equal(classifyClick({ name: "Details", tag: "a", type: "" }), "plain");
  assert.equal(classForClickKind("plain"), "write");
});

test("stripSecrets drops cookies, storage, auth headers, and password values", () => {
  const cleaned = stripSecrets({
    cookie: "a=b",
    cookies: [{ name: "sid", value: "nope" }],
    "set-cookie": "a=b",
    authorization: "Bearer abcdef",
    localStorage: { token: "nope" },
    sessionStorage: { token: "nope" },
    indexedDB: { db: 1 },
    password: "hunter2",
    secret: true,
    type: "password",
    value: "hunter2",
    href: "https://shop.example/a?token=sekret#x",
    note: "Authorization: Bearer supersecret\nCookie: session=abc\nlocalStorage.getItem('k')\nhello",
  }) as Record<string, unknown>;
  const blob = JSON.stringify(cleaned);
  assert.equal("cookie" in cleaned, false);
  assert.equal("authorization" in cleaned, false);
  assert.equal("localStorage" in cleaned, false);
  assert.equal("value" in cleaned, false);
  assert.doesNotMatch(blob, /hunter2|supersecret|session=abc/);
  assert.match(String(cleaned.href), /^https:\/\/shop\.example\/a$/);
  assert.match(stripSecretText("Authorization: Bearer supersecret"), /\[redacted\]/);
});

test("browser tool actions, refs, refusal, untrusted wrap, and user takeover", async () => {
  resetBrowserLive();
  const f = fake({ text: "Daebot shop\nCookie: session=abc\nAuthorization: Bearer supersecret\nlocalStorage token\nsigned in", nodes: shopNodes });
  const tool = createBrowserTool(f.host);
  const params = tool.spec.parameters as { properties?: { action?: { enum?: string[] } } };
  assert.equal(params.properties?.action?.enum?.includes("evaluate"), false);

  const ctx = { cwd: "/tmp", sessionId: "s" };
  const gone = await createBrowserTool({ ...f.host, connected: () => false }).run({ action: "tabs" }, ctx);
  assert.equal(gone.ok, false);
  assert.match(gone.output, /browser unavailable/);
  assert.match(gone.output, /desktop app/);

  const run = (args: Record<string, unknown>) => tool.run(args, ctx);
  const evaluated = await run({ action: "evaluate", expression: "document.cookie" });
  assert.equal(evaluated.ok, false);
  assert.match(evaluated.output, /no evaluate action/);
  const sneaky = await run({ action: "read", javascript: "1" });
  assert.equal(sneaky.ok, false);

  const file = await run({ action: "open", url: "file:///etc/passwd" });
  assert.equal(file.ok, false);
  assert.match(file.output, /file:/);
  const gateway = await run({ action: "open", url: "http://127.0.0.1:1/devices" });
  assert.equal(gateway.ok, false);
  assert.match(gateway.output, /gateway/);

  const opened = await run({ action: "open", url: "http://127.0.0.1:9/shop" });
  assert.equal(opened.ok, true);
  assert.match(opened.output, /t1/);

  const read = await run({ action: "read" });
  assert.equal(read.ok, true);
  assert.match(read.output, /UNTRUSTED/);
  assert.doesNotMatch(read.output, /session=abc|supersecret|should-not-leak|424242/);
  assert.match(read.output, /\[redacted storage\]/);
  const refs = (read.meta as { refs: { ref: string; name: string; secret: boolean; kind: string }[] }).refs;
  assert.equal(refs[0].ref, "e1");
  assert.equal(refs[1].secret, true);
  assert.equal(refs[2].secret, true);
  assert.equal(refs[3].kind, "purchase");
  assert.equal(tool.classFor?.({ action: "click", ref: "e4" }), "irreversible");
  assert.equal(tool.classFor?.({ action: "click", x: 20, y: 180 }), "irreversible");
  assert.equal(tool.classFor?.({ action: "read" }), "read");
  assert.equal(tool.classFor?.({ action: "type", ref: "e1" }), "write");

  const typed = await run({ action: "type", ref: "e1", text: "hello from daebot" });
  assert.equal(typed.ok, true);
  assert.ok(f.calls.some((c) => c.op === "cdp" && c.args.method === "Input.insertText"));

  const password = await run({ action: "type", ref: "e2", text: "should-not-echo" });
  assert.equal(password.ok, false);
  assert.equal(password.output, PASSWORD_REFUSAL);
  assert.doesNotMatch(password.output, /should-not-echo/);
  assert.match(f.notice()?.text ?? "", /password/);
  const card = await run({ action: "type", ref: "e3", text: "4111" });
  assert.equal(card.ok, false);
  assert.doesNotMatch(card.output, /4111/);

  const shot = await run({ action: "screenshot" });
  assert.equal(shot.ok, true);
  assert.match(shot.images?.[0] ?? "", /^data:image\/jpeg;base64,/);

  const keyed = await run({ action: "key", key: "Enter" });
  assert.equal(keyed.ok, true);
  const scrolled = await run({ action: "scroll", direction: "down", amount: 100 });
  assert.equal(scrolled.ok, true);
  const waited = await run({ action: "wait", text: "signed in", timeout: 1000 });
  assert.equal(waited.ok, true);
  const tabs = await run({ action: "tabs" });
  assert.match(tabs.output, /Daebot has control/);
  const nav = await run({ action: "navigate", to: "reload" });
  assert.equal(nav.ok, true);

  f.setControl("user");
  const paused = await run({ action: "click", ref: "e1" });
  assert.equal(paused.ok, false);
  assert.equal(paused.output, USER_HAS_CONTROL);
  const listed = await run({ action: "tabs" });
  assert.match(listed.output, /user has control/);
  const closed = await run({ action: "close" });
  assert.equal(closed.ok, false);
  resetBrowserLive();
});

test("danger gate holds a purchase, and a domain permission card can allow that site", async () => {
  resetBrowserLive();
  setBrowserLive({
    url: "http://127.0.0.1:9/shop",
    tabId: "t1",
    elements: [{ ref: "e1", tag: "button", type: "submit", role: "button", name: "Place order", text: "Place order", id: "", autocomplete: "", aria: "", placeholder: "", label: "Place order", x: 10, y: 170, w: 120, h: 32, secret: false }],
  });
  const f = fake();
  const tool = createBrowserTool(f.host);
  const args = { action: "click", ref: "e1", url: "https://evil.example/phish" };
  assert.equal(tool.classFor?.(args), "irreversible");
  const facts = factsOf("browser", "irreversible", args, "/tmp");
  assert.equal(facts.host, "127.0.0.1");
  assert.match(facts.url ?? "", /^http:\/\/127\.0\.0\.1:9\/shop/);
  assert.deepEqual(allowKindsFor("irreversible", "browser"), ["exact", "domain"]);
  assert.deepEqual(allowKindsFor("irreversible", "bash"), ["exact"]);
  const described = describeCall(facts, args);
  assert.equal(described.title, "Click in Daebot's browser");
  assert.notEqual(described.title, "Open a web page");

  const state: TurnState = {
    sessionId: "s", booted: true, turnIndex: 1, userMessage: "buy", userMessageIndex: 1,
    calls: [], allCalls: [], confirmations: [], shadow: false,
  };
  const held = dangerGate.preTool!(state, { id: "c1", name: "browser", args }, tool);
  assert.equal(held?.action, "needs-confirmation");
  assert.match(held?.reason ?? "", /explicit go/);
  state.userMessageIndex = 2;
  grantIfAffirmed(state, "do it");
  assert.equal(dangerGate.preTool!(state, { id: "c2", name: "browser", args }, tool), undefined);

  const dir = mkdtempSync(join(tmpdir(), "mc-browser-perm-"));
  const perms = new PermissionService({ dir, owner: "local" });
  const again = factsOf("browser", "irreversible", args, "/tmp");
  const req = perms.open({ sessionId: "s", facts: again, args });
  const domain = req.event.allowOptions.find((o) => /127\.0\.0\.1/.test(o.label));
  assert.ok(domain, "the card offers this site");
  const decided = perms.decide(req.id, { decision: "allow", remember: "always", scope: domain.id });
  assert.equal(decided.ok, true);
  assert.equal(perms.evaluate(again).effect, "allow");
  resetBrowserLive();
});

test("public tier drops browser, staff may read, hosted and remote sessions do not offer it", () => {
  resetBrowserLive();
  const tool = createBrowserTool(fake().host);
  assert.equal(tierAllows("public", tool, { action: "read" }), false);
  assert.equal(tierAllows("staff", tool, { action: "read" }), true);
  setBrowserLive({
    url: "http://127.0.0.1:9/",
    elements: [{ ref: "e1", tag: "button", type: "submit", role: "button", name: "Place order", text: "Place order", id: "", autocomplete: "", aria: "", placeholder: "", label: "", x: 0, y: 0, w: 10, h: 10, secret: false }],
  });
  assert.equal(tierAllows("staff", tool, { action: "click", ref: "e1" }), false);
  assert.equal(hostedToolAllowed("browser"), false);
  const names = filterHostedTools(createBuiltinTools()).map((t) => t.spec.name);
  assert.equal(names.includes("browser"), false);
  assert.deepEqual(names, ["web_fetch", "apple_calendar"]);
  const dropped = botSessionTools(createBuiltinTools(), { localTools: false }).map((t) => t.spec.name);
  assert.equal(dropped.includes("browser"), false);
  const kept = botSessionTools(createBuiltinTools(), { localTools: true }).map((t) => t.spec.name);
  assert.equal(kept.includes("browser"), true);
  assert.match(browserSupport(false).note, /cannot browse/);
  assert.equal(browserSupport(true).available, true);
  assert.equal(browserSupport(true).partition, "persist:daebot-browser");
  resetBrowserLive();
});

test("dev shots route blocks a purchase before it runs and is 404 unless enabled", async () => {
  resetBrowserLive();
  setBrowserLive({
    url: "http://127.0.0.1:9/shop",
    elements: [{ ref: "e1", tag: "button", type: "submit", role: "button", name: "Place order", text: "Place order", id: "", autocomplete: "", aria: "", placeholder: "", label: "", x: 0, y: 0, w: 40, h: 20, secret: false }],
  });
  const home = mkdtempSync(join(tmpdir(), "mc-browser-shots-"));
  const bridge = createBrowserBridge();
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir, tokenPath: join(home, "tok"), browser: bridge, browserShots: true });
  try {
    assert.equal((await http(gw.url, "POST", "/browser/shots", { body: { action: "click", ref: "e1" } })).status, 401);
    const blocked = await http(gw.url, "POST", "/browser/shots", { headers: auth(gw.token), body: { action: "click", ref: "e1" } });
    assert.equal(blocked.status, 200);
    const body = JSON.parse(blocked.body);
    assert.equal(body.blocked, true);
    assert.equal(body.class, "irreversible");
    assert.match(body.reason, /explicit go/);
    assert.match(bridge.snapshot().notice?.text ?? "", /Place order needs your go/);
    assert.equal(bridge.snapshot().notice?.kind, "approval");
  } finally { await gw.close(); resetBrowserLive(); }

  const plain = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir, tokenPath: join(home, "tok2") });
  try {
    const hidden = await http(plain.url, "POST", "/browser/shots", { headers: auth(plain.token), body: { action: "tabs" } });
    assert.equal(hidden.status, 404);
  } finally { await plain.close(); }
});
